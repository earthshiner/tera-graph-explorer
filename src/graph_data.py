"""Teradata graph data access and validation helpers."""

from __future__ import annotations

import re


DEFAULT_DATABASE = "Playpen"
_IDENTIFIER_RE = re.compile(r"^[A-Za-z_][A-Za-z0-9_$#]*$")
FILTER_COLUMNS = {
    "community": "community",
    "category": "category",
    "role": "node_role",
}
EDGE_FILTER_KEYS = {"edge_type", "strong"}
STRONG_EDGE_WEIGHT = 0.70
QUERY_BAND_APP = "tera_graph_explorer"
QUERY_BAND_MAX_VALUE_LEN = 120


def query_band_value(value) -> str:
    """Return a compact value that is safe for a Teradata query band."""
    if value is None:
        return ""
    text = str(value).replace("'", "").replace(";", ",").replace("=", ":")
    text = " ".join(text.split())
    return text[:QUERY_BAND_MAX_VALUE_LEN]


def query_band_string(**pairs) -> str:
    """Build a Teradata query band string from non-empty key/value pairs."""
    band = {"app": QUERY_BAND_APP, **pairs}
    parts = []
    for key, value in band.items():
        safe_value = query_band_value(value)
        if safe_value:
            parts.append(f"{key}={safe_value}")
    return ";".join(parts) + ";"


def set_query_band(conn, **pairs) -> None:
    """Set session query band values for DBQL/audit traceability."""
    band = query_band_string(**pairs)
    with conn.cursor() as cur:
        cur.execute(f"SET QUERY_BAND = '{band}' FOR SESSION")


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


def validate_edge_filter(edge_filter_key: str | None) -> str | None:
    """Return a validated optional graph_edges filter key."""
    if not edge_filter_key:
        return None
    if edge_filter_key not in EDGE_FILTER_KEYS:
        raise ValueError("edge_filter_key must be one of: edge_type, strong")
    return edge_filter_key


def edge_filter_sql(alias: str, edge_filter_key: str | None,
                    edge_filter_value: str | None) -> tuple[str, tuple]:
    """Build SQL and params for an optional relationship filter."""
    key = validate_edge_filter(edge_filter_key)
    prefix = f"{alias}." if alias else ""
    if key == "edge_type":
        if edge_filter_value is None:
            raise ValueError("edge_filter_value is required for edge_type")
        return f" AND {prefix}edge_type = ?", (edge_filter_value,)
    if key == "strong":
        return f" AND {prefix}edge_weight >= ?", (STRONG_EDGE_WEIGHT,)
    return "", ()


def fetch_full_graph(conn, database: str) -> dict:
    """Pull every node and edge from the configured graph database."""
    node_table = qualify_table(database, "graph_nodes")
    edge_table = qualify_table(database, "graph_edges")
    set_query_band(conn, action="full_graph", graph_db=database)
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
                       filter_value: str | None = None,
                       edge_filter_key: str | None = None,
                       edge_filter_value: str | None = None) -> dict:
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
    bfs_edge_filter, bfs_edge_params = edge_filter_sql(
        "e", edge_filter_key, edge_filter_value
    )
    final_edge_filter, final_edge_params = edge_filter_sql(
        "", edge_filter_key, edge_filter_value
    )
    set_query_band(
        conn,
        action="bfs_subgraph",
        graph_db=database,
        seed_id=seed_id,
        max_depth=max_depth,
        node_filter_key=filter_key,
        node_filter_value=filter_value,
        edge_filter_key=edge_filter_key,
        edge_filter_value=edge_filter_value,
    )

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
        f"    WHERE b.depth < {int(max_depth)}"
        f"{bfs_edge_filter}\n"
        ")\n"
        "SELECT DISTINCT node_id FROM bfs"
    )

    with conn.cursor() as cur:
        cur.execute(bfs_sql, bfs_edge_params)
        visited_ids = {int(r[0]) for r in cur.fetchall()}

        if not visited_ids:
            return {
                "nodes": [], "links": [],
                "_seed_id": seed_id, "_max_depth": max_depth,
                "_total_nodes": 0, "_total_edges": 0,
                "_database": database,
                "_filter_key": filter_key, "_filter_value": filter_value,
                "_edge_filter_key": edge_filter_key,
                "_edge_filter_value": edge_filter_value,
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
                f"{final_edge_filter}",
                final_edge_params,
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
    out["_edge_filter_key"] = edge_filter_key
    out["_edge_filter_value"] = edge_filter_value
    return out


def resolve_seed_label(conn, database: str, label: str) -> "int | None":
    """Look up a node_id by exact-match node_label (first hit wins)."""
    node_table = qualify_table(database, "graph_nodes")
    set_query_band(conn, action="resolve_seed_label", graph_db=database)
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
