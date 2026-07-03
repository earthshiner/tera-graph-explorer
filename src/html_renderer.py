"""HTML rendering for the Teradata graph explorer."""

from __future__ import annotations

import json
from pathlib import Path

from graph_data import DEFAULT_DATABASE


# Teradata "t." symbol logo, base64-encoded official asset
TERADATA_LOGO_URI = (
    "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAEAAAABVCAMAAADOrBLEAAAAIGNIUk0AAHomAACAhAAA+gAAAIDoAAB1MAAA6mAAADqYAAAXcJy6UTwAAAGbUExURf9fAgAAAP9fAv9fAv9fAv9fAv9fAv9fAv9fAv9fAv9fAv9fAv9fAv9fAv9fAv9fAv9fAv9fAv9fAv9fAv9fAv9fAv9fAv9fAv9fAv9fAv9fAv9fAv9fAv9fAv9fAv9fAv9fAv9fAv9fAv9fAv9fAv9fAv9fAv9fAv9fAv9fAv9fAv9fAv9fAv9fAv9fAv9fAv9fAv9fAv9fAv9fAv9fAv9fAv9fAv9fAv9fAv9fAv9fAv9fAv9fAv9fAv9fAv9fAv9fAv9fAv9fAv9fAv9fAv9fAv9fAv9fAv9fAv9fAv9fAv9fAv9fAv9fAv9fAv9fAv9fAv9fAv9fAv9fAv9fAv9fAv9fAv9fAv9fAv9fAv9fAv9fAv9fAv9fAv9fAv9fAv9fAv9fAv9fAv9fAv9fAv9fAv9fAv9fAv9fAv9fAv9fAv9fAv9fAv9fAv9fAv9fAv9fAv9fAv9fAv9fAv9fAv9fAv9fAv9fAv9fAv9fAv9fAv9fAv9fAv9fAv9fAv9fAv9fAv9fAv9fAv9fAv9fAv9fAv9fAv9fAv///3jJeXQAAACHdFJOUwAA4/Lx9HV8gggMBOHDxL0090PNnJ6YKgGB7pTktAfU3SD8YJ3GGf4QSfOtNgYDHk50g39kIdnqrlFBPT48I4na+u+4Uqr79vXtQNKTFGegDyfRd4jeMDkd2JBL+M4ib+nwUwJK0CbimQXoLna8ax8KK1iGyutCwS0sOkRMTRXnjBwW5ciKNyCa7VMAAAABYktHRIhrZhZaAAAACXBIWXMAAC4jAAAuIwF4pT92AAAAB3RJTUUH6gIDDSMcsQ7WtwAAAeNJREFUWMPt1tlbElEYBvCXMEhGssVwynIBCxBEMXQKynBDMAoqSElt0bKgXFpt07LM+bcdRpiGc0jOuaini/Nezjfze76zAo5Ym2py1AYLT9CkErELQAAC+E+AY80OOhLYgRYnleOtJziAejl5SgACEMC/B063naHiaucA7JDrhAuw8EQAAhCAAAQggL8MnAWXgHMk0MEJnCeBC518QBcJdPfwAa0k4PZwjQG9JKBevMQF2Lwk4HX5OHqAv49qwR0I9v+ZQGhgMDx0ORJ06O9geESlo1wJX43Grhm57qt6wOiN+Fi5z/GJyWbtKfqn1LpJTCd/JzVTASD7bxqvJNO3oOW22jjVv3mA37xvvJmsBtxp4QBG79bO1j0ZCLmYAcg5opC/r7UwqzADcwWykoO2LA+YgfkFsrJYXoiHi2wA8IiqWKFP7WNGwE5VvHpBjjxhA8JUZfpgbFJEYQAsWEqQlUJlfZefPmMBVp6TlRcwtnhHqjEgkYdfiRqHDsVYptQIQJC4AdNF06lF8eWr1ZL7EECb7rWk+blzvfbYAxuv37wNvMu/71sYS5hi/VAdaqfNtGCbH0HfG5Cl7MCnz1++bpkyv23cB9Kgs7Idv33f0T7n+xnSu/zhCcSVn7u/9vTx7wNeLG/Yd2GbHAAAAABJRU5ErkJggg=="
)


ASSET_DIR = Path(__file__).resolve().parent / "web"


def read_asset(name: str) -> str:
    """Read a bundled frontend asset for inlining into generated HTML."""
    return (ASSET_DIR / name).read_text(encoding="utf-8")


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
__STYLE__
</style>
</head>
<body>

<div id="graph"></div>
<div id="labels"></div>

<div id="empty-state" class="panel" style="display: none;">
  <div class="empty-icon">→</div>
  <h2>Awaiting input</h2>
  <p>Select a depth in the panel on the right, then right-click a node to drill down into its relationship neighbourhood.</p>
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
    <div class="row-h">
      <label for="sel-layout">Layout</label>
      <select id="sel-layout">
        <option value="community">Community clusters</option>
        <option value="bfs">BFS rings</option>
        <option value="category">Category columns</option>
        <option value="role">Role lanes</option>
        <option value="grid">Packed grid</option>
      </select>
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
__SCRIPT__
</script>
</body>
</html>
"""


def render_html(data: dict, output_path: Path) -> None:
    output_path.write_text(render_html_str(data), encoding="utf-8")


def render_html_str(data: dict) -> str:
    """Same as render_html but returns the string (for the HTTP server)."""
    payload = json.dumps(data, separators=(",", ":"), ensure_ascii=False)
    database = data.get("_database", DEFAULT_DATABASE)
    return (HTML_TEMPLATE
            .replace("__STYLE__", read_asset("graph.css"))
            .replace("__SCRIPT__", read_asset("graph.js"))
            .replace("__DATA__", payload)
            .replace("__DATABASE__", database)
            .replace("__LOGO_URI__", TERADATA_LOGO_URI))
