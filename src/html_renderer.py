"""HTML rendering for the Teradata graph explorer."""

from __future__ import annotations

import json
from pathlib import Path

from branding import brand_css, client_brand, load_brand_config
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
<title>Business Graph Discovery · __BRAND_NAME__</title>
<link rel="icon" href="__LOGO_URI__">
<link rel="preconnect" href="https://fonts.googleapis.com">
<link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>
<link rel="stylesheet"
      href="https://fonts.googleapis.com/css2?family=Inter:wght@300;400;500;600;700&display=swap">
<style>
__STYLE__
__BRAND_STYLE__
</style>
</head>
<body>

<div id="graph"></div>
<div id="labels"></div>
<nav id="bfs-breadcrumb" aria-label="Navigation trail"></nav>
<div id="graph-loading" role="status" aria-live="polite">
  <div class="spinner"></div>
  <div id="graph-loading-text">Centering graph...</div>
</div>
<div id="empty-state" class="panel" style="display: none;">
  <div class="empty-icon">→</div>
  <h2>Awaiting input</h2>
  <p>Find an entity on the right, then explore its relationship network.</p>
  <p>Or click <strong>Full graph</strong> to load every node and edge in <code>__DATABASE__</code>.</p>
</div>

<div id="info" class="panel">
  <img src="__LOGO_URI__" alt="__BRAND_NAME__">
  <div class="text">
    <h1>Business Graph Discovery</h1>
    <div class="stats"><span id="workspace-name">__DATABASE__</span> · <span id="stats">loading…</span></div>
    <div class="hint">Drag · Scroll to zoom · Hover for details · Double-click to drill · Right-click for filters</div>
  </div>
</div>

<div id="visual-controls" class="panel">
  <div class="visual-group visual-group-nodes">
    <h2>Nodes</h2>
    <div class="visual-item">
      <label for="sel-colorBy">Colour</label>
      <select id="sel-colorBy">
        <option value="community">Community</option>
        <option value="category">Category</option>
        <option value="role">Role</option>
      </select>
    </div>
    <label class="visual-check"><input id="chk-nodeLabels" type="checkbox"> Labels</label>
    <div class="visual-slider">
      <div class="field-head"><label for="s-sizeScale">Size</label><span class="val" id="v-sizeScale">0.30</span></div>
      <input id="s-sizeScale" type="range" min="0.3" max="3" step="0.05" value="0.3">
    </div>
    <div class="visual-slider">
      <div class="field-head"><label for="s-nodeOpacity">Opacity</label><span class="val" id="v-nodeOpacity">1.00</span></div>
      <input id="s-nodeOpacity" type="range" min="0.1" max="1" step="0.05" value="1">
    </div>
  </div>
  <div class="visual-separator"></div>
  <div class="visual-group visual-group-edges">
    <h2>Edges</h2>
    <label class="visual-check"><input id="chk-curved" type="checkbox" checked> Curved</label>
    <label class="visual-check"><input id="chk-arrows" type="checkbox"> Arrows</label>
    <label class="visual-check"><input id="chk-edgeLabels" type="checkbox"> Labels</label>
    <div class="visual-slider">
      <div class="field-head"><label for="s-widthScale">Width</label><span class="val" id="v-widthScale">1.00</span></div>
      <input id="s-widthScale" type="range" min="0.3" max="3" step="0.05" value="1">
    </div>
    <div class="visual-slider">
      <div class="field-head"><label for="s-edgeOpacity">Opacity</label><span class="val" id="v-edgeOpacity">1.00</span></div>
      <input id="s-edgeOpacity" type="range" min="0" max="1" step="0.05" value="1">
    </div>
  </div>
</div>
<div id="legend" class="panel">
  <h2 id="legend-heading">Communities</h2>
  <div id="legend-rows"></div>
</div>

<div id="sql-pane" style="display: none;">
  <div id="sql-pane-head">
    <strong>Validation SQL</strong>
    <span id="sql-pane-scope"></span>
    <span id="sql-pane-actions">
      <button id="btn-sql-copy" type="button">Copy</button>
      <button id="btn-sql-close" type="button">Close</button>
    </span>
  </div>
  <pre id="sql-pane-code"><code></code></pre>
</div>

<aside id="controls">

  <section>
    <h2>Find Entity</h2>
    <div id="bfs-status">
      <span id="bfs-mode">full graph</span>
      <span id="bfs-stats"></span>
    </div>
    <div class="field entity-find-field">
      <div class="field-head"><label for="search-input">Entity</label></div>
      <input id="search-input" type="text" placeholder="Customer, account, transaction, merchant..." autocomplete="off">
    </div>
    <div class="field entity-find-field">
      <div class="field-head"><label for="edge-search-input">Relationship</label></div>
      <input id="edge-search-input" type="text" placeholder="launders · strong · &gt;0.7" autocomplete="off">
    </div>
    <div id="edge-search-results"></div>
    <div id="edge-search-status"></div>
    <div class="field">
      <div class="field-head"><label for="bfs-depth">Relationship depth</label>
                              <span class="val" id="v-bfs-depth">2</span></div>
      <input id="bfs-depth" type="range" min="1" max="6" step="1" value="2">
    </div>
    <div class="btn-row">
      <button id="btn-bfs-run" class="primary">Explore</button>
      <button id="btn-bfs-reset">Full graph</button>
    </div>
    <div class="search-range" aria-label="Find by entity importance range">
      <label>Importance</label>
      <input id="search-importance-min" type="number" min="0" max="1" step="0.05" placeholder="min">
      <span>to</span>
      <input id="search-importance-max" type="number" min="0" max="1" step="0.05" placeholder="max">
    </div>
    <div class="search-filters" aria-label="Find by entity attributes">
      <select id="search-community" aria-label="Community filter"><option value="">Any community</option></select>
      <select id="search-category" aria-label="Category filter"><option value="">Any category</option></select>
      <select id="search-role" aria-label="Role filter"><option value="">Any role</option></select>
    </div>
    <div id="search-results"></div>
    <div id="search-status"></div>
    <div class="btn-row">
      <button id="btn-svg-export">Download SVG</button>
      <button id="btn-report-export">Download Report</button>
    </div>
    <div class="btn-row">
      <button id="btn-sql-view">View SQL</button>
    </div>
    <div id="bfs-error"></div>
  </section>

  <section>
    <h2 id="simulation-heading">Simulation</h2>
    <div class="row-h">
      <label for="sel-renderer">Renderer</label>
      <select id="sel-renderer">
        <option value="webgl">WebGL</option>
        <option value="canvas">Canvas</option>
      </select>
    </div>
    <div class="btn-row">
      <button id="btn-fit">Fit view</button>
      <button id="btn-pause" class="webgl-only">Pause</button>
    </div>
    <div class="btn-row">
      <button id="btn-restart" class="webgl-only">Restart</button>
      <button id="btn-reset" class="primary">Reset layout</button>
    </div>
    <div class="row-h">
      <label for="sel-layout">Layout</label>
      <select id="sel-layout">
        <option value="original">Original force</option>
        <option value="community">Community clusters</option>
        <option value="bfs">Relationship rings</option>
        <option value="category">Category columns</option>
        <option value="role">Role lanes</option>
        <option value="grid">Packed grid</option>
      </select>
    </div>
    <div class="field webgl-only">
      <div class="field-head"><label for="s-gravity">Gravity</label>
                              <span class="val" id="v-gravity">0.25</span></div>
      <input id="s-gravity" type="range" min="0" max="1" step="0.05" value="0.25">
    </div>
    <div class="field webgl-only">
      <div class="field-head"><label for="s-repulsion">Repulsion</label>
                              <span class="val" id="v-repulsion">1.00</span></div>
      <input id="s-repulsion" type="range" min="0" max="2" step="0.05" value="1">
    </div>
    <div class="field webgl-only">
      <div class="field-head"><label for="s-linkSpring">Link spring</label>
                              <span class="val" id="v-linkSpring">1.00</span></div>
      <input id="s-linkSpring" type="range" min="0" max="2" step="0.05" value="1">
    </div>
    <div class="field webgl-only">
      <div class="field-head"><label for="s-linkDistance">Link distance</label>
                              <span class="val" id="v-linkDistance">10</span></div>
      <input id="s-linkDistance" type="range" min="1" max="50" step="1" value="10">
    </div>
    <div class="field webgl-only">
      <div class="field-head"><label for="s-friction">Friction</label>
                              <span class="val" id="v-friction">0.85</span></div>
      <input id="s-friction" type="range" min="0.5" max="1" step="0.01" value="0.85">
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


def render_html(data: dict, output_path: Path, brand: dict | None = None) -> None:
    output_path.write_text(render_html_str(data, brand), encoding="utf-8")


def render_html_str(data: dict, brand: dict | None = None) -> str:
    """Same as render_html but returns the string (for the HTTP server)."""
    active_brand = brand or load_brand_config(None)
    payload_data = dict(data)
    payload_data["_brand"] = client_brand(active_brand)
    payload = json.dumps(payload_data, separators=(",", ":"), ensure_ascii=False)
    database = data.get("_database", DEFAULT_DATABASE)
    return (HTML_TEMPLATE
            .replace("__STYLE__", read_asset("graph.css"))
            .replace("__BRAND_STYLE__", brand_css(active_brand))
            .replace("__SCRIPT__", read_asset("graph.js"))
            .replace("__DATA__", payload)
            .replace("__DATABASE__", database)
            .replace("__BRAND_NAME__", active_brand["name"])
            .replace("__LOGO_URI__", active_brand.get("logo_uri") or TERADATA_LOGO_URI))
