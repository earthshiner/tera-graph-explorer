"""========================

Pull graph data from a Teradata database and render it as an
interactive, GPU-accelerated graph using the cosmos.gl engine, themed with
official Teradata brand colours and the embedded "t." symbol logo.

Two modes:

  static  — produces a self-contained HTML file (no server). Either fetches
            the full graph or, if --seed-id/--seed-label is given, a BFS
            subgraph at depth --max-depth (default 2, capped at 6).

  serve   — runs a small HTTP server. Same visualisation, plus the right-
            side "Subgraph (BFS)" panel can re-query the database for a
            different seed/depth without restarting Python.

Install:
    pip install teradatasql

Run (static, full graph):
    export TD_HOST=your-td-host.example.com
    export TD_USER=your_user
    export TD_PASSWORD=your_password
    export TD_DATABASE=Playpen
    python teradata_cosmos_graph.py

Run (static, BFS subgraph from a specific node):
    python teradata_cosmos_graph.py --database Playpen --seed-id 12345 --max-depth 2

Run (server mode — recommended for large graphs):
    python teradata_cosmos_graph.py serve
"""

from __future__ import annotations

import argparse
import json
import os
import re
import sys
import webbrowser
from pathlib import Path

try:
    import teradatasql
except ImportError:
    sys.exit("Missing dependency. Install with:  pip install teradatasql")


DEFAULT_DATABASE = "Playpen"
_IDENTIFIER_RE = re.compile(r"^[A-Za-z_][A-Za-z0-9_$#]*$")
FILTER_COLUMNS = {
    "community": "community",
    "category": "category",
    "role": "node_role",
}


def qualify_table(database: str, table: str) -> str:
    """Return a validated fully qualified table name for dynamic SQL."""
    if not _IDENTIFIER_RE.fullmatch(database):
        raise ValueError(
            "database must be an unquoted Teradata identifier "
            "using letters, numbers, _, $, or #"
        )
    return f"{database}.{table}"


def filter_column(filter_key: str | None) -> str | None:
    """Return a validated graph_nodes column for an optional BFS filter."""
    if not filter_key:
        return None
    try:
        return FILTER_COLUMNS[filter_key]
    except KeyError as exc:
        raise ValueError("filter_key must be one of: community, category, role") from exc


def fetch_full_graph(conn, database: str) -> dict:
    """Pull every node and edge from the configured graph database."""
    node_table = qualify_table(database, "graph_nodes")
    edge_table = qualify_table(database, "graph_edges")
    with conn.cursor() as cur:
        cur.execute(
            "SELECT node_id, node_label, category, community, importance, node_role "
            f"FROM {node_table}"
        )
        nodes = _read_nodes(cur)
        cur.execute(
            "SELECT source_id, target_id, edge_weight, edge_type, strength "
            f"FROM {edge_table}"
        )
        links = _read_edges(cur)
    out = _validate(nodes, links)
    out["_database"] = database
    return out


def fetch_bfs_subgraph(conn, database: str, seed_id: int, max_depth: int,
                       filter_key: str | None = None,
                       filter_value: str | None = None) -> dict:
    """Recursive-CTE BFS from seed_id, capped at max_depth hops.

    Strategy:
      1. Recursive CTE walks neighbours through graph_edges, tracking depth.
         The recursive part traverses both directions of each edge so
         undirected reachability is captured.
      2. The DISTINCT result gives us the set of visited node IDs.
      3. Two follow-up queries pull full attribute rows for those nodes
         and the edges where BOTH endpoints lie inside the visited set.

    Why three queries instead of one big join: Teradata recursive CTEs
    can't easily project all node attributes during recursion (the
    column type signature must match between anchor and recursive parts),
    and keeping the recursion lean lets the planner do a clean nested
    join. Spilling the IDs through an IN-list works for subgraphs up to
    a few thousand nodes — beyond that, a volatile table is preferable.
    """
    if max_depth < 1 or max_depth > 6:
        raise ValueError("max_depth must be between 1 and 6")

    node_table = qualify_table(database, "graph_nodes")
    edge_table = qualify_table(database, "graph_edges")
    filter_col = filter_column(filter_key)

    bfs_sql = (
        "WITH RECURSIVE bfs (node_id, depth) AS (\n"
        "    SELECT node_id, 0\n"
        f"    FROM {node_table}\n"
        f"    WHERE node_id = {int(seed_id)}\n"
        "    UNION ALL\n"
        "    SELECT\n"
        "        CASE WHEN e.source_id = b.node_id\n"
        "             THEN e.target_id\n"
        "             ELSE e.source_id\n"
        "        END,\n"
        "        b.depth + 1\n"
        "    FROM bfs b\n"
        f"    JOIN {edge_table} e\n"
        "      ON e.source_id = b.node_id OR e.target_id = b.node_id\n"
        f"    WHERE b.depth < {int(max_depth)}\n"
        ")\n"
        "SELECT DISTINCT node_id FROM bfs"
    )

    with conn.cursor() as cur:
        cur.execute(bfs_sql)
        visited_ids = {int(r[0]) for r in cur.fetchall()}

        if not visited_ids:
            return {
                "nodes": [], "links": [],
                "_seed_id": seed_id, "_max_depth": max_depth,
                "_total_nodes": 0, "_total_edges": 0,
                "_database": database,
                "_filter_key": filter_key, "_filter_value": filter_value,
            }

        ids_csv = ",".join(str(i) for i in visited_ids)

        node_sql = (
            "SELECT node_id, node_label, category, community, "
            "       importance, node_role "
            f"FROM {node_table} WHERE node_id IN ({ids_csv})"
        )
        node_params = ()
        if filter_col and filter_value is not None:
            node_sql += f" AND {filter_col} = ?"
            node_params = (filter_value,)
        cur.execute(node_sql, node_params)
        nodes = _read_nodes(cur)

        filtered_ids = [n["id"] for n in nodes]
        if not filtered_ids:
            links = []
        else:
            filtered_ids_csv = ",".join(str(i) for i in filtered_ids)
            cur.execute(
                "SELECT source_id, target_id, edge_weight, edge_type, strength "
                f"FROM {edge_table} "
                f"WHERE source_id IN ({filtered_ids_csv}) "
                f"AND target_id IN ({filtered_ids_csv})"
            )
            links = _read_edges(cur)

        cur.execute(f"SELECT COUNT(*) FROM {node_table}")
        total_nodes = int(cur.fetchone()[0])
        cur.execute(f"SELECT COUNT(*) FROM {edge_table}")
        total_edges = int(cur.fetchone()[0])

    out = _validate(nodes, links)
    out["_seed_id"]     = seed_id
    out["_max_depth"]   = max_depth
    out["_total_nodes"] = total_nodes
    out["_total_edges"] = total_edges
    out["_database"] = database
    out["_filter_key"] = filter_key
    out["_filter_value"] = filter_value
    return out


def resolve_seed_label(conn, database: str, label: str) -> "int | None":
    """Look up a node_id by exact-match node_label (first hit wins)."""
    node_table = qualify_table(database, "graph_nodes")
    with conn.cursor() as cur:
        cur.execute(
            "SELECT node_id "
            f"FROM {node_table} "
            "WHERE node_label = ? "
            "QUALIFY ROW_NUMBER() OVER (ORDER BY node_id) = 1",
            (label,),
        )
        row = cur.fetchone()
        return int(row[0]) if row else None


def _read_nodes(cur) -> list:
    return [
        {
            "id":         int(r[0]),
            "label":      r[1],
            "category":   r[2],
            "community":  r[3],
            "importance": float(r[4]) if r[4] is not None else 0.5,
            "role":       r[5],
        }
        for r in cur.fetchall()
    ]


def _read_edges(cur) -> list:
    return [
        {
            "source":   int(r[0]),
            "target":   int(r[1]),
            "weight":   float(r[2]) if r[2] is not None else 0.5,
            "type":     r[3],
            "strength": r[4],
        }
        for r in cur.fetchall()
    ]


def _validate(nodes: list, links: list) -> dict:
    """Drop any edges whose endpoints didn't survive the node fetch."""
    valid = {n["id"] for n in nodes}
    links = [e for e in links if e["source"] in valid and e["target"] in valid]
    return {"nodes": nodes, "links": links}


# Teradata "t." symbol logo, base64-encoded official asset
TERADATA_LOGO_URI = (
    "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAEAAAABVCAMAAADOrBLEAAAAIGNIUk0AAHomAACAhAAA+gAAAIDoAAB1MAAA6mAAADqYAAAXcJy6UTwAAAGbUExURf9fAgAAAP9fAv9fAv9fAv9fAv9fAv9fAv9fAv9fAv9fAv9fAv9fAv9fAv9fAv9fAv9fAv9fAv9fAv9fAv9fAv9fAv9fAv9fAv9fAv9fAv9fAv9fAv9fAv9fAv9fAv9fAv9fAv9fAv9fAv9fAv9fAv9fAv9fAv9fAv9fAv9fAv9fAv9fAv9fAv9fAv9fAv9fAv9fAv9fAv9fAv9fAv9fAv9fAv9fAv9fAv9fAv9fAv9fAv9fAv9fAv9fAv9fAv9fAv9fAv9fAv9fAv9fAv9fAv9fAv9fAv9fAv9fAv9fAv9fAv9fAv9fAv9fAv9fAv9fAv9fAv9fAv9fAv9fAv9fAv9fAv9fAv9fAv9fAv9fAv9fAv9fAv9fAv9fAv9fAv9fAv9fAv9fAv9fAv9fAv9fAv9fAv9fAv9fAv9fAv9fAv9fAv9fAv9fAv9fAv9fAv9fAv9fAv9fAv9fAv9fAv9fAv9fAv9fAv9fAv9fAv9fAv9fAv9fAv9fAv9fAv9fAv9fAv9fAv9fAv9fAv9fAv9fAv9fAv9fAv9fAv///3jJeXQAAACHdFJOUwAA4/Lx9HV8gggMBOHDxL0090PNnJ6YKgGB7pTktAfU3SD8YJ3GGf4QSfOtNgYDHk50g39kIdnqrlFBPT48I4na+u+4Uqr79vXtQNKTFGegDyfRd4jeMDkd2JBL+M4ib+nwUwJK0CbimQXoLna8ax8KK1iGyutCwS0sOkRMTRXnjBwW5ciKNyCa7VMAAAABYktHRIhrZhZaAAAACXBIWXMAAC4jAAAuIwF4pT92AAAAB3RJTUUH6gIDDSMcsQ7WtwAAAeNJREFUWMPt1tlbElEYBvCXMEhGssVwynIBCxBEMXQKynBDMAoqSElt0bKgXFpt07LM+bcdRpiGc0jOuaini/Nezjfze76zAo5Ym2py1AYLT9CkErELQAAC+E+AY80OOhLYgRYnleOtJziAejl5SgACEMC/B063naHiaucA7JDrhAuw8EQAAhCAAAQggL8MnAWXgHMk0MEJnCeBC518QBcJdPfwAa0k4PZwjQG9JKBevMQF2Lwk4HX5OHqAv49qwR0I9v+ZQGhgMDx0ORJ06O9geESlo1wJX43Grhm57qt6wOiN+Fi5z/GJyWbtKfqn1LpJTCd/JzVTASD7bxqvJNO3oOW22jjVv3mA37xvvJmsBtxp4QBG79bO1j0ZCLmYAcg5opC/r7UwqzADcwWykoO2LA+YgfkFsrJYXoiHi2wA8IiqWKFP7WNGwE5VvHpBjjxhA8JUZfpgbFJEYQAsWEqQlUJlfZefPmMBVp6TlRcwtnhHqjEgkYdfiRqHDsVYptQIQJC4AdNF06lF8eWr1ZL7EECb7rWk+blzvfbYAxuv37wNvMu/71sYS5hi/VAdaqfNtGCbH0HfG5Cl7MCnz1++bpkyv23cB9Kgs7Idv33f0T7n+xnSu/zhCcSVn7u/9vTx7wNeLG/Yd2GbHAAAAABJRU5ErkJggg=="
)


HTML_TEMPLATE = r"""<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>__DATABASE__ · Teradata Graph Explorer</title>
<link rel="preconnect" href="https://fonts.googleapis.com">
<link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>
<link rel="stylesheet"
      href="https://fonts.googleapis.com/css2?family=Inter:wght@300;400;500;600;700&display=swap">
<style>
  :root {
    --td-orange: #FF5F02;
    --td-orange-soft: rgba(255, 95, 2, 0.15);
    --td-navy: #00233C;
    --td-navy-light: #0d3654;
    --td-navy-lighter: #154868;
    --td-white: #FFFFFF;
    --bg: #00233C;
    --panel: rgba(13, 54, 84, 0.92);
    --panel-solid: #0d3654;
    --border: #1f5478;
    --border-light: #154868;
    --text: #ffffff;
    --text-dim: rgba(255, 255, 255, 0.65);
    --muted: rgba(255, 255, 255, 0.5);
    --accent: #FF5F02;
  }
  html, body { margin: 0; padding: 0; height: 100%; background: var(--bg);
               color: var(--text);
               font-family: 'Inter', -apple-system, BlinkMacSystemFont,
                            'Segoe UI', system-ui, sans-serif;
               font-size: 13px; line-height: 1.4; font-weight: 400;
               overflow: hidden; }

  #graph { position: absolute; top: 0; left: 0; right: 320px; bottom: 0; }
  #graph canvas { display: block; }

  /* label overlay (DOM, on top of canvas) */
  #labels { position: absolute; top: 0; left: 0; right: 320px; bottom: 0;
            pointer-events: none; overflow: hidden; z-index: 5; }
  .label-node {
    position: absolute; left: 0; top: 0;
    color: #ffffff; font-size: 11px; font-weight: 600;
    white-space: nowrap; pointer-events: none; display: none;
    text-shadow: 0 0 3px var(--td-navy), 0 0 3px var(--td-navy),
                 0 0 6px var(--td-navy);
    will-change: transform;
  }
  .label-edge {
    position: absolute; left: 0; top: 0;
    color: rgba(255, 255, 255, 0.65); font-size: 10px; font-weight: 400;
    font-style: italic; white-space: nowrap; pointer-events: none;
    display: none;
    text-shadow: 0 0 3px var(--td-navy);
    will-change: transform;
  }

  .panel { background: var(--panel); border: 1px solid var(--border);
           border-radius: 8px; -webkit-backdrop-filter: blur(10px);
           backdrop-filter: blur(10px); }

  #info  { position: absolute; top: 16px; left: 16px; max-width: 300px;
           padding: 14px 16px; z-index: 10; display: flex; gap: 12px;
           align-items: flex-start; }
  #info img { width: 32px; height: 42px; flex-shrink: 0; margin-top: 2px; }
  #info .text h1 { margin: 0 0 2px 0; font-size: 14px; font-weight: 600;
                   letter-spacing: 0.2px; color: var(--td-white); }
  #info .text .stats { color: var(--text-dim); margin-bottom: 8px; font-size: 12px; }
  #info .text .hint { color: var(--muted); font-size: 11px; margin-top: 8px;
                      border-top: 1px solid var(--border); padding-top: 8px; }

  #legend { position: absolute; bottom: 16px; left: 16px;
            padding: 12px 14px; z-index: 10; min-width: 140px; }
  #legend h2 { margin: 0 0 8px 0; font-size: 10px; font-weight: 600;
               color: var(--td-orange); text-transform: uppercase;
               letter-spacing: 0.8px; }
  #legend .row { display: flex; align-items: center; gap: 8px; margin: 4px 0;
                 font-size: 12px; }
  #legend .swatch { width: 10px; height: 10px; border-radius: 50%;
                    flex-shrink: 0; }

  #controls { position: absolute; top: 0; right: 0; bottom: 0; width: 320px;
              background: var(--panel-solid); border-left: 1px solid var(--border);
              padding: 16px 18px; overflow-y: auto; z-index: 10;
              box-shadow: -4px 0 20px rgba(0, 0, 0, 0.4); }
  #controls section { padding-bottom: 16px; margin-bottom: 16px;
                      border-bottom: 1px solid var(--border-light); }
  #controls section:last-child { border-bottom: none; margin-bottom: 0; }
  #controls h2 { margin: 0 0 12px 0; font-size: 10px; font-weight: 600;
                 color: var(--td-orange); text-transform: uppercase;
                 letter-spacing: 0.8px; }

  #search-input { width: 100%; box-sizing: border-box;
                  background: var(--td-navy); color: var(--text);
                  border: 1px solid var(--border); border-radius: 6px;
                  padding: 8px 10px; font-family: inherit; font-size: 13px;
                  outline: none; transition: border-color 0.15s; }
  #search-input:focus { border-color: var(--td-orange); }
  #search-input::placeholder { color: var(--muted); }
  #search-results { margin-top: 8px; max-height: 200px; overflow-y: auto; }
  #search-results .item { padding: 6px 10px; cursor: pointer;
                          border-radius: 5px; font-size: 12px;
                          display: flex; justify-content: space-between;
                          gap: 10px; transition: background 0.1s; }
  #search-results .item:hover { background: var(--td-orange-soft); }
  #search-results .item .label { font-weight: 500; }
  #search-results .item .meta { color: var(--text-dim); font-size: 11px; }
  #search-status { font-size: 11px; color: var(--muted); margin-top: 6px; }

  .btn-row { display: flex; gap: 6px; margin-bottom: 8px; }
  .btn-row button { flex: 1; background: var(--td-navy); border: 1px solid var(--border);
                    color: var(--text); border-radius: 6px;
                    padding: 8px 10px; cursor: pointer; font-size: 12px;
                    font-family: inherit; font-weight: 500;
                    transition: all 0.15s; }
  .btn-row button:hover { background: var(--td-navy-lighter);
                          border-color: var(--td-orange); }
  .btn-row button:active { transform: translateY(1px); }
  .btn-row button.primary { background: var(--td-orange);
                            border-color: var(--td-orange);
                            color: var(--td-white); }
  .btn-row button.primary:hover { background: #e35402; border-color: #e35402; }

  .field { margin-bottom: 11px; }
  .field-head { display: flex; justify-content: space-between; align-items: center;
                margin-bottom: 5px; font-size: 12px; }
  .field-head label { color: var(--text); font-weight: 500; }
  .field-head .val { color: var(--td-orange);
                     font-variant-numeric: tabular-nums;
                     font-size: 11px; font-weight: 600; }
  input[type="range"] { -webkit-appearance: none; appearance: none;
                        width: 100%; height: 4px; background: var(--border-light);
                        border-radius: 2px; outline: none; margin: 0; }
  input[type="range"]::-webkit-slider-thumb {
    -webkit-appearance: none; appearance: none;
    width: 14px; height: 14px; background: var(--td-orange);
    border-radius: 50%; cursor: pointer;
    border: 2px solid var(--panel-solid);
    box-shadow: 0 0 0 1px var(--td-orange); }
  input[type="range"]::-moz-range-thumb {
    width: 14px; height: 14px; background: var(--td-orange);
    border-radius: 50%; cursor: pointer;
    border: 2px solid var(--panel-solid); }

  .row-h { display: flex; align-items: center; justify-content: space-between;
           gap: 10px; margin-bottom: 11px; font-size: 12px; }
  .row-h label { color: var(--text); font-weight: 500; }
  select { background: var(--td-navy); color: var(--text);
           border: 1px solid var(--border); border-radius: 5px;
           padding: 6px 8px; font-size: 12px;
           font-family: inherit; cursor: pointer; }
  select:focus { outline: none; border-color: var(--td-orange); }

  .checks { display: flex; flex-wrap: wrap; gap: 14px;
            margin-bottom: 11px; font-size: 12px; }
  .checks label { display: flex; align-items: center; gap: 6px; cursor: pointer;
                  color: var(--text); font-weight: 500; }
  .checks input[type="checkbox"] { accent-color: var(--td-orange); cursor: pointer; }

  #tooltip { position: fixed; background: var(--td-navy);
             border: 1px solid var(--td-orange);
             border-radius: 6px; padding: 9px 11px;
             font-size: 12px; pointer-events: none;
             display: none; z-index: 50; max-width: 250px;
             box-shadow: 0 4px 20px rgba(0, 0, 0, 0.5); }
  #tooltip .name { font-weight: 600; margin-bottom: 5px; font-size: 13px; }
  #tooltip .row { display: flex; justify-content: space-between;
                  gap: 12px; color: var(--text-dim); margin: 1px 0; }
  #tooltip .row span:last-child { color: var(--text); font-weight: 500; }
  #context-menu { position: fixed; display: none; min-width: 230px;
                  background: var(--td-navy); border: 1px solid var(--td-orange);
                  border-radius: 6px; padding: 6px; z-index: 80;
                  box-shadow: 0 8px 28px rgba(0,0,0,0.48); }
  #context-menu .title { padding: 6px 8px 8px 8px; color: var(--text-dim);
                         font-size: 11px; border-bottom: 1px solid var(--border);
                         margin-bottom: 4px; }
  #context-menu .field { padding: 6px 8px 4px 8px; }
  #context-menu label { display: block; color: var(--text-dim); font-size: 10px;
                        text-transform: uppercase; letter-spacing: 0.04em;
                        margin-bottom: 4px; }
  #context-menu select { width: 100%; background: var(--td-blue-deep);
                         border: 1px solid var(--border-light);
                         border-radius: 4px; color: var(--text);
                         padding: 6px 7px; font: inherit; font-size: 12px; }
  #context-menu select option { background: #ffffff; color: #1f2933; }
  #context-menu select option:checked { background: #d9e8f5; color: #00233c; }
  #context-menu button { display: block; width: calc(100% - 16px);
                         margin: 8px; text-align: center;
                         background: var(--td-orange); border: 0; color: #fff;
                         padding: 7px 8px; border-radius: 4px; cursor: pointer;
                         font: inherit; font-size: 12px; font-weight: 700; }
  #context-menu button:hover { background: #e65300; }

  #error { position: absolute; top: 50%; left: 50%;
           transform: translate(-50%, -50%);
           padding: 16px 20px; background: #2a1a1a; border: 1px solid #5a2a2a;
           border-radius: 8px; color: #ffb4b4; font-family: monospace;
           max-width: 600px; display: none; z-index: 100; }
  #notice { position: absolute; top: 14px; left: 332px; right: 336px;
            display: none; align-items: center; justify-content: space-between;
            gap: 12px; padding: 8px 10px; background: rgba(16, 45, 66, 0.92);
            border: 1px solid var(--border); border-radius: 6px;
            color: #d7ecff; font-family: monospace; font-size: 11px;
            line-height: 1.3; z-index: 30; box-shadow: 0 4px 16px rgba(0,0,0,0.28); }
  #notice button { flex: 0 0 auto; width: 22px; height: 22px; border-radius: 4px;
                   border: 1px solid var(--border); background: var(--td-navy);
                   color: var(--text); cursor: pointer; line-height: 18px; padding: 0; }

  *::-webkit-scrollbar { width: 8px; height: 8px; }
  *::-webkit-scrollbar-track { background: transparent; }
  *::-webkit-scrollbar-thumb { background: var(--border-light); border-radius: 4px; }
  #bfs-status { font-size: 11px; color: var(--text-dim);
                display: flex; justify-content: space-between; gap: 6px;
                padding: 6px 8px; background: var(--td-navy);
                border-radius: 5px; }
  #bfs-status #bfs-mode { color: var(--td-orange); font-weight: 600;
                          text-transform: uppercase; letter-spacing: 0.5px; }
  #bfs-status #bfs-stats { color: var(--text); font-variant-numeric: tabular-nums; }
  #bfs-breadcrumb { display: flex; flex-wrap: wrap; align-items: center; gap: 5px;
                    margin-top: 8px; padding: 6px 8px; background: rgba(0, 35, 60, 0.55);
                    border: 1px solid var(--border-light); border-radius: 5px;
                    font-size: 11px; line-height: 1.4; }
  #bfs-breadcrumb a { color: var(--text-dim); text-decoration: none; cursor: pointer; }
  #bfs-breadcrumb a:hover { color: var(--td-orange); }
  #bfs-breadcrumb .sep { color: var(--muted); }
  #bfs-breadcrumb .current { color: var(--td-orange); font-weight: 600; }
  #bfs-error { font-size: 11px; color: #ffb4b4; margin-top: 6px;
               min-height: 14px; }

  #empty-state { position: absolute; top: 50%; left: calc(50% - 160px);
                 transform: translate(-50%, -50%);
                 padding: 32px 36px; max-width: 440px;
                 background: var(--panel); border: 1px solid var(--td-orange);
                 border-radius: 12px; z-index: 20; text-align: center;
                 box-shadow: 0 8px 32px rgba(0, 0, 0, 0.4); }
  #empty-state .empty-icon {
    font-size: 36px; color: var(--td-orange); margin-bottom: 8px;
    transform: rotate(90deg); display: inline-block; }
  #empty-state h2 { margin: 0 0 12px 0; font-size: 18px; font-weight: 600;
                    color: var(--td-white); letter-spacing: 0.3px; }
  #empty-state p { margin: 0 0 12px 0; font-size: 13px; line-height: 1.5;
                   color: var(--text-dim); }
  #empty-state p:last-child { margin-bottom: 0; }
  #empty-state code { background: var(--td-navy); color: var(--td-orange);
                      padding: 1px 6px; border-radius: 3px; font-size: 12px;
                      font-family: monospace; }
  #empty-state strong { color: var(--td-white); }

  *::-webkit-scrollbar-thumb:hover { background: var(--border); }
</style>
</head>
<body>

<div id="graph"></div>
<div id="labels"></div>

<div id="empty-state" class="panel" style="display: none;">
  <div class="empty-icon">→</div>
  <h2>Awaiting input</h2>
  <p>Select a depth in the panel on the right, then click any node to drill into its relationship neighbourhood.</p>
  <p>Or click <strong>Full graph</strong> to load every node and edge in <code>__DATABASE__</code> (slow at 100k+).</p>
</div>

<div id="info" class="panel">
  <img src="__LOGO_URI__" alt="Teradata">
  <div class="text">
    <h1>__DATABASE__</h1>
    <div class="stats" id="stats">loading…</div>
    <div class="hint">Drag · Scroll to zoom · Hover nodes/edges for details · Right-click a node to drill-down</div>
  </div>
</div>

<div id="legend" class="panel">
  <h2 id="legend-heading">Communities</h2>
  <div id="legend-rows"></div>
</div>

<aside id="controls">

  <section>
    <h2>Subgraph (BFS)</h2>
    <div id="bfs-status">
      <span id="bfs-mode">full graph</span>
      <span id="bfs-stats"></span>
    </div>
    <div id="bfs-breadcrumb"></div>
    <div class="row-h" style="margin-top: 10px;">
      <label for="bfs-seed">Seed</label>
      <input id="bfs-seed" type="text" placeholder="Node label or #id"
             autocomplete="off" style="flex: 1; min-width: 0; background: var(--td-navy);
             color: var(--text); border: 1px solid var(--border); border-radius: 5px;
             padding: 5px 8px; font-size: 12px; font-family: inherit;">
    </div>
    <div class="field">
      <div class="field-head"><label for="bfs-depth">Max depth</label>
                              <span class="val" id="v-bfs-depth">2</span></div>
      <input id="bfs-depth" type="range" min="1" max="6" step="1" value="2">
    </div>
    <div class="btn-row">
      <button id="btn-bfs-run" class="primary">Open seed</button>
      <button id="btn-bfs-reset">Full graph</button>
    </div>
    <div id="bfs-error"></div>
  </section>

  <section>
    <h2>Search</h2>
    <input id="search-input" type="text" placeholder="Search by label…" autocomplete="off">
    <div id="search-results"></div>
    <div id="search-status"></div>
  </section>

  <section>
    <h2>Simulation</h2>
    <div class="btn-row">
      <button id="btn-fit">Fit view</button>
      <button id="btn-pause">Pause</button>
    </div>
    <div class="btn-row">
      <button id="btn-restart">Restart</button>
      <button id="btn-reset" class="primary">Reset layout</button>
    </div>
    <div class="field">
      <div class="field-head"><label for="s-gravity">Gravity</label>
                              <span class="val" id="v-gravity">0.25</span></div>
      <input id="s-gravity" type="range" min="0" max="1" step="0.05" value="0.25">
    </div>
    <div class="field">
      <div class="field-head"><label for="s-repulsion">Repulsion</label>
                              <span class="val" id="v-repulsion">1.00</span></div>
      <input id="s-repulsion" type="range" min="0" max="2" step="0.05" value="1">
    </div>
    <div class="field">
      <div class="field-head"><label for="s-linkSpring">Link spring</label>
                              <span class="val" id="v-linkSpring">1.00</span></div>
      <input id="s-linkSpring" type="range" min="0" max="2" step="0.05" value="1">
    </div>
    <div class="field">
      <div class="field-head"><label for="s-linkDistance">Link distance</label>
                              <span class="val" id="v-linkDistance">10</span></div>
      <input id="s-linkDistance" type="range" min="1" max="50" step="1" value="10">
    </div>
    <div class="field">
      <div class="field-head"><label for="s-friction">Friction</label>
                              <span class="val" id="v-friction">0.85</span></div>
      <input id="s-friction" type="range" min="0.5" max="1" step="0.01" value="0.85">
    </div>
  </section>

  <section>
    <h2>Nodes</h2>
    <div class="row-h">
      <label for="sel-colorBy">Colour by</label>
      <select id="sel-colorBy">
        <option value="community">Community</option>
        <option value="category">Category</option>
        <option value="role">Role</option>
      </select>
    </div>
    <div class="checks">
      <label><input id="chk-nodeLabels" type="checkbox"> Show labels</label>
    </div>
    <div class="field">
      <div class="field-head"><label for="s-sizeScale">Size scale</label>
                              <span class="val" id="v-sizeScale">0.30</span></div>
      <input id="s-sizeScale" type="range" min="0.3" max="3" step="0.05" value="0.3">
    </div>
    <div class="field">
      <div class="field-head"><label for="s-nodeOpacity">Opacity</label>
                              <span class="val" id="v-nodeOpacity">1.00</span></div>
      <input id="s-nodeOpacity" type="range" min="0.1" max="1" step="0.05" value="1">
    </div>
  </section>

  <section>
    <h2>Edges</h2>
    <div class="checks">
      <label><input id="chk-curved" type="checkbox" checked> Curved</label>
      <label><input id="chk-arrows" type="checkbox"> Arrows</label>
      <label><input id="chk-edgeLabels" type="checkbox"> Show labels</label>
    </div>
    <div class="field">
      <div class="field-head"><label for="s-widthScale">Width scale</label>
                              <span class="val" id="v-widthScale">1.00</span></div>
      <input id="s-widthScale" type="range" min="0.3" max="3" step="0.05" value="1">
    </div>
    <div class="field">
      <div class="field-head"><label for="s-edgeOpacity">Opacity</label>
                              <span class="val" id="v-edgeOpacity">1.00</span></div>
      <input id="s-edgeOpacity" type="range" min="0" max="1" step="0.05" value="1">
    </div>
  </section>

</aside>

<div id="tooltip"></div>
<div id="context-menu"></div>
<div id="notice"><span id="notice-text"></span><button id="notice-close" title="Dismiss">×</button></div>
<div id="error"></div>

<script type="module">
function showFatalError(message) {
  const e = document.getElementById('error');
  e.style.display = 'block';
  e.textContent = message;
}

const RENDERER_NOTICE_KEY = 'tera-graph-renderer-notice-seen-v1';
let noticeTimer = null;
function showRendererNotice(message) {
  if (sessionStorage.getItem(RENDERER_NOTICE_KEY) === '1') return;
  sessionStorage.setItem(RENDERER_NOTICE_KEY, '1');

  const notice = document.getElementById('notice');
  const noticeText = document.getElementById('notice-text');
  const close = document.getElementById('notice-close');
  noticeText.textContent = message;
  notice.style.display = 'flex';
  close.onclick = () => {
    notice.style.display = 'none';
    if (noticeTimer != null) clearTimeout(noticeTimer);
  };
  if (noticeTimer != null) clearTimeout(noticeTimer);
  noticeTimer = setTimeout(() => {
    notice.style.display = 'none';
    noticeTimer = null;
  }, 6000);
}

function supportsRequiredWebGL() {
  try {
    const canvas = document.createElement('canvas');
    return !!canvas.getContext('webgl2', { failIfMajorPerformanceCaveat: false });
  } catch (_) {
    return false;
  }
}

const HAS_WEBGL = supportsRequiredWebGL();
let Graph = null;
if (HAS_WEBGL) {
  try {
    ({ Graph } = await import('https://cdn.jsdelivr.net/npm/@cosmos.gl/graph@2/+esm'));
  } catch (err) {
    showRendererNotice(
      'Canvas fallback active: cosmos.gl could not be loaded. ' +
      'Right-click a node to drill-down into its subgraph.'
    );
  }
} else {
  showRendererNotice(
    'Canvas fallback active: WebGL2 is unavailable in this browser session. ' +
    'Right-click a node to drill-down into its subgraph.'
  );
}

const data = __DATA__;
const N = data.nodes.length;
const L = data.links.length;
const idIndex = new Map(data.nodes.map((n, i) => [n.id, i]));

// ---- neighborhood index (for selection highlighting) ---- //
const neighborOf  = new Map();   // pointIndex -> Set<neighborPointIndex>
const incidentOf  = new Map();   // pointIndex -> Set<edgeIndex>
const nodeDegrees = new Float32Array(N);
data.nodes.forEach((_, i) => { neighborOf.set(i, new Set()); incidentOf.set(i, new Set()); });
data.links.forEach((e, i) => {
  const s = idIndex.get(e.source), t = idIndex.get(e.target);
  neighborOf.get(s).add(t);
  neighborOf.get(t).add(s);
  incidentOf.get(s).add(i);
  incidentOf.get(t).add(i);
  nodeDegrees[s] += 1;
  nodeDegrees[t] += 1;
});
let maxNodeDegree = 1;
for (let i = 0; i < N; i++) maxNodeDegree = Math.max(maxNodeDegree, nodeDegrees[i]);

// ---- palette ---- //
const PALETTE = [
  '#FF5F02',  // Teradata Orange (primary)
  '#4A90E2',  // brand blue
  '#7ED321',  // brand green
  '#D8BFD8',  // brand lavender
  '#FFD93D',  // warm yellow
  '#22D3EE',  // cyan
  '#F472B6',  // pink
  '#FBBF24',  // amber
];
function buildColorMap(attr) {
  const values = [...new Set(data.nodes.map(n => n[attr]).filter(v => v != null))].sort();
  return { values,
           cmap: Object.fromEntries(values.map((v, i) => [v, PALETTE[i % PALETTE.length]])) };
}
const colorMaps = {
  community: buildColorMap('community'),
  category:  buildColorMap('category'),
  role:      buildColorMap('role'),
};
const hexToRgb = (h) => [
  parseInt(h.slice(1, 3), 16) / 255,
  parseInt(h.slice(3, 5), 16) / 255,
  parseInt(h.slice(5, 7), 16) / 255,
];
const ORANGE_RGB = hexToRgb('#FF5F02');

// ---- application state ---- //
const UI_SETTINGS_KEY = 'tera-graph-ui-settings-v1';
const state = {
  sim:     { gravity: 0.25, repulsion: 1.0, linkSpring: 1.0,
             linkDistance: 10, friction: 0.85, decay: 2000 },
  nodes:   { colorBy: 'community', sizeScale: 0.3, opacity: 1.0 },
  edges:   { curved: true, arrows: false, widthScale: 1.0, opacity: 1.0 },
  search:  { query: '', matches: new Set() },
  focused:     null,                            // selected point index, or null
  hovered:     null,                            // hovered point index (transient)
  focusedEdge: null,                            // selected edge (link) index, or null
  hoveredEdge: null,                            // hovered edge index (transient)
  labels:  { nodes: false, edges: false },
};

function loadUiSettings() {
  try {
    const saved = JSON.parse(sessionStorage.getItem(UI_SETTINGS_KEY) || '{}');
    if (saved.sim)    Object.assign(state.sim, saved.sim);
    if (saved.nodes)  Object.assign(state.nodes, saved.nodes);
    if (saved.edges)  Object.assign(state.edges, saved.edges);
    if (saved.labels) Object.assign(state.labels, saved.labels);
  } catch (_) { /* keep defaults */ }
}

function saveUiSettings() {
  sessionStorage.setItem(UI_SETTINGS_KEY, JSON.stringify({
    sim: state.sim,
    nodes: state.nodes,
    edges: state.edges,
    labels: state.labels,
  }));
}
loadUiSettings();

// ---- typed-array buffers ---- //
const pointPositions = new Float32Array(N * 2);
const pointColors    = new Float32Array(N * 4);
const pointSizes     = new Float32Array(N);
const linksArr       = new Float32Array(L * 2);
const linkColors     = new Float32Array(L * 4);
const linkWidths     = new Float32Array(L);

function stableUnit(seed) {
  let x = Math.sin(seed * 12.9898) * 43758.5453;
  return x - Math.floor(x);
}

function seedPositions() {
  const communities = colorMaps.community.values.length
    ? colorMaps.community.values
    : ['all'];
  const clusterCount = communities.length;
  const clusterIndex = new Map(communities.map((v, i) => [v, i]));
  const centreRadius = Math.max(260, Math.min(1200, 95 * Math.sqrt(clusterCount)));
  const clusterRadius = N > 5000 ? 170 : 115;

  for (let i = 0; i < N; i++) {
    const n = data.nodes[i];
    const ci = clusterIndex.get(n.community) ?? 0;
    const centreAngle = (Math.PI * 2 * ci) / Math.max(1, clusterCount);
    const cx = Math.cos(centreAngle) * centreRadius;
    const cy = Math.sin(centreAngle) * centreRadius;
    const jitterAngle = stableUnit((n.id || i) + 17) * Math.PI * 2;
    const jitterRadius = Math.sqrt(stableUnit((n.id || i) + 53)) * clusterRadius;
    const importancePull = 1 - Math.min(0.85, (n.importance || 0.5) * 0.45);

    pointPositions[i * 2]     = cx + Math.cos(jitterAngle) * jitterRadius * importancePull;
    pointPositions[i * 2 + 1] = cy + Math.sin(jitterAngle) * jitterRadius * importancePull;
  }
}
seedPositions();

// Point sizes are baked once. Blend importance with local degree so hubs
// become visible anchors without adding expensive outlines or DOM labels.
// The size-scale slider still drives the final shader multiplier.
for (let i = 0; i < N; i++) {
  const importance = Math.max(0, Math.min(1, data.nodes[i].importance ?? 0.5));
  const degreeScore = Math.sqrt(nodeDegrees[i] / maxNodeDegree);
  pointSizes[i] = 2.2 + importance * 5.8 + degreeScore * 4.2;     // 2.2..12.2
}

data.links.forEach((e, i) => {
  linksArr[i * 2]     = idIndex.get(e.source);
  linksArr[i * 2 + 1] = idIndex.get(e.target);
});

// ---- highlight key: hover wins over click-focus, both dim non-neighbors ---- //
function highlightKey() {
  return state.hovered != null ? state.hovered : state.focused;
}

// ---- edge highlight key: which edge (if any) is the focal one ---- //
// Hover beats click, same precedence as nodes. When set, the rebuild
// functions take an "edge-focused" path: only this single edge stays
// orange, only its two endpoint nodes stay coloured.
function edgeHighlightKey() {
  return state.hoveredEdge != null ? state.hoveredEdge : state.focusedEdge;
}

// ---- render trigger ---- //
// cosmos.gl v2 couples rendering to the simulation: once the simulation's
// alpha decays to zero the canvas stops repainting, so direct buffer writes
// (setPointColors, setLinkColors, setLinkWidths) become invisible until
// something tells cosmos that the textures need updating.
//
// The documented v2 API for this is graph.render() — explicitly meant
// to be called after updating point/link properties, per the migration
// notes: "After setting data or updating point/link properties, remember
// to run graph.render() to update WebGL textures and render the graph
// with the new data."
function pokeRender() {
  graph.render();
}

// ---- rebuild functions ---- //
//
// Opacity is NOT baked into the per-point alpha here. We use cosmos's
// pointOpacity / linkOpacity uniforms (driven by the sliders via setConfig)
// for the global opacity multiplier. The buffer alpha only carries
// search-dim and focus-dim signals, which compose with the uniform.

function rebuildPointColors() {
  const { cmap } = colorMaps[state.nodes.colorBy];
  const hasSearch = state.search.matches.size > 0;
  const hi = highlightKey();
  const keep = hi != null ? new Set([hi, ...neighborOf.get(hi)]) : null;

  // Edge focus: keep only the two endpoint nodes
  const ek = edgeHighlightKey();
  let edgeKeep = null;
  if (ek != null) {
    const e = data.links[ek];
    edgeKeep = new Set([idIndex.get(e.source), idIndex.get(e.target)]);
  }

  data.nodes.forEach((n, i) => {
    const [r, g, b] = hexToRgb(cmap[n[state.nodes.colorBy]] || '#888888');
    const importance = Math.max(0, Math.min(1, n.importance ?? 0.5));
    let outR = r, outG = g, outB = b;
    let alpha = 0.72 + importance * 0.28;

    // Determine if this node should be dimmed.
    let dim = false;
    if (edgeKeep != null) {
      // Edge focus: only the two endpoint nodes stay foreground
      dim = !edgeKeep.has(i);
    } else if (hi != null) {
      // Hover or click-focus: only the focused node + neighbors stay foreground
      dim = !keep.has(i);
    } else if (hasSearch) {
      // Search alone: matches are foreground
      dim = !state.search.matches.has(i);
    }

    if (dim) {
      // Grey out: muted neutral colour, low alpha
      outR = outG = outB = 0.40;
      alpha = 0.18;
    } else {
      // Subtle luminance lift keeps category colours recognisable while
      // giving important nodes a cleaner, less flat point-cloud look.
      const lift = 0.05 + importance * 0.10;
      outR += (1 - outR) * lift;
      outG += (1 - outG) * lift;
      outB += (1 - outB) * lift;
    }

    pointColors[i * 4]     = outR;
    pointColors[i * 4 + 1] = outG;
    pointColors[i * 4 + 2] = outB;
    pointColors[i * 4 + 3] = alpha;
  });
  graph.setPointColors(pointColors);
  pokeRender();
}

function rebuildLinkColors() {
  const ek = edgeHighlightKey();
  const hi = highlightKey();
  const incident = (ek == null && hi != null) ? incidentOf.get(hi) : null;

  data.links.forEach((e, i) => {
    let r = 1.0, g = 1.0, b = 1.0;                              // default white
    let alpha = 0.20 + (e.weight || 0.5) * 0.50;                // weight-derived

    if (ek != null) {
      // Edge focus: only the focal edge stays orange, all others nearly black
      if (i === ek) {
        r = ORANGE_RGB[0]; g = ORANGE_RGB[1]; b = ORANGE_RGB[2];
        alpha = 1.0;
      } else {
        r = g = b = 0.30;
        alpha = 0.04;
      }
    } else if (incident) {
      if (incident.has(i)) {
        // Incident edge → highlight in Teradata Orange, full alpha
        r = ORANGE_RGB[0]; g = ORANGE_RGB[1]; b = ORANGE_RGB[2];
        alpha = 1.0;
      } else {
        // Non-incident → flat dark grey, very dim
        r = g = b = 0.30;
        alpha = 0.05;
      }
    }
    linkColors[i * 4]     = r;
    linkColors[i * 4 + 1] = g;
    linkColors[i * 4 + 2] = b;
    linkColors[i * 4 + 3] = alpha;
  });
  graph.setLinkColors(linkColors);
  pokeRender();
}

function rebuildLinkWidths() {
  // widthScale is NOT baked in here — it's a shader uniform driven by
  // linkWidthScale config (see applyLinkWidthScale). This buffer holds
  // base widths plus focus-thickening (1.7× on incident edges, 2.5× on
  // a single edge-focused link).
  const ek = edgeHighlightKey();
  const hi = highlightKey();
  const incident = (ek == null && hi != null) ? incidentOf.get(hi) : null;
  data.links.forEach((e, i) => {
    let w = 0.8 + (e.weight || 0.5) * 2.2;
    if (ek != null) {
      if (i === ek) w *= 2.5;                                   // emphasise focal edge
    } else if (incident && incident.has(i)) {
      w *= 1.7;                                                 // thicken incident
    }
    linkWidths[i] = w;
  });
  graph.setLinkWidths(linkWidths);
  pokeRender();
}

// ---- config appliers ---- //
function applySimulationParams() {
  graph.setConfig({
    simulationGravity:      state.sim.gravity,
    simulationRepulsion:    state.sim.repulsion,
    simulationLinkSpring:   state.sim.linkSpring,
    simulationLinkDistance: state.sim.linkDistance,
    simulationFriction:     state.sim.friction,
    simulationDecay:        state.sim.decay,
  });
  // Forces only act while the sim is iterating; once alpha hits zero
  // it stops moving things. Re-energize so the new params are visible.
  if (!paused) graph.start(0.3);
}
function applyRenderParams() {
  graph.setConfig({
    curvedLinks: state.edges.curved,
    linkArrows:  state.edges.arrows,
    renderLinkArrows: state.edges.arrows,
  });
}
function applyPointSizeScale() {
  // pointSizeScale is a shader uniform — changes are picked up on the next
  // frame without rebuilding the size buffer.
  graph.setConfig({ pointSizeScale: state.nodes.sizeScale });
}
function applyLinkWidthScale() {
  // Same pattern as pointSizeScale: linkWidthScale is a uniform multiplier.
  graph.setConfig({ linkWidthScale: state.edges.widthScale });
}
function applyPointOpacity() {
  // Universal point alpha multiplier. Composes with the per-point alpha
  // values set via setPointColors (which we use for search/focus dimming).
  graph.setConfig({ pointOpacity: state.nodes.opacity });
}
function applyLinkOpacity() {
  graph.setConfig({ linkOpacity: state.edges.opacity });
}

// ---- legend ---- //
const LEGEND_HEADING = {
  community: 'Communities',
  category:  'Categories',
  role:      'Roles',
};
function updateLegend() {
  const { values, cmap } = colorMaps[state.nodes.colorBy];
  document.getElementById('legend-heading').textContent =
    LEGEND_HEADING[state.nodes.colorBy] || state.nodes.colorBy;
  const rows = document.getElementById('legend-rows');
  rows.innerHTML = '';
  values.forEach(v => {
    const row = document.createElement('div');
    row.className = 'row';
    row.innerHTML = `<span class="swatch" style="background:${cmap[v]}"></span>` +
                    `<span>${v}</span>`;
    rows.appendChild(row);
  });
}

// ---- header ---- //
const c0 = colorMaps.community.values.length;
document.getElementById('stats').textContent =
  `${N} nodes · ${L} edges · ${c0} communities`;

// ---- tooltip ---- //
const tooltip = document.getElementById('tooltip');
let mouseX = 0, mouseY = 0;
addEventListener('mousemove', (ev) => {
  mouseX = ev.clientX;
  mouseY = ev.clientY;
  if (tooltip.style.display === 'block') {
    tooltip.style.left = (mouseX + 14) + 'px';
    tooltip.style.top  = (mouseY + 14) + 'px';
  }
});
function showTooltip(i) {
  const n = data.nodes[i];
  const colorBy = state.nodes.colorBy;
  const swatchHex = colorMaps[colorBy].cmap[n[colorBy]] || '#888888';
  tooltip.innerHTML = `
    <div class="name" style="color:${swatchHex}">${n.label}</div>
    <div class="row"><span>Category</span><span>${n.category ?? '—'}</span></div>
    <div class="row"><span>Community</span><span>${n.community ?? '—'}</span></div>
    <div class="row"><span>Role</span><span>${n.role ?? '—'}</span></div>
    <div class="row"><span>Importance</span><span>${n.importance.toFixed(2)}</span></div>`;
  tooltip.style.display = 'block';
  tooltip.style.left = (mouseX + 14) + 'px';
  tooltip.style.top  = (mouseY + 14) + 'px';
}

function showEdgeTooltip(i) {
  const e = data.links[i];
  const src = data.nodes[idIndex.get(e.source)];
  const tgt = data.nodes[idIndex.get(e.target)];
  // Edge "title" shows the relationship type prominently in orange
  tooltip.innerHTML = `
    <div class="name" style="color:#FF5F02">${e.type ?? 'edge'}</div>
    <div class="row"><span>Source</span><span>${src ? src.label : '#' + e.source}</span></div>
    <div class="row"><span>Target</span><span>${tgt ? tgt.label : '#' + e.target}</span></div>
    <div class="row"><span>Weight</span><span>${(e.weight ?? 0).toFixed(2)}</span></div>
    <div class="row"><span>Strength</span><span>${e.strength ?? '—'}</span></div>`;
  tooltip.style.display = 'block';
  tooltip.style.left = (mouseX + 14) + 'px';
  tooltip.style.top  = (mouseY + 14) + 'px';
}

function hideTooltip() { tooltip.style.display = 'none'; }

// ---- Canvas fallback for browser sessions without WebGL2 ---- //
class CanvasFallbackGraph {
  constructor(container, config) {
    this.container = container;
    this.config = { ...config };
    this.canvas = document.createElement('canvas');
    this.ctx = this.canvas.getContext('2d');
    this.container.appendChild(this.canvas);
    this.positions = new Float32Array(0);
    this.sizes = new Float32Array(0);
    this.pointColors = new Float32Array(0);
    this.links = new Float32Array(0);
    this.linkColors = new Float32Array(0);
    this.linkWidths = new Float32Array(0);
    this.focused = null;
    this.hovered = null;
    this.scale = 1;
    this.offsetX = 0;
    this.offsetY = 0;
    this.dragging = false;
    this.lastPointer = null;

    addEventListener('resize', () => this.resize());
    this.canvas.addEventListener('mousemove', (ev) => this.onMove(ev));
    this.canvas.addEventListener('mouseleave', () => this.onLeave());
    this.canvas.addEventListener('click', (ev) => this.onClick(ev));
    this.canvas.addEventListener('contextmenu', (ev) => this.onContextMenu(ev));
    this.canvas.addEventListener('wheel', (ev) => this.onWheel(ev), { passive: false });
    this.canvas.addEventListener('mousedown', (ev) => this.onDown(ev));
    addEventListener('mouseup', () => this.onUp());
    addEventListener('mousemove', (ev) => this.onDrag(ev));
    this.resize();
  }

  resize() {
    const rect = this.container.getBoundingClientRect();
    const ratio = Math.min(devicePixelRatio || 1, 2);
    this.canvas.width = Math.max(1, Math.floor(rect.width * ratio));
    this.canvas.height = Math.max(1, Math.floor(rect.height * ratio));
    this.canvas.style.width = rect.width + 'px';
    this.canvas.style.height = rect.height + 'px';
    this.ctx.setTransform(ratio, 0, 0, ratio, 0, 0);
    this.render();
  }

  setPointPositions(v) { this.positions = v; }
  setPointSizes(v) { this.sizes = v; }
  setPointColors(v) { this.pointColors = v; this.render(); }
  setLinks(v) { this.links = v; }
  setLinkColors(v) { this.linkColors = v; this.render(); }
  setLinkWidths(v) { this.linkWidths = v; this.render(); }
  setConfig(cfg) { this.config = { ...this.config, ...cfg }; this.render(); }
  start() { this.render(); }
  pause() { this.render(); }
  getPointPositions() { return this.positions; }
  setFocusedPointByIndex(i) { this.focused = (i == null) ? null : i; this.render(); }

  fitView() {
    if (!N) return;
    let minX = Infinity, maxX = -Infinity, minY = Infinity, maxY = -Infinity;
    for (let i = 0; i < N; i++) {
      const x = this.positions[i * 2], y = this.positions[i * 2 + 1];
      minX = Math.min(minX, x); maxX = Math.max(maxX, x);
      minY = Math.min(minY, y); maxY = Math.max(maxY, y);
    }
    const rect = this.container.getBoundingClientRect();
    const spanX = Math.max(1, maxX - minX), spanY = Math.max(1, maxY - minY);
    this.scale = Math.min(rect.width / spanX, rect.height / spanY) * 0.84;
    this.offsetX = (rect.width - spanX * this.scale) / 2 - minX * this.scale;
    this.offsetY = (rect.height - spanY * this.scale) / 2 - minY * this.scale;
    this.render();
  }

  zoomToPointByIndex(i, duration, zoomScale) {
    if (i == null || i < 0 || i >= N) return;
    const rect = this.container.getBoundingClientRect();
    this.scale = Math.max(this.scale, zoomScale || 3);
    this.offsetX = rect.width / 2 - this.positions[i * 2] * this.scale;
    this.offsetY = rect.height / 2 - this.positions[i * 2 + 1] * this.scale;
    this.render();
  }

  spaceToScreenPosition(pos) {
    return [pos[0] * this.scale + this.offsetX, pos[1] * this.scale + this.offsetY];
  }

  screenToSpace(x, y) {
    return [(x - this.offsetX) / this.scale, (y - this.offsetY) / this.scale];
  }

  pickPoint(ev) {
    const rect = this.canvas.getBoundingClientRect();
    const [sx, sy] = this.screenToSpace(ev.clientX - rect.left, ev.clientY - rect.top);
    let best = null, bestD = Infinity;
    const maxScreenD = 11;
    const maxSpaceD = maxScreenD / Math.max(this.scale, 0.001);
    for (let i = 0; i < N; i++) {
      const dx = this.positions[i * 2] - sx;
      const dy = this.positions[i * 2 + 1] - sy;
      const d = dx * dx + dy * dy;
      if (d < bestD && d <= maxSpaceD * maxSpaceD) {
        best = i; bestD = d;
      }
    }
    return best;
  }

  onMove(ev) {
    if (this.dragging) return;
    const i = this.pickPoint(ev);
    if (i !== this.hovered) {
      if (this.hovered != null && this.config.onPointMouseOut) this.config.onPointMouseOut();
      this.hovered = i;
      if (i != null && this.config.onPointMouseOver) this.config.onPointMouseOver(i);
      this.canvas.style.cursor = i == null ? 'default' : 'pointer';
    }
  }

  onLeave() {
    if (this.hovered != null && this.config.onPointMouseOut) this.config.onPointMouseOut();
    this.hovered = null;
    this.canvas.style.cursor = 'default';
  }

  onClick(ev) {
    const i = this.pickPoint(ev);
    if (this.config.onClick) this.config.onClick(i);
  }

  onContextMenu(ev) {
    ev.preventDefault();
    const i = this.pickPoint(ev);
    if (i != null && this.config.onPointContextMenu) {
      this.config.onPointContextMenu(i, ev);
    }
  }

  onWheel(ev) {
    ev.preventDefault();
    const rect = this.canvas.getBoundingClientRect();
    const mx = ev.clientX - rect.left, my = ev.clientY - rect.top;
    const before = this.screenToSpace(mx, my);
    const factor = ev.deltaY < 0 ? 1.15 : 0.87;
    this.scale = Math.max(0.05, Math.min(12, this.scale * factor));
    this.offsetX = mx - before[0] * this.scale;
    this.offsetY = my - before[1] * this.scale;
    this.render();
  }

  onDown(ev) {
    this.dragging = true;
    this.lastPointer = [ev.clientX, ev.clientY];
  }

  onDrag(ev) {
    if (!this.dragging || !this.lastPointer) return;
    this.offsetX += ev.clientX - this.lastPointer[0];
    this.offsetY += ev.clientY - this.lastPointer[1];
    this.lastPointer = [ev.clientX, ev.clientY];
    this.render();
  }

  onUp() {
    this.dragging = false;
    this.lastPointer = null;
  }

  rgba(buf, i, opacity) {
    const a = Math.max(0, Math.min(1, (buf[i * 4 + 3] ?? 1) * opacity));
    return `rgba(${Math.round((buf[i * 4] ?? 1) * 255)},` +
           `${Math.round((buf[i * 4 + 1] ?? 1) * 255)},` +
           `${Math.round((buf[i * 4 + 2] ?? 1) * 255)},${a})`;
  }

  render() {
    if (!this.ctx) return;
    const rect = this.container.getBoundingClientRect();
    const ctx = this.ctx;
    ctx.save();
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.clearRect(0, 0, this.canvas.width, this.canvas.height);
    ctx.restore();
    ctx.fillStyle = '#00233C';
    ctx.fillRect(0, 0, rect.width, rect.height);

    ctx.save();
    ctx.translate(this.offsetX, this.offsetY);
    ctx.scale(this.scale, this.scale);
    ctx.lineCap = 'round';

    const largeGraphFade = L > 10000 ? 0.18 : (L > 3000 ? 0.32 : 1);
    const linkOpacity = (this.config.linkOpacity ?? 1) * largeGraphFade;
    for (let i = 0; i < L; i++) {
      const s = this.links[i * 2], t = this.links[i * 2 + 1];
      if (s == null || t == null) continue;
      const sx = this.positions[s * 2];
      const sy = this.positions[s * 2 + 1];
      const tx = this.positions[t * 2];
      const ty = this.positions[t * 2 + 1];
      const dx = tx - sx;
      const dy = ty - sy;
      const stroke = this.rgba(this.linkColors, i, linkOpacity);
      const width = Math.max(0.4, (this.linkWidths[i] || 1) * (this.config.linkWidthScale || 1) / this.scale);
      ctx.beginPath();
      ctx.moveTo(sx, sy);
      if (this.config.curvedLinks) {
        const bend = 0.16;
        const cx = (sx + tx) / 2 - dy * bend;
        const cy = (sy + ty) / 2 + dx * bend;
        ctx.quadraticCurveTo(cx, cy, tx, ty);
      } else {
        ctx.lineTo(tx, ty);
      }
      ctx.strokeStyle = stroke;
      ctx.lineWidth = width;
      ctx.stroke();

      if (this.config.linkArrows || this.config.renderLinkArrows) {
        const angle = Math.atan2(ty - sy, tx - sx);
        const nodeRadius = Math.max(2 / this.scale, (this.sizes[t] || 4) * (this.config.pointSizeScale || 1));
        const arrowLen = Math.max(4 / this.scale, 8 / this.scale);
        const ax = tx - Math.cos(angle) * nodeRadius;
        const ay = ty - Math.sin(angle) * nodeRadius;
        ctx.beginPath();
        ctx.moveTo(ax, ay);
        ctx.lineTo(ax - Math.cos(angle - 0.42) * arrowLen, ay - Math.sin(angle - 0.42) * arrowLen);
        ctx.moveTo(ax, ay);
        ctx.lineTo(ax - Math.cos(angle + 0.42) * arrowLen, ay - Math.sin(angle + 0.42) * arrowLen);
        ctx.strokeStyle = stroke;
        ctx.lineWidth = width;
        ctx.stroke();
      }
    }

    const pointOpacity = this.config.pointOpacity ?? 1;
    for (let i = 0; i < N; i++) {
      const radius = Math.max(1.8 / this.scale, (this.sizes[i] || 4) * (this.config.pointSizeScale || 1));
      ctx.beginPath();
      ctx.arc(this.positions[i * 2], this.positions[i * 2 + 1], radius, 0, Math.PI * 2);
      ctx.fillStyle = this.rgba(this.pointColors, i, pointOpacity);
      ctx.fill();
      if (i === this.focused) {
        ctx.lineWidth = 2 / this.scale;
        ctx.strokeStyle = '#FF5F02';
        ctx.stroke();
      }
    }
    ctx.restore();
  }
}
// ---- initial cosmos.gl config ---- //
const initialConfig = {
  backgroundColor: '#00233C',
  spaceSize: 4096,
  pointSizeScale: state.nodes.sizeScale,
  linkWidthScale: state.edges.widthScale,
  pointOpacity:   state.nodes.opacity,
  linkOpacity:    state.edges.opacity,
  scalePointsOnZoom: true,
  renderLinks: true,
  curvedLinks: state.edges.curved,
  linkArrows: state.edges.arrows,
  renderLinkArrows: state.edges.arrows,

  fitViewOnInit: true,
  fitViewDelay: 500,
  fitViewPadding: 0.15,
  enableDrag: true,

  simulationGravity:      state.sim.gravity,
  simulationRepulsion:    state.sim.repulsion,
  simulationLinkSpring:   state.sim.linkSpring,
  simulationLinkDistance: state.sim.linkDistance,
  simulationFriction:     state.sim.friction,
  simulationDecay:        state.sim.decay,

  hoveredPointCursor: 'pointer',
  renderHoveredPointRing: true,
  hoveredPointRingColor: '#FF5F02',
  focusedPointRingColor: '#FF5F02',

  // Edge interaction (cosmos.gl v2.5+). When the loaded CDN version is
  // older these are silently ignored — graceful degradation; node
  // interaction continues to work either way.
  hoveredLinkCursor: 'pointer',
  hoveredLinkColor: '#FF5F02',
  hoveredLinkWidthIncrease: 2,

  onPointMouseOver: (index) => {
    if (index == null) return;
    showTooltip(index);
    if (state.hovered !== index) {
      state.hovered = index;
      rebuildPointColors();
      rebuildLinkColors();
      rebuildLinkWidths();
    }
  },
  onPointMouseOut: () => {
    hideTooltip();
    if (state.hovered != null) {
      state.hovered = null;
      rebuildPointColors();
      rebuildLinkColors();
      rebuildLinkWidths();
    }
  },
  onClick: (index) => {
    hideNodeContextMenu();
    if (state.focusedEdge != null) {
      state.focusedEdge = null;
    }
    setFocused(index ?? null);
  },
  onPointContextMenu: (index, ev) => {
    showNodeContextMenu(index, ev.clientX, ev.clientY);
  },

  onLinkMouseOver: (linkIndex) => {
    if (linkIndex == null) return;
    showEdgeTooltip(linkIndex);
    if (state.hoveredEdge !== linkIndex) {
      state.hoveredEdge = linkIndex;
      rebuildPointColors();
      rebuildLinkColors();
      rebuildLinkWidths();
    }
  },
  onLinkMouseOut: () => {
    hideTooltip();
    if (state.hoveredEdge != null) {
      state.hoveredEdge = null;
      rebuildPointColors();
      rebuildLinkColors();
      rebuildLinkWidths();
    }
  },
  onLinkClick: (linkIndex) => {
    // Clicking an edge clears any node focus and selects this edge
    if (state.focused != null) {
      state.focused = null;
      graph.setFocusedPointByIndex(undefined);
    }
    setFocusedEdge(linkIndex ?? null);
  },
};

const div = document.getElementById('graph');
let graph;
try {
  graph = Graph ? new Graph(div, initialConfig) : new CanvasFallbackGraph(div, initialConfig);
} catch (err) {
  showRendererNotice(
    'Canvas fallback active: the WebGL renderer could not start. ' +
    'Right-click a node to drill-down into its subgraph.'
  );
  graph = new CanvasFallbackGraph(div, initialConfig);
}

div.addEventListener('contextmenu', (ev) => {
  ev.preventDefault();
  const index = state.hovered;
  if (index != null) showNodeContextMenu(index, ev.clientX, ev.clientY);
});

graph.setPointPositions(pointPositions);
graph.setPointSizes(pointSizes);
rebuildPointColors();
rebuildLinkColors();
rebuildLinkWidths();
updateLegend();

graph.setLinks(linksArr);
graph.render();
applyRenderParams();
applyPointSizeScale();
applyPointOpacity();
applyLinkWidthScale();
applyLinkOpacity();
if (graph instanceof CanvasFallbackGraph) graph.fitView();

// ============================================================ //
//                       FOCUS / SELECTION                      //
// ============================================================ //

function setFocused(i) {
  state.focused = (i == null) ? null : i;
  graph.setFocusedPointByIndex(state.focused == null ? undefined : state.focused);
  rebuildPointColors();
  rebuildLinkColors();
  rebuildLinkWidths();
}

function setFocusedEdge(i) {
  state.focusedEdge = (i == null) ? null : i;
  rebuildPointColors();
  rebuildLinkColors();
  rebuildLinkWidths();
}

function focusOnNode(i) {
  setFocused(i);
  // zoomToPointByIndex(index, duration?, scale?, canZoomOut?) is the v2
  // animated camera move (confirmed in the cosmos.gl source's Zoom module).
  // Wait one frame so the focus rebuild lands before the zoom starts.
  requestAnimationFrame(() => {
    try {
      graph.zoomToPointByIndex(i, 800, 6, true);
    } catch (err) {
      console.warn('zoomToPointByIndex failed:', err);
    }
  });
}

// ============================================================ //
//                            UI                                //
// ============================================================ //

const nodeContextMenu = document.getElementById('context-menu');

function hideNodeContextMenu() {
  nodeContextMenu.style.display = 'none';
}

function contextMenuButton(label, action) {
  const btn = document.createElement('button');
  btn.type = 'button';
  btn.textContent = label;
  btn.onclick = () => {
    hideNodeContextMenu();
    action();
  };
  return btn;
}

function showNodeContextMenu(index, x, y) {
  const node = data.nodes[index];
  if (!node) return;

  setFocused(index);
  nodeContextMenu.innerHTML = '';
  const title = document.createElement('div');
  title.className = 'title';
  title.textContent = node.label || `#${node.id}`;
  nodeContextMenu.appendChild(title);

  const filterField = document.createElement('div');
  filterField.className = 'field';

  const filterLabel = document.createElement('label');
  filterLabel.htmlFor = 'context-filter';
  filterLabel.textContent = 'Filter';
  filterField.appendChild(filterLabel);

  const filterSelect = document.createElement('select');
  filterSelect.id = 'context-filter';
  [
    ['', 'No value', null],
    ['community', 'Community', node.community],
    ['category', 'Category', node.category],
    ['role', 'Role', node.role],
  ].forEach(([key, label, value]) => {
    const opt = document.createElement('option');
    opt.value = key;
    opt.textContent = value == null || value === '' ? label : `${label}: ${value}`;
    opt.disabled = key !== '' && (value == null || value === '');
    filterSelect.appendChild(opt);
  });
  filterField.appendChild(filterSelect);
  nodeContextMenu.appendChild(filterField);

  nodeContextMenu.appendChild(contextMenuButton('Drill into node', () => {
    const key = filterSelect.value;
    const values = { community: node.community, category: node.category, role: node.role };
    drillIntoNode(index, key || undefined, key ? values[key] : undefined);
  }));

  nodeContextMenu.style.left = Math.min(x, innerWidth - 250) + 'px';
  nodeContextMenu.style.top = Math.min(y, innerHeight - 160) + 'px';
  nodeContextMenu.style.display = 'block';
}

addEventListener('click', (ev) => {
  if (!nodeContextMenu.contains(ev.target)) hideNodeContextMenu();
});
addEventListener('keydown', (ev) => {
  if (ev.key === 'Escape') hideNodeContextMenu();
});
let paused = false;
const btnPause = document.getElementById('btn-pause');

document.getElementById('btn-fit').onclick = () => graph.fitView(750);
btnPause.onclick = () => {
  paused = !paused;
  if (paused) { graph.pause();    btnPause.textContent = 'Resume'; }
  else        { graph.start(0.3); btnPause.textContent = 'Pause';  }
};
document.getElementById('btn-restart').onclick = () => {
  paused = false; btnPause.textContent = 'Pause';
  graph.start(1.0);
};
document.getElementById('btn-reset').onclick = () => {
  seedPositions();
  graph.setPointPositions(pointPositions);
  paused = false; btnPause.textContent = 'Pause';
  graph.start(1.0);
  setTimeout(() => graph.fitView(750), 600);
};

function bindSlider(sliderId, valueId, getter, setter, onChange) {
  const slider = document.getElementById(sliderId);
  const value  = document.getElementById(valueId);
  const isInt  = slider.step === '1';
  const fmt    = (v) => isInt ? String(v) : v.toFixed(2);
  slider.value = getter();
  value.textContent = fmt(getter());
  slider.addEventListener('input', () => {
    const v = isInt ? parseInt(slider.value, 10) : parseFloat(slider.value);
    setter(v);
    value.textContent = fmt(v);
    onChange();
    saveUiSettings();
  });
}

document.getElementById('sel-colorBy').value = state.nodes.colorBy;
document.getElementById('chk-curved').checked = state.edges.curved;
document.getElementById('chk-arrows').checked = state.edges.arrows;
document.getElementById('chk-nodeLabels').checked = state.labels.nodes;
document.getElementById('chk-edgeLabels').checked = state.labels.edges;

// simulation sliders — re-energize after setConfig
bindSlider('s-gravity',      'v-gravity',
  () => state.sim.gravity,      (v) => state.sim.gravity = v,      applySimulationParams);
bindSlider('s-repulsion',    'v-repulsion',
  () => state.sim.repulsion,    (v) => state.sim.repulsion = v,    applySimulationParams);
bindSlider('s-linkSpring',   'v-linkSpring',
  () => state.sim.linkSpring,   (v) => state.sim.linkSpring = v,   applySimulationParams);
bindSlider('s-linkDistance', 'v-linkDistance',
  () => state.sim.linkDistance, (v) => state.sim.linkDistance = v, applySimulationParams);
bindSlider('s-friction',     'v-friction',
  () => state.sim.friction,     (v) => state.sim.friction = v,     applySimulationParams);

// node sliders
bindSlider('s-sizeScale',   'v-sizeScale',
  () => state.nodes.sizeScale, (v) => state.nodes.sizeScale = v, applyPointSizeScale);
bindSlider('s-nodeOpacity', 'v-nodeOpacity',
  () => state.nodes.opacity,   (v) => state.nodes.opacity   = v, applyPointOpacity);

// edge sliders
bindSlider('s-widthScale',  'v-widthScale',
  () => state.edges.widthScale, (v) => state.edges.widthScale = v, applyLinkWidthScale);
bindSlider('s-edgeOpacity', 'v-edgeOpacity',
  () => state.edges.opacity,    (v) => state.edges.opacity    = v, applyLinkOpacity);

document.getElementById('sel-colorBy').addEventListener('change', (ev) => {
  state.nodes.colorBy = ev.target.value;
  rebuildPointColors();
  updateLegend();
  saveUiSettings();
});

document.getElementById('chk-curved').addEventListener('change', (ev) => {
  state.edges.curved = ev.target.checked;
  applyRenderParams();
  saveUiSettings();
});
document.getElementById('chk-arrows').addEventListener('change', (ev) => {
  state.edges.arrows = ev.target.checked;
  applyRenderParams();
  saveUiSettings();
});

// ============================================================ //
//                          SEARCH                              //
// ============================================================ //

const searchInput   = document.getElementById('search-input');
const searchResults = document.getElementById('search-results');
const searchStatus  = document.getElementById('search-status');

function runSearch(query) {
  const q = (query || '').trim().toLowerCase();
  state.search.query = q;
  searchResults.innerHTML = '';

  if (!q) {
    state.search.matches = new Set();
    searchStatus.textContent = '';
    rebuildPointColors();
    return;
  }

  const matches = [];
  data.nodes.forEach((n, i) => {
    if (n.label && n.label.toLowerCase().includes(q)) matches.push(i);
  });
  state.search.matches = new Set(matches);

  matches.slice(0, 8).forEach(i => {
    const n = data.nodes[i];
    const item = document.createElement('div');
    item.className = 'item';
    item.innerHTML = `<span class="label">${n.label}</span>` +
                     `<span class="meta">${n.category} · ${n.community}</span>`;
    item.onclick = () => focusOnNode(i);
    searchResults.appendChild(item);
  });

  if (matches.length === 0) {
    searchStatus.textContent = 'No matches';
  } else if (matches.length <= 8) {
    searchStatus.textContent = `${matches.length} match${matches.length === 1 ? '' : 'es'}`;
  } else {
    searchStatus.textContent = `Showing 8 of ${matches.length} matches`;
  }

  rebuildPointColors();
  if (matches.length === 1) focusOnNode(matches[0]);
}

searchInput.addEventListener('input', (ev) => runSearch(ev.target.value));
searchInput.addEventListener('keydown', (ev) => {
  if (ev.key === 'Escape') {
    searchInput.value = '';
    runSearch('');
    setFocused(null);
  } else if (ev.key === 'Enter') {
    const first = [...state.search.matches][0];
    if (first != null) focusOnNode(first);
  }
});

// ============================================================ //
//                           LABELS                             //
// ============================================================ //

const labelLayer = document.getElementById('labels');

// Pre-create one DOM element per node and per edge; toggle visibility via state
const nodeLabelEls = data.nodes.map((n) => {
  const el = document.createElement('div');
  el.className = 'label-node';
  el.textContent = n.label || '';
  labelLayer.appendChild(el);
  return el;
});
const edgeLabelEls = data.links.map((e) => {
  const el = document.createElement('div');
  el.className = 'label-edge';
  el.textContent = e.type || '';
  labelLayer.appendChild(el);
  return el;
});

let labelRafId = null;
let labelApiBroken = false;

function projectAndUpdateLabels() {
  if (labelApiBroken) return;

  let positions;
  try {
    positions = graph.getPointPositions();   // Float32Array of [x1,y1,x2,y2,...]
  } catch (_) {
    labelApiBroken = true; stopLabelLoop(); return;
  }
  if (!positions || positions.length < N * 2) return;

  const showN = state.labels.nodes;
  const showE = state.labels.edges;

  if (showN) {
    for (let i = 0; i < N; i++) {
      let sp;
      try {
        sp = graph.spaceToScreenPosition([positions[i * 2], positions[i * 2 + 1]]);
      } catch (_) { labelApiBroken = true; stopLabelLoop(); return; }
      if (!sp) continue;
      // place above the point (translate -50% horizontal, plus a fixed offset upward)
      nodeLabelEls[i].style.transform =
        `translate(${sp[0]}px, ${sp[1]}px) translate(-50%, calc(-100% - 10px))`;
    }
  }
  if (showE) {
    for (let i = 0; i < L; i++) {
      const e = data.links[i];
      const i1 = idIndex.get(e.source), i2 = idIndex.get(e.target);
      const x = (positions[i1 * 2]     + positions[i2 * 2])     / 2;
      const y = (positions[i1 * 2 + 1] + positions[i2 * 2 + 1]) / 2;
      let sp;
      try { sp = graph.spaceToScreenPosition([x, y]); }
      catch (_) { labelApiBroken = true; stopLabelLoop(); return; }
      if (!sp) continue;
      edgeLabelEls[i].style.transform =
        `translate(${sp[0]}px, ${sp[1]}px) translate(-50%, -50%)`;
    }
  }
}

function startLabelLoop() {
  if (labelRafId != null || labelApiBroken) return;
  const tick = () => {
    projectAndUpdateLabels();
    labelRafId = requestAnimationFrame(tick);
  };
  labelRafId = requestAnimationFrame(tick);
}
function stopLabelLoop() {
  if (labelRafId != null) {
    cancelAnimationFrame(labelRafId);
    labelRafId = null;
  }
}

function setNodeLabelsVisible(show) {
  state.labels.nodes = show;
  nodeLabelEls.forEach(el => el.style.display = show ? 'block' : 'none');
  if (state.labels.nodes || state.labels.edges) startLabelLoop();
  else stopLabelLoop();
}
function setEdgeLabelsVisible(show) {
  state.labels.edges = show;
  edgeLabelEls.forEach(el => el.style.display = show ? 'block' : 'none');
  if (state.labels.nodes || state.labels.edges) startLabelLoop();
  else stopLabelLoop();
}

document.getElementById('chk-nodeLabels').addEventListener('change', (ev) => {
  setNodeLabelsVisible(ev.target.checked);
  saveUiSettings();
});
document.getElementById('chk-edgeLabels').addEventListener('change', (ev) => {
  setEdgeLabelsVisible(ev.target.checked);
  saveUiSettings();
});
setNodeLabelsVisible(state.labels.nodes);
setEdgeLabelsVisible(state.labels.edges);

// ============================================================ //
//                       BFS RUNTIME RELOAD                     //
// ============================================================ //
//
// Wires the "Subgraph (BFS)" section. When launched via
//   python teradata_cosmos_graph.py serve
// the embedded HTTP server resolves seed labels and re-fetches
// subgraphs on demand. The page reloads with new query-string
// parameters so the entire visualisation state is rebuilt cleanly.
// When opened directly as a static file, the buttons fall through
// with a friendly error.

const bfsSeedInput  = document.getElementById('bfs-seed');
const bfsDepthInput = document.getElementById('bfs-depth');
const bfsDepthVal   = document.getElementById('v-bfs-depth');
const bfsStatusMode = document.getElementById('bfs-mode');
const bfsStatusStat = document.getElementById('bfs-stats');
const bfsErr        = document.getElementById('bfs-error');
const bfsBreadcrumb = document.getElementById('bfs-breadcrumb');

function getBfsDepth() {
  const depth = parseInt(bfsDepthInput.value, 10);
  if (Number.isNaN(depth)) return 2;
  return Math.max(1, Math.min(6, depth));
}

function setBfsSeedFromNode(index) {
  const node = data.nodes[index];
  if (!node) return;
  const label = node.label ? ` ${node.label}` : '';
  bfsSeedInput.value = `#${node.id}${label}`;
}

bfsDepthInput.addEventListener('input', () => {
  bfsDepthVal.textContent = getBfsDepth();
});

const BREADCRUMB_KEY = 'teraGraphExplorerBreadcrumbs';
const NEXT_CRUMB_KEY = 'teraGraphExplorerNextCrumbLabel';

function normaliseCrumbUrl(url) {
  const u = new URL(url, window.location.href);
  return u.pathname + u.search;
}

function loadBreadcrumbs() {
  try {
    const parsed = JSON.parse(sessionStorage.getItem(BREADCRUMB_KEY) || '[]');
    return Array.isArray(parsed) ? parsed : [];
  } catch (_) {
    return [];
  }
}

function saveBreadcrumbs(crumbs) {
  sessionStorage.setItem(BREADCRUMB_KEY, JSON.stringify(crumbs.slice(-8)));
}

function currentCrumbLabel() {
  const pending = sessionStorage.getItem(NEXT_CRUMB_KEY);
  if (pending) {
    sessionStorage.removeItem(NEXT_CRUMB_KEY);
    return pending;
  }
  if (data._seed_id != null) return `#${data._seed_id} depth ${data._max_depth || getBfsDepth()}`;
  if (data._empty === true) return 'Start';
  return 'Full graph';
}

function rememberCurrentView() {
  const url = normaliseCrumbUrl(window.location.href);
  const label = currentCrumbLabel();
  let crumbs = loadBreadcrumbs();
  const existing = crumbs.findIndex(c => c.url === url);
  if (existing >= 0) crumbs = crumbs.slice(0, existing + 1);
  else crumbs.push({ label, url });
  saveBreadcrumbs(crumbs);
  renderBreadcrumbs(crumbs);
}

function renderBreadcrumbs(crumbs) {
  bfsBreadcrumb.innerHTML = '';
  crumbs.forEach((crumb, i) => {
    if (i > 0) {
      const sep = document.createElement('span');
      sep.className = 'sep';
      sep.textContent = '›';
      bfsBreadcrumb.appendChild(sep);
    }
    const isCurrent = i === crumbs.length - 1;
    const item = document.createElement(isCurrent ? 'span' : 'a');
    item.className = isCurrent ? 'current' : '';
    item.textContent = crumb.label;
    if (!isCurrent) {
      item.onclick = () => { window.location.href = crumb.url; };
    }
    bfsBreadcrumb.appendChild(item);
  });
}

function queueNextCrumb(label) {
  sessionStorage.setItem(NEXT_CRUMB_KEY, label);
}

// Status badge: read totals from the data payload if the server stamped
// them in (BFS mode), otherwise just show the loaded counts.
(function setInitialBfsStatus() {
  const seedId   = data._seed_id;
  const totalN   = data._total_nodes;
  const totalL   = data._total_edges;
  const isEmpty  = data._empty === true;

  // Pre-populate seed input from URL if present (so refreshing the page
  // keeps the user's last input visible).
  const params = new URLSearchParams(window.location.search);
  if (params.has('seed_id') && !bfsSeedInput.value) {
    bfsSeedInput.value = '#' + params.get('seed_id');
  }
  if (params.has('max_depth')) {
    const d = parseInt(params.get('max_depth'), 10);
    if (d >= 1 && d <= 6) {
      bfsDepthInput.value = d;
      bfsDepthVal.textContent = d;
    }
  }

  if (isEmpty) {
    bfsStatusMode.textContent = 'no data';
    bfsStatusStat.textContent = 'enter a seed node →';
    document.getElementById('empty-state').style.display = 'block';
    document.getElementById('legend').style.display = 'none';
    document.getElementById('stats').textContent = '0 nodes · 0 edges';
    bfsSeedInput.focus();
    return;
  }

  if (seedId != null) {
    bfsStatusMode.textContent = `bfs (depth ${data._max_depth})`;
    if (totalN != null && totalL != null) {
      bfsStatusStat.textContent =
        `${N.toLocaleString()} / ${totalN.toLocaleString()} nodes · ` +
        `${L.toLocaleString()} / ${totalL.toLocaleString()} edges`;
    } else {
      bfsStatusStat.textContent = `${N.toLocaleString()} nodes · ${L.toLocaleString()} edges`;
    }
    bfsSeedInput.value = '#' + seedId;
    bfsDepthInput.value = data._max_depth;
    bfsDepthVal.textContent = data._max_depth;
  } else {
    bfsStatusMode.textContent = 'full graph';
    bfsStatusStat.textContent = `${N.toLocaleString()} nodes · ${L.toLocaleString()} edges`;
  }

  // Warn up-front if the page was opened as a static file — BFS needs the
  // running server, and silent failure on click is a frustrating UX.
  if (window.location.protocol === 'file:') {
    bfsErr.textContent =
      'Static mode: BFS disabled. Run `python teradata_cosmos_graph.py serve` to enable.';
    document.getElementById('btn-bfs-run').disabled = true;
    document.getElementById('btn-bfs-reset').disabled = true;
    bfsSeedInput.disabled = true;
    bfsDepthInput.disabled = true;
  }
})();
rememberCurrentView();

async function bfsResolveSeed(payload) {
  bfsErr.textContent = '';

  // If the page was opened as a local file there is no server to talk to,
  // so don't even try the fetch — give a precise message up front.
  if (window.location.protocol === 'file:') {
    bfsErr.textContent =
      'BFS needs the server. You opened the file directly (file://). ' +
      'Run: python teradata_cosmos_graph.py serve';
    throw new Error('static-mode (file://)');
  }

  let resp;
  try {
    resp = await fetch('/api/bfs', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload),
    });
  } catch (err) {
    // Network-level failure: server not running on this port, wrong host, etc.
    bfsErr.textContent =
      `Cannot reach ${window.location.host}. Is the Python server still running? ` +
      `(${err.message})`;
    throw err;
  }
  if (!resp.ok) {
    // Server is reachable but returned an error — likely a SQL or auth issue.
    let message = resp.statusText;
    try {
      const body = await resp.json();
      message = body.error || message;
    } catch (_) {
      message = await resp.text().catch(() => message);
    }
    bfsErr.textContent = `Server returned ${resp.status}: ${message.slice(0, 220)}`;
    throw new Error(message);
  }
  return resp.json();
}

function navigateTo(seedId, maxDepth, opts) {
  saveUiSettings();
  // opts: { full: bool } — explicit "full graph" navigation
  const u = new URL(window.location.href);
  u.searchParams.delete('seed_id');
  u.searchParams.delete('max_depth');
  u.searchParams.delete('full');
  u.searchParams.delete('filter_key');
  u.searchParams.delete('filter_value');
  if (seedId != null) {
    u.searchParams.set('seed_id', seedId);
    u.searchParams.set('max_depth', maxDepth);
  } else if (opts && opts.full) {
    u.searchParams.set('full', '1');
  }
  if (opts && opts.filterKey && opts.filterValue != null) {
    u.searchParams.set('filter_key', opts.filterKey);
    u.searchParams.set('filter_value', opts.filterValue);
  }
  if (opts && opts.label) queueNextCrumb(opts.label);
  window.location.href = u.toString();
}

function drillIntoNode(index, filterKey, filterValue) {
  if (index == null) return;
  const node = data.nodes[index];
  if (!node) return;

  setBfsSeedFromNode(index);
  const depth = getBfsDepth();

  if (window.location.protocol === 'file:') {
    bfsErr.textContent =
      'BFS needs the server. Run: python teradata_cosmos_graph.py serve';
    return;
  }

  const label = node.label || `#${node.id}`;
  const filterLabel = filterKey ? ` (${filterKey}: ${filterValue})` : '';
  bfsErr.textContent = `Opening ${label}${filterLabel} at depth ${depth}...`;
  navigateTo(node.id, depth, {
    label: label + filterLabel + ' depth ' + depth,
    filterKey,
    filterValue,
  });
}

document.getElementById('btn-bfs-run').onclick = async () => {
  const raw = bfsSeedInput.value.trim();
  if (!raw) {
    bfsErr.textContent = 'Enter a node label or #id';
    return;
  }
  const depth = getBfsDepth();
  const seedIdMatch = raw.match(/^#\s*(\d+)/);
  const payload = seedIdMatch
    ? { seed_id: parseInt(seedIdMatch[1], 10), max_depth: depth }
    : { seed_label: raw, max_depth: depth };
  try {
    const result = await bfsResolveSeed(payload);
    if (result.seed_id == null) {
      bfsErr.textContent = 'No node matched that label.';
      return;
    }
    navigateTo(result.seed_id, depth, { label: raw.replace(/^#\s*/, '#') + ' depth ' + depth });
  } catch (_) { /* error already shown */ }
};

document.getElementById('btn-bfs-reset').onclick = () => navigateTo(null, null, { full: true, label: 'Full graph' });

// Submit on Enter in the seed input
bfsSeedInput.addEventListener('keydown', (ev) => {
  if (ev.key === 'Enter') document.getElementById('btn-bfs-run').click();
});
</script>
</body>
</html>
"""


def render_html(data: dict, output_path: Path) -> None:
    payload = json.dumps(data, separators=(",", ":"), ensure_ascii=False)
    database = data.get("_database", DEFAULT_DATABASE)
    html = (HTML_TEMPLATE
            .replace("__DATA__", payload)
            .replace("__DATABASE__", database)
            .replace("__LOGO_URI__", TERADATA_LOGO_URI))
    output_path.write_text(html, encoding="utf-8")


def render_html_str(data: dict) -> str:
    """Same as render_html but returns the string (for the HTTP server)."""
    payload = json.dumps(data, separators=(",", ":"), ensure_ascii=False)
    database = data.get("_database", DEFAULT_DATABASE)
    return (HTML_TEMPLATE
            .replace("__DATA__", payload)
            .replace("__DATABASE__", database)
            .replace("__LOGO_URI__", TERADATA_LOGO_URI))


# --------------------------------------------------------------------------- #
# HTTP server mode — lets the running HTML re-query for new BFS subgraphs    #
# --------------------------------------------------------------------------- #

def serve(host: str, user: str, password: str, logmech: str, database: str,
          port: int, initial_seed_id, initial_max_depth: int) -> None:
    """Run a small HTTP server. GET / serves the visualisation HTML
    (with optional ?seed_id=&max_depth= query params for a BFS subgraph),
    and POST /api/bfs resolves a seed label to a node_id."""
    import http.server
    import socketserver
    import urllib.parse

    print(f"→ Connecting to {host} as {user} ({logmech}); database={database}…")
    conn = teradatasql.connect(host=host, user=user, password=password,
                                logmech=logmech)

    # Cache rendered HTML for recently used (seed_id, max_depth) pairs so
    # back-button navigation between subgraphs doesn't re-query.
    cache: dict = {}
    CACHE_LIMIT = 4

    def html_for(seed_id, max_depth: int, full: bool = False,
                 filter_key=None, filter_value=None) -> str:
        # Three states:
        #   1) empty: no seed and not full -> empty visualisation, prompt user
        #   2) bfs:   seed_id given        -> recursive CTE subgraph
        #   3) full:  full=True            -> entire graph
        key = (seed_id, max_depth, full, filter_key, filter_value)
        if key in cache:
            return cache[key]
        if seed_id is not None:
            print(f"  BFS from node_id={seed_id}, max_depth={max_depth}, filter={filter_key}:{filter_value}…")
            data = fetch_bfs_subgraph(conn, database, seed_id, max_depth,
                                      filter_key, filter_value)
            print(f"    -> {len(data['nodes'])} nodes, {len(data['links'])} edges")
        elif full:
            print(f"  fetching full graph…")
            data = fetch_full_graph(conn, database)
            print(f"    -> {len(data['nodes'])} nodes, {len(data['links'])} edges")
        else:
            # Empty landing page — no query, no data, just the controls panel.
            print("  empty landing page (awaiting user input)")
            data = {"nodes": [], "links": [], "_empty": True, "_database": database}

        html = render_html_str(data)
        if len(cache) >= CACHE_LIMIT:
            cache.pop(next(iter(cache)))
        cache[key] = html
        return html

    class Handler(http.server.BaseHTTPRequestHandler):
        def log_message(self, fmt, *args):
            print("  [http]", fmt % args)

        def do_GET(self):
            parsed = urllib.parse.urlparse(self.path)
            if parsed.path in ("/", "/index.html"):
                qs = urllib.parse.parse_qs(parsed.query)
                # Server starts in EMPTY state. The CLI's --seed-id is
                # used as a default (pre-populated), but the page only
                # actually queries when the user clicks Run BFS or
                # Full graph (which navigates to ?full=1).
                seed_id = (int(qs["seed_id"][0]) if "seed_id" in qs
                           else None)
                max_depth = (int(qs["max_depth"][0]) if "max_depth" in qs
                             else (initial_max_depth or 2))
                full = qs.get("full", ["0"])[0] in ("1", "true")
                filter_key = qs.get("filter_key", [None])[0]
                filter_value = qs.get("filter_value", [None])[0]
                try:
                    body = html_for(seed_id, max_depth, full=full,
                                    filter_key=filter_key,
                                    filter_value=filter_value).encode("utf-8")
                except Exception as e:
                    self.send_error(500, f"Query failed: {e}")
                    return
                self.send_response(200)
                self.send_header("Content-Type", "text/html; charset=utf-8")
                self.send_header("Content-Length", str(len(body)))
                self.send_header("Cache-Control", "no-store")
                self.end_headers()
                self.wfile.write(body)
            else:
                self.send_error(404)

        def send_json_error(self, status: int, message: str):
            body = json.dumps({"error": message}).encode("utf-8")
            self.send_response(status)
            self.send_header("Content-Type", "application/json")
            self.send_header("Content-Length", str(len(body)))
            self.send_header("Cache-Control", "no-store")
            self.end_headers()
            self.wfile.write(body)

        def do_POST(self):
            if self.path != "/api/bfs":
                self.send_json_error(404, "Endpoint not found")
                return
            length = int(self.headers.get("Content-Length", "0"))
            try:
                payload = json.loads(self.rfile.read(length))
            except Exception:
                self.send_json_error(400, "Bad JSON")
                return
            try:
                if "seed_id" in payload:
                    seed_id = int(payload["seed_id"])
                elif "seed_label" in payload:
                    seed_id = resolve_seed_label(conn, database, payload["seed_label"])
                else:
                    self.send_json_error(400, "Need seed_id or seed_label")
                    return
                resp = json.dumps({"seed_id": seed_id}).encode("utf-8")
                self.send_response(200)
                self.send_header("Content-Type", "application/json")
                self.send_header("Content-Length", str(len(resp)))
                self.end_headers()
                self.wfile.write(resp)
            except Exception as e:
                print(f"  [api] BFS failed: {e}")
                self.send_json_error(
                    500,
                    "BFS lookup failed. Check the seed label and database query syntax.",
                )

    socketserver.TCPServer.allow_reuse_address = True
    with socketserver.TCPServer(("", port), Handler) as httpd:
        url = f"http://localhost:{port}/"
        print(f"→ Visualisation at {url}")
        if initial_seed_id is not None:
            print(f"  initial seed: id={initial_seed_id} "
                  f"depth={initial_max_depth or 2}")
        webbrowser.open(url)
        try:
            httpd.serve_forever()
        except KeyboardInterrupt:
            print("\nShutting down…")


def main() -> None:
    parser = argparse.ArgumentParser(
        description="Visualise Teradata graph tables with cosmos.gl (Teradata-themed)"
    )
    parser.add_argument("mode", nargs="?", default="static",
                        choices=["static", "serve"],
                        help="'static' = one-shot HTML file (default); "
                             "'serve' = HTTP server with runtime BFS reload")
    parser.add_argument("--host", default=os.getenv("TD_HOST", "test-qjy3yjoejwmmt9rf.env.trial.teradata.com"))
    parser.add_argument("--user", default=os.getenv("TD_USER", "demo_user"))
    parser.add_argument("--password", default=os.getenv("TD_PASSWORD", "Test@123"))
    parser.add_argument("--logmech",  default=os.getenv("TD_LOGMECH", "TD2"))
    parser.add_argument("--database", default=os.getenv("TD_DATABASE", DEFAULT_DATABASE),
                        help="Database containing graph_nodes and graph_edges "
                             "(default: TD_DATABASE or Playpen)")
    parser.add_argument("--output",   default="graph_demo.html",
                        help="Output filename (static mode only)")
    parser.add_argument("--no-open",  action="store_true")
    parser.add_argument("--port",     type=int, default=8765,
                        help="HTTP port (serve mode, default 8765)")

    parser.add_argument("--seed-id",    type=int, default=None,
                        help="Seed node_id for BFS. "
                             "Without this (or --seed-label), fetches the full graph.")
    parser.add_argument("--seed-label", default=None,
                        help="Seed node label for BFS (resolved via SQL lookup).")
    parser.add_argument("--max-depth",  type=int, default=2,
                        help="BFS depth cap (1-6, default 2). Ignored without a seed.")

    args = parser.parse_args()

    missing = [k for k in ("host", "user", "password", "database") if not getattr(args, k)]
    if missing:
        sys.exit("Missing connection details: " + ", ".join(missing) +
                 "\nProvide via flags or env vars: TD_HOST, TD_USER, TD_PASSWORD, TD_DATABASE")

    try:
        qualify_table(args.database, "graph_nodes")
    except ValueError as exc:
        sys.exit(f"Invalid --database value: {exc}")

    if args.max_depth < 1 or args.max_depth > 6:
        sys.exit("--max-depth must be between 1 and 6")

    # Resolve --seed-label up front, regardless of mode
    seed_id = args.seed_id
    if seed_id is None and args.seed_label:
        print(f"→ Resolving seed label '{args.seed_label}'…")
        with teradatasql.connect(host=args.host, user=args.user,
                                  password=args.password,
                                  logmech=args.logmech) as conn:
            seed_id = resolve_seed_label(conn, args.database, args.seed_label)
        if seed_id is None:
            sys.exit(f"No node found with label '{args.seed_label}'")
        print(f"  resolved to node_id={seed_id}")

    if args.mode == "serve":
        serve(args.host, args.user, args.password, args.logmech, args.database,
              args.port, seed_id, args.max_depth)
        return

    # static mode
    print(f"→ Connecting to {args.host} as {args.user} ({args.logmech}); database={args.database}…")
    with teradatasql.connect(host=args.host, user=args.user,
                              password=args.password,
                              logmech=args.logmech) as conn:
        if seed_id is not None:
            print(f"  BFS from node_id={seed_id}, max_depth={args.max_depth}…")
            data = fetch_bfs_subgraph(conn, args.database, seed_id, args.max_depth)
        else:
            print("  fetching full graph…")
            data = fetch_full_graph(conn, args.database)

    print(f"  fetched {len(data['nodes'])} nodes, {len(data['links'])} edges")
    out = Path(args.output).resolve()
    render_html(data, out)
    print(f"→ Wrote {out}")
    if not args.no_open:
        webbrowser.open(out.as_uri())
        print("  opened in browser")


if __name__ == "__main__":
    main()
