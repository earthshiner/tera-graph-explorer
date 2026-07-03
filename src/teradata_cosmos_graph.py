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
import sys
import webbrowser
from pathlib import Path

try:
    import teradatasql
except ImportError:
    sys.exit("Missing dependency. Install with:  pip install teradatasql")


from graph_data import (
    DEFAULT_DATABASE,
    fetch_bfs_subgraph,
    fetch_full_graph,
    qualify_table,
    resolve_seed_label,
)
from html_renderer import render_html, render_html_str


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
