document.body.classList.add('graph-pending');

function showGraphLoading(message = 'Centering graph...') {
  const overlay = document.getElementById('graph-loading');
  const text = document.getElementById('graph-loading-text');
  if (text) text.textContent = message;
  document.body.classList.add('graph-pending');
  if (overlay) overlay.classList.remove('hidden');
}

function hideGraphLoading() {
  const overlay = document.getElementById('graph-loading');
  document.body.classList.remove('graph-pending');
  if (overlay) overlay.classList.add('hidden');
}
showGraphLoading();
function showFatalError(message) {
  const e = document.getElementById('error');
  e.style.display = 'block';
  e.textContent = message;
}

const RENDERER_NOTICE_KEY = 'tera-graph-renderer-notice-seen-v1';
const RENDERER_MODE_KEY = 'tera-graph-renderer-mode-v1';
const requestedRenderer = sessionStorage.getItem(RENDERER_MODE_KEY) === 'canvas' ? 'canvas' : 'webgl';
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
const FORCE_CANVAS = requestedRenderer === 'canvas';
let Graph = null;
if (HAS_WEBGL && !FORCE_CANVAS) {
  try {
    ({ Graph } = await import('https://cdn.jsdelivr.net/npm/@cosmos.gl/graph@2/+esm'));
  } catch (err) {
    showRendererNotice(
      'Canvas fallback active: cosmos.gl could not be loaded. ' +
      'Right-click a node to drill-down into its subgraph.'
    );
  }
} else if (!HAS_WEBGL) {
  showRendererNotice(
    'Canvas fallback active: WebGL2 is unavailable in this browser session. ' +
    'Right-click a node to drill-down into its subgraph.'
  );
}

const data = __DATA__;
const BRAND = data._brand || {};
const BRAND_ACCENT = BRAND.accent || '#FF5F02';
const CSS_BACKGROUND = getComputedStyle(document.documentElement).getPropertyValue('--bg').trim();
const BRAND_BACKGROUND = CSS_BACKGROUND || BRAND.background || '#1F1F1F';
const N = data.nodes.length;
const L = data.links.length;
const idIndex = new Map(data.nodes.map((n, i) => [n.id, i]));

function nodeIndexById(value) {
  if (value == null || value === '') return null;
  if (idIndex.has(value)) return idIndex.get(value);
  const numeric = Number(value);
  if (Number.isFinite(numeric) && idIndex.has(numeric)) return idIndex.get(numeric);
  const text = String(value);
  if (idIndex.has(text)) return idIndex.get(text);
  return null;
}

function currentSeedNodeId() {
  if (data._seed_id != null) return data._seed_id;
  try {
    const value = new URLSearchParams(window.location.search).get('seed_id');
    return value == null ? null : value;
  } catch (_) {
    return null;
  }
}

// Resolved point index of the explored seed (or null). Declared here — not in
// the LABELS section — because rebuildPointColors() reads it during the initial
// render, which runs first. A `const` declared later would be in its temporal
// dead zone at that point and throw, aborting init and leaving the loading
// overlay stuck on "Centering graph...".
const seedIndex = nodeIndexById(currentSeedNodeId());

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
const PALETTE = (BRAND.palette && BRAND.palette.length)
  ? BRAND.palette
  : [
      '#FF5F02',  // Teradata Orange (primary)
      '#4A90E2',  // brand blue
      '#7ED321',  // brand green
      '#D8BFD8',  // brand lavender
      '#FFD93D',  // warm yellow
      '#22D3EE',  // cyan
      '#F472B6',  // pink
      '#FBBF24',  // amber
    ];
// Deterministic palette slot from the value's name, so a given community /
// category / role keeps the SAME colour across different subgraphs (navigating
// to another view must not reshuffle the palette).
function stableColorIndex(value) {
  const s = String(value);
  let h = 0;
  for (let i = 0; i < s.length; i++) h = (Math.imul(h, 31) + s.charCodeAt(i)) >>> 0;
  return h % PALETTE.length;
}
function buildColorMap(attr) {
  const values = [...new Set(data.nodes.map(n => n[attr]).filter(v => v != null))].sort();
  return { values,
           cmap: Object.fromEntries(values.map(v => [v, PALETTE[stableColorIndex(v)]])) };
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
const ORANGE_RGB = hexToRgb(BRAND_ACCENT);
const UPSTREAM_HEX = '#7ED321';
const UPSTREAM_RGB = hexToRgb(UPSTREAM_HEX);

function browserEventFromArgs(positionOrEvent, maybeEvent) {
  return maybeEvent || positionOrEvent || null;
}

// ---- application state ---- //
const UI_SETTINGS_KEY = 'tera-graph-ui-settings-v1';
const state = {
  sim:     { gravity: 0.25, repulsion: 1.0, linkSpring: 1.0,
             linkDistance: 10, friction: 0.85, decay: 2000 },
  nodes:   { colorBy: 'community', sizeScale: 0.3, opacity: 1.0 },
  edges:   { curved: true, arrows: false, widthScale: 1.0, opacity: 1.0 },
  layout:  { mode: 'original' },
  search:  { query: '', matches: new Set(), remote: [] },
  edgeSearch: { query: '', matches: new Set(), remote: [] },   // edge search: matching link indices + whole-DB results
  edgeSelect: { source: null, target: null, edges: new Set() },  // pinned source->target edge highlight (persists until cleared)
  focused:     null,                            // selected point index, or null
  pinnedLabel: null,                            // node index whose label is always visible (seed/focus)
  pinnedNodeLabels: new Set(),                  // node indices individually pinned via right-click
  pinnedEdgeLabels: new Set(),                  // link indices individually pinned via right-click
  hovered:     null,                            // hovered point index (transient)
  focusedEdge: null,                            // selected edge (link) index, or null
  hoveredEdge: null,                            // hovered edge index (transient)
  pairPick:    [],                              // up to 2 node indices (shift-click) to highlight the edges between
  pairEdges:   new Set(),                       // link indices connecting the picked pair
  trace:       null,                            // ancestor trace: { nodes:Set, edges:Set } of the in-view chain, or null
  labels:  { nodes: false, edges: false },
};

function loadUiSettings() {
  try {
    const saved = JSON.parse(sessionStorage.getItem(UI_SETTINGS_KEY) || '{}');
    if (saved.sim)    Object.assign(state.sim, saved.sim);
    if (saved.nodes)  Object.assign(state.nodes, saved.nodes);
    if (saved.edges)  Object.assign(state.edges, saved.edges);
    if (saved.layout) Object.assign(state.layout, saved.layout);
    if (saved.labels) Object.assign(state.labels, saved.labels);
  } catch (_) { /* keep defaults */ }
}

function saveUiSettings() {
  sessionStorage.setItem(UI_SETTINGS_KEY, JSON.stringify({
    sim: state.sim,
    nodes: state.nodes,
    edges: state.edges,
    layout: state.layout,
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

function groupedValues(attr) {
  const values = [...new Set(data.nodes.map(n => n[attr]).filter(v => v != null && v !== ''))].sort();
  return values.length ? values : ['all'];
}

function placeCommunityClusters() {
  const communities = groupedValues('community');
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

function placeByAttributeColumns(attr) {
  const groups = groupedValues(attr);
  const groupIndex = new Map(groups.map((v, i) => [v, i]));
  const buckets = groups.map(() => []);
  data.nodes.forEach((n, i) => buckets[groupIndex.get(n[attr]) ?? 0].push(i));

  const laneGap = attr === 'role' ? 260 : 300;
  const cell = N > 5000 ? 22 : 34;
  buckets.forEach((bucket, gi) => {
    const x0 = (gi - (groups.length - 1) / 2) * laneGap;
    const cols = Math.max(1, Math.ceil(Math.sqrt(bucket.length / 1.8)));
    bucket.forEach((nodeIndex, bi) => {
      const col = bi % cols;
      const row = Math.floor(bi / cols);
      const xJitter = (stableUnit((data.nodes[nodeIndex].id || nodeIndex) + 91) - 0.5) * cell * 0.45;
      const yJitter = (stableUnit((data.nodes[nodeIndex].id || nodeIndex) + 37) - 0.5) * cell * 0.45;
      pointPositions[nodeIndex * 2] = x0 + (col - (cols - 1) / 2) * cell + xJitter;
      pointPositions[nodeIndex * 2 + 1] = (row - bucket.length / Math.max(1, cols) / 2) * cell + yJitter;
    });
  });
}

function bfsLevels(seedIndex) {
  const levels = new Int16Array(N);
  levels.fill(-1);
  const q = [seedIndex];
  levels[seedIndex] = 0;
  for (let qi = 0; qi < q.length; qi++) {
    const current = q[qi];
    neighborOf.get(current).forEach(next => {
      if (levels[next] !== -1) return;
      levels[next] = levels[current] + 1;
      q.push(next);
    });
  }
  return levels;
}

function edgeDirectionLevels() {
  const anchor = data._seed_id != null ? idIndex.get(data._seed_id) : highlightKey();
  if (anchor == null || anchor === undefined || anchor < 0) return null;
  return bfsLevels(anchor);
}

function edgeIsUpstream(edgeIndex, levels) {
  if (!levels) return false;
  const e = data.links[edgeIndex];
  const s = idIndex.get(e.source);
  const t = idIndex.get(e.target);
  if (s == null || t == null) return false;
  const sourceLevel = levels[s];
  const targetLevel = levels[t];
  return sourceLevel >= 0 && targetLevel >= 0 && sourceLevel > targetLevel;
}

function edgeAccentRgb(edgeIndex, levels) {
  return edgeIsUpstream(edgeIndex, levels) ? UPSTREAM_RGB : ORANGE_RGB;
}

function placeBfsRings() {
  const seedIndex = idIndex.get(data._seed_id) ??
    data.nodes.reduce((best, _, i) => nodeDegrees[i] > nodeDegrees[best] ? i : best, 0);
  const levels = bfsLevels(seedIndex);
  const rings = new Map();
  for (let i = 0; i < N; i++) {
    const level = levels[i] < 0 ? 7 : Math.min(levels[i], 6);
    if (!rings.has(level)) rings.set(level, []);
    rings.get(level).push(i);
  }

  pointPositions[seedIndex * 2] = 0;
  pointPositions[seedIndex * 2 + 1] = 0;
  [...rings.entries()].forEach(([level, indexes]) => {
    if (level === 0) return;
    const radius = level === 7 ? 1560 : 130 + level * 210;
    indexes.forEach((nodeIndex, pos) => {
      const base = (Math.PI * 2 * pos) / Math.max(1, indexes.length);
      const angle = base + stableUnit((data.nodes[nodeIndex].id || nodeIndex) + level * 19) * 0.18;
      const jitter = (stableUnit((data.nodes[nodeIndex].id || nodeIndex) + 71) - 0.5) * 42;
      pointPositions[nodeIndex * 2] = Math.cos(angle) * (radius + jitter);
      pointPositions[nodeIndex * 2 + 1] = Math.sin(angle) * (radius + jitter);
    });
  });
}

function placePackedGrid() {
  const cols = Math.max(1, Math.ceil(Math.sqrt(N)));
  const cell = N > 5000 ? 18 : 28;
  data.nodes.forEach((n, i) => {
    const col = i % cols;
    const row = Math.floor(i / cols);
    const jitterX = (stableUnit((n.id || i) + 13) - 0.5) * cell * 0.35;
    const jitterY = (stableUnit((n.id || i) + 29) - 0.5) * cell * 0.35;
    pointPositions[i * 2] = (col - (cols - 1) / 2) * cell + jitterX;
    pointPositions[i * 2 + 1] = (row - Math.ceil(N / cols) / 2) * cell + jitterY;
  });
}

function seedPositions() {
  if (state.layout.mode === 'bfs' && N > 0) {
    placeBfsRings();
  } else if (state.layout.mode === 'category') {
    placeByAttributeColumns('category');
  } else if (state.layout.mode === 'role') {
    placeByAttributeColumns('role');
  } else if (state.layout.mode === 'grid') {
    placePackedGrid();
  } else {
    placeCommunityClusters();
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

// ---- edge highlight: which edges (if any) are the focal set ---- //
// Returns { edges: Set<linkIndex>|null, nodes: Set<nodeIndex>|null }. When
// non-null, the rebuild functions take an "edge-focused" path: only these
// edges stay accented, only their endpoint nodes stay coloured. Precedence:
// hovered edge (transient) > two-node pair pick > clicked edge.
function edgeHighlight() {
  if (state.hoveredEdge != null) {
    const e = data.links[state.hoveredEdge];
    return { edges: new Set([state.hoveredEdge]),
             nodes: new Set([idIndex.get(e.source), idIndex.get(e.target)]) };
  }
  // A live node hover always takes over so hovering gives immediate feedback,
  // even while a trace / pinned edge / search highlight is active. Returning
  // null lets the standard neighbourhood-hover path run; the persistent
  // highlight resumes the moment the cursor leaves the node.
  if (state.hovered != null) return { edges: null, nodes: null };
  // Pinned source->target selection wins over transient highlights and persists.
  if (state.edgeSelect.source != null && state.edgeSelect.target != null) {
    return { edges: state.edgeSelect.edges,
             nodes: new Set([state.edgeSelect.source, state.edgeSelect.target]) };
  }
  if (state.edgeSearch.matches.size) {
    // Edge search: highlight matching edges and their endpoints.
    const nodes = new Set();
    state.edgeSearch.matches.forEach((i) => {
      const e = data.links[i];
      nodes.add(idIndex.get(e.source));
      nodes.add(idIndex.get(e.target));
    });
    return { edges: state.edgeSearch.matches, nodes };
  }
  if (state.trace) {
    // Ancestor trace: highlight the in-view chain nodes and connecting edges.
    return { edges: state.trace.edges, nodes: state.trace.nodes };
  }
  if (state.pairPick.length >= 1) {
    // One picked so far: highlight just that node (dim the rest) as a "pick the
    // second" cue. Two picked: highlight the edges connecting them.
    return { edges: state.pairPick.length === 2 ? state.pairEdges : new Set(),
             nodes: new Set(state.pairPick) };
  }
  if (state.focusedEdge != null) {
    const e = data.links[state.focusedEdge];
    return { edges: new Set([state.focusedEdge]),
             nodes: new Set([idIndex.get(e.source), idIndex.get(e.target)]) };
  }
  return { edges: null, nodes: null };
}

// Recompute which links connect the currently picked pair (either direction).
function computePairEdges() {
  state.pairEdges = new Set();
  if (state.pairPick.length !== 2) return;
  const idA = data.nodes[state.pairPick[0]].id;
  const idB = data.nodes[state.pairPick[1]].id;
  data.links.forEach((e, i) => {
    if ((e.source === idA && e.target === idB) || (e.source === idB && e.target === idA)) {
      state.pairEdges.add(i);
    }
  });
}

// Shift-click a node to build the pair. Re-clicking a picked node removes it;
// a third pick drops the oldest. Clears node/edge focus so pair highlight owns
// the view. Returns the connecting-edge count once two are picked (else null).
function togglePairPick(index) {
  if (index == null) return null;
  const at = state.pairPick.indexOf(index);
  if (at !== -1) state.pairPick.splice(at, 1);
  else { state.pairPick.push(index); if (state.pairPick.length > 2) state.pairPick.shift(); }
  state.focusedEdge = null;
  state.focused = null;
  safeSetFocusedPoint(null);
  computePairEdges();
  rebuildPointColors();
  rebuildLinkColors();
  rebuildLinkWidths();
  return state.pairPick.length === 2 ? state.pairEdges.size : null;
}

function clearPairPick() {
  if (state.pairPick.length === 0) return;
  state.pairPick = [];
  state.pairEdges = new Set();
}

// ---- pinned source -> target edge selection ---- //
// Set from the node context menu. Once both endpoints are chosen the directed
// edge(s) stay highlighted until explicitly cleared (pill ×, Esc, menu, or a
// new search) — a plain click will NOT clear it.
function recomputeEdgeSelectEdges() {
  state.edgeSelect.edges = new Set();
  const { source, target } = state.edgeSelect;
  if (source == null || target == null) return;
  const sId = data.nodes[source].id;
  const tId = data.nodes[target].id;
  data.links.forEach((e, i) => {
    if (e.source === sId && e.target === tId) state.edgeSelect.edges.add(i);
  });
}

function setEdgeEndpoint(role, index) {
  if (index == null) return;
  // A pinned edge owns the highlight — drop the transient selections.
  clearEdgeSearch();
  clearPairPick();
  clearTrace();
  state.focusedEdge = null;
  state.edgeSelect[role] = index;
  const { source, target } = state.edgeSelect;
  if (source != null && target != null) {
    recomputeEdgeSelectEdges();
    state.focused = null;
    safeSetFocusedPoint(null);
    rebuildAllHighlights();
  } else {
    setFocused(index);           // mark the one chosen endpoint until the other is set
  }
  renderEdgeSelectPill();
}

function clearEdgeSelect() {
  const wasActive = state.edgeSelect.source != null || state.edgeSelect.target != null;
  state.edgeSelect = { source: null, target: null, edges: new Set() };
  if (edgeSelectPillEl) edgeSelectPillEl.style.display = 'none';
  if (wasActive) rebuildAllHighlights();
}

let edgeSelectPillEl = null;
function renderEdgeSelectPill() {
  const { source, target, edges } = state.edgeSelect;
  if (source == null && target == null) {
    if (edgeSelectPillEl) edgeSelectPillEl.style.display = 'none';
    return;
  }
  if (!edgeSelectPillEl) {
    edgeSelectPillEl = document.createElement('div');
    edgeSelectPillEl.style.cssText =
      'position:absolute;top:14px;left:50%;transform:translateX(-50%);z-index:8;' +
      'display:flex;align-items:center;gap:10px;background:rgba(15,23,42,.94);' +
      'color:#e2e8f0;border:1px solid rgba(148,163,184,.35);border-radius:999px;' +
      'padding:6px 8px 6px 14px;font:13px/1.4 Inter,-apple-system,sans-serif;' +
      'box-shadow:0 4px 16px rgba(0,0,0,.4);max-width:80%;';
    div.appendChild(edgeSelectPillEl);
  }
  const nameOf = (i) => (i == null ? '…' : (data.nodes[i].label || `#${data.nodes[i].id}`));
  let text;
  if (source != null && target != null) {
    text = edges.size
      ? `Edge: ${nameOf(source)} → ${nameOf(target)}`
      : `No direct edge: ${nameOf(source)} → ${nameOf(target)}`;
  } else if (source != null) {
    text = `Source: ${nameOf(source)} · right-click a node → Set as target`;
  } else {
    text = `Target: ${nameOf(target)} · right-click a node → Set as source`;
  }
  edgeSelectPillEl.innerHTML = '';
  const label = document.createElement('span');
  label.textContent = text;
  label.style.cssText = 'overflow:hidden;text-overflow:ellipsis;white-space:nowrap;';
  const close = document.createElement('button');
  close.textContent = '×';
  close.title = 'Clear edge selection';
  close.style.cssText = 'background:rgba(148,163,184,.25);border:none;color:#e2e8f0;' +
    'width:22px;height:22px;border-radius:50%;cursor:pointer;font-size:15px;line-height:1;flex-shrink:0;';
  close.onclick = clearEdgeSelect;
  edgeSelectPillEl.append(label, close);
  edgeSelectPillEl.style.display = 'flex';
}

// Small transient message centred over the graph (e.g. pair-pick feedback).
let graphToastEl = null;
let graphToastTimer = null;
function showGraphToast(message) {
  if (!graphToastEl) {
    graphToastEl = document.createElement('div');
    graphToastEl.style.cssText =
      'position:absolute;top:14px;left:50%;transform:translateX(-50%);z-index:6;' +
      'pointer-events:none;background:rgba(15,23,42,.88);color:#e2e8f0;padding:7px 14px;' +
      'border-radius:6px;font:13px/1.4 Inter,-apple-system,sans-serif;max-width:80%;' +
      'box-shadow:0 2px 10px rgba(0,0,0,.35);opacity:0;transition:opacity .15s;';
    div.appendChild(graphToastEl);
  }
  graphToastEl.textContent = message;
  graphToastEl.style.opacity = '1';
  if (graphToastTimer) clearTimeout(graphToastTimer);
  graphToastTimer = setTimeout(() => { if (graphToastEl) graphToastEl.style.opacity = '0'; }, 2600);
}

// ---- ancestor trace ("search to the ultimate parent") ---- //
const PARENT_EDGE_TYPES = ['recruited', 'controls', 'employs'];

function clearTrace() {
  if (!state.trace) return;
  state.trace = null;
  if (ancestorPanelEl) ancestorPanelEl.style.display = 'none';
}

// Ask the server to walk upward from a node to its ultimate parent(s), then
// highlight the in-view chain and show the path. Needs serve mode (live DB).
async function traceToUltimateParent(index) {
  const node = data.nodes[index];
  if (!node) return;
  showGraphToast('Tracing to ultimate parent…');
  let result;
  try {
    const resp = await fetch('/api/ancestors', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ node_id: node.id, types: PARENT_EDGE_TYPES }),
    });
    if (!resp.ok) throw new Error('HTTP ' + resp.status);
    result = await resp.json();
  } catch (_) {
    showGraphToast('Ultimate-parent tracing needs the live server (serve mode).');
    return;
  }
  applyAncestorTrace(result);
}

function applyAncestorTrace(result) {
  const chain = result.chain || [];
  const nodes = new Set();
  const edges = new Set();
  chain.forEach((c) => {
    const idx = idIndex.get(c.node_id);
    if (idx != null) nodes.add(idx);
  });
  // Connecting edges present in the view: each step is parent(node_id) -> child(child_id).
  chain.forEach((c) => {
    if (c.child_id == null) return;
    data.links.forEach((e, i) => {
      if (e.source === c.node_id && e.target === c.child_id) edges.add(i);
    });
  });
  clearPairPick();
  state.focusedEdge = null;
  state.trace = { nodes, edges };
  rebuildPointColors();
  rebuildLinkColors();
  rebuildLinkWidths();
  renderAncestorPanel(result);
}

let ancestorPanelEl = null;
function renderAncestorPanel(result) {
  const chain = result.chain || [];
  const roots = result.roots || [];
  if (!ancestorPanelEl) {
    ancestorPanelEl = document.createElement('div');
    ancestorPanelEl.style.cssText =
      'position:absolute;top:14px;left:14px;z-index:7;max-width:320px;' +
      'background:rgba(15,23,42,.94);color:#e2e8f0;border:1px solid rgba(148,163,184,.35);' +
      'border-radius:8px;padding:12px 14px;font:13px/1.5 Inter,-apple-system,sans-serif;' +
      'box-shadow:0 4px 18px rgba(0,0,0,.4);';
    div.appendChild(ancestorPanelEl);
  }
  ancestorPanelEl.innerHTML = '';

  const head = document.createElement('div');
  head.style.cssText = 'display:flex;justify-content:space-between;align-items:center;margin-bottom:8px;';
  const h = document.createElement('strong');
  h.textContent = 'Ultimate parent';
  const close = document.createElement('button');
  close.textContent = '×';
  close.style.cssText = 'background:none;border:none;color:#94a3b8;font-size:18px;cursor:pointer;line-height:1;padding:0 2px;';
  close.onclick = () => { clearTrace(); setFocused(null); };
  head.append(h, close);
  ancestorPanelEl.appendChild(head);

  const rootNames = roots.map((r) => r.label + (r.role ? ` (${r.role})` : '')).join(', ');
  const rootLine = document.createElement('div');
  rootLine.style.cssText = 'margin-bottom:8px;';
  rootLine.innerHTML = roots.length
    ? `<span style="color:#7dd3fc;font-weight:700">${svgEscape(rootNames)}</span>` +
      `<span style="color:#94a3b8"> · ${chain.length - 1} level${chain.length - 1 === 1 ? '' : 's'} up</span>`
    : '<span style="color:#94a3b8">No parent found — this node is a root.</span>';
  ancestorPanelEl.appendChild(rootLine);

  // The chain, shallowest (picked node) to deepest (root).
  const list = document.createElement('div');
  list.style.cssText = 'border-top:1px solid rgba(148,163,184,.25);padding-top:8px;color:#cbd5e1;';
  chain.forEach((c) => {
    const row = document.createElement('div');
    const indent = '&nbsp;'.repeat(c.level * 2);
    const via = c.via_type ? `<span style="color:#64748b"> ·via ${svgEscape(c.via_type)}</span>` : '';
    const isRoot = roots.some((r) => r.node_id === c.node_id);
    const name = `<span style="${isRoot ? 'color:#7dd3fc;font-weight:700' : ''}">${svgEscape(c.label || ('#' + c.node_id))}</span>`;
    const role = c.role ? `<span style="color:#94a3b8"> ${svgEscape(c.role)}</span>` : '';
    row.innerHTML = `${indent}${c.level > 0 ? '↑ ' : ''}${name}${role}${via}`;
    list.appendChild(row);
  });
  ancestorPanelEl.appendChild(list);

  if (result.truncated) {
    const note = document.createElement('div');
    note.style.cssText = 'margin-top:6px;color:#f59e0b;font-size:12px;';
    note.textContent = 'Walk stopped at the depth cap; a deeper parent may exist.';
    ancestorPanelEl.appendChild(note);
  }

  if (roots.length) {
    const open = document.createElement('button');
    open.textContent = `Open ${roots[0].label} in graph`;
    open.style.cssText = 'margin-top:10px;width:100%;padding:6px 10px;border:none;border-radius:6px;' +
      'background:#2563eb;color:#fff;cursor:pointer;font:inherit;';
    open.onclick = () => navigateTo(roots[0].node_id, data._max_depth || 2,
      { label: (roots[0].label || 'Ultimate parent') + ' downline' });
    ancestorPanelEl.appendChild(open);
  }

  ancestorPanelEl.style.display = 'block';
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

  // Edge focus: keep only the highlighted edges' endpoint nodes
  const edgeKeep = edgeHighlight().nodes;

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

    if (seedIndex != null && i === seedIndex) {
      [outR, outG, outB] = ORANGE_RGB;
      alpha = 1;
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
  const ekSet = edgeHighlight().edges;
  const hi = highlightKey();
  const incident = (ekSet == null && hi != null) ? incidentOf.get(hi) : null;
  const directionLevels = edgeDirectionLevels();

  data.links.forEach((e, i) => {
    // Neutral by default; directional accent (green upstream / orange
    // downstream) is applied ONLY to highlighted edges — i.e. when hovering a
    // connected node or the edge, or under a pinned selection.
    let r = 1.0, g = 1.0, b = 1.0;                              // default white
    let alpha = 0.20 + (e.weight || 0.5) * 0.50;                // weight-derived

    if (ekSet != null) {
      // Edge focus: only the highlighted edges stay accented, all others nearly black
      if (ekSet.has(i)) {
        const accentRgb = edgeAccentRgb(i, directionLevels);
        r = accentRgb[0]; g = accentRgb[1]; b = accentRgb[2];
        alpha = 1.0;
      } else {
        r = g = b = 0.30;
        alpha = 0.04;
      }
    } else if (incident) {
      if (incident.has(i)) {
        // Incident edge -> upstream green or downstream accent, full alpha
        const accentRgb = edgeAccentRgb(i, directionLevels);
        r = accentRgb[0]; g = accentRgb[1]; b = accentRgb[2];
        alpha = 1.0;
      } else {
        // Non-incident -> flat dark grey, very dim
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
  const ekSet = edgeHighlight().edges;
  const hi = highlightKey();
  const incident = (ekSet == null && hi != null) ? incidentOf.get(hi) : null;
  data.links.forEach((e, i) => {
    let w = 0.8 + (e.weight || 0.5) * 2.2;
    if (ekSet != null) {
      if (ekSet.has(i)) w *= 2.5;                               // emphasise focal edge(s)
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
  const nativeArrows = isCanvasRenderer && state.edges.arrows;
  // When the WebGL arrow overlay is active it draws each edge itself (curve +
  // arrowhead). Cosmos must NOT also render its own link, or the two curves
  // bow differently and a single directed edge looks bidirectional.
  const overlayArrows = !isCanvasRenderer && state.edges.arrows;
  graph.setConfig({
    curvedLinks: state.edges.curved,
    linkArrows: nativeArrows,
    renderLinkArrows: nativeArrows,
    renderLinks: !overlayArrows,
  });
  syncArrowOverlay();
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
  reconcileHoverSoon();
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

// ---- hover reconciliation ----
// cosmos.gl's link mouse-out is unreliable (thin links, fast moves), so we
// verify the current hover geometrically on every move and drive the hide
// ourselves. Cheap: only the single hovered node/edge is tested.
let reconcileScheduled = false;
function reconcileHoverSoon() {
  if (reconcileScheduled || isCanvasRenderer) return;
  reconcileScheduled = true;
  requestAnimationFrame(() => { reconcileScheduled = false; updateHover(); });
}

// Generous pixel margin around an edge so it is easy to point at (cosmos's
// built-in link hover is pixel-tight). Distance is to the straight segment
// plus a bow-tolerant margin — the rendered curve's exact bend is unknown.
const EDGE_HOVER_PAD = 14;
function nearestEdgeIndex(px, py, positions, proj) {
  let best = null, bestD = Infinity;
  for (let i = 0; i < L; i++) {
    const e = data.links[i];
    const si = idIndex.get(e.source), ti = idIndex.get(e.target);
    if (si == null || ti == null) continue;
    const s = proj(si), t = proj(ti);
    if (!s || !t) continue;
    const dx = t[0] - s[0], dy = t[1] - s[1], len2 = dx * dx + dy * dy;
    let u = len2 ? ((px - s[0]) * dx + (py - s[1]) * dy) / len2 : 0;
    u = Math.max(0, Math.min(1, u));
    const d = Math.hypot(px - (s[0] + u * dx), py - (s[1] + u * dy));
    const width = Math.max(1, (linkWidths[i] || 1) * (state.edges.widthScale || 1));
    const bow = state.edges.curved ? Math.min(45, Math.sqrt(len2) * 0.1) : 0;
    if (d < bestD && d <= width / 2 + EDGE_HOVER_PAD + bow) { bestD = d; best = i; }
  }
  return best;
}

// Single mousemove-driven hover authority for BOTH nodes and edges. A node
// under the cursor always wins; otherwise the nearest edge within a generous
// threshold is used. Deterministic and independent of cosmos's pixel-tight
// hover callbacks (which are left unused). Only the single hovered node/edge
// changes trigger a rebuild.
function updateHover() {
  if (typeof graph.spaceToScreenPosition !== 'function') return;
  let positions;
  try { positions = graph.getPointPositions(); } catch (_) { return; }
  const count = data.nodes.length;
  if (!positions || positions.length < count * 2) return;
  const rect = div.getBoundingClientRect();
  const px = mouseX - rect.left, py = mouseY - rect.top;
  const inside = px >= 0 && py >= 0 && px <= rect.width && py <= rect.height;

  const projCache = new Array(count);
  const proj = (idx) => {
    if (projCache[idx] !== undefined) return projCache[idx];
    let p; try { p = graph.spaceToScreenPosition([positions[idx * 2], positions[idx * 2 + 1]]); } catch (_) { p = null; }
    return (projCache[idx] = p || null);
  };
  const radiusCache = new Map();

  let hoverNode = null, hoverEdge = null;
  if (inside) {
    let bestD = Infinity;
    for (let i = 0; i < count; i++) {
      const c = proj(i);
      if (!c) continue;
      const dx = c[0] - px, dy = c[1] - py, d2 = dx * dx + dy * dy;
      // Tight hit radius (≈ the visible dot, capped well below the arrow-overlay
      // estimate) so nodes don't capture the area around them and edges stay
      // hoverable right up to a node — including big hubs.
      const r = Math.min(webglNodeScreenRadius(i, positions, radiusCache), 16);
      if (d2 <= r * r && d2 < bestD) { bestD = d2; hoverNode = i; }
    }
    if (hoverNode == null) hoverEdge = nearestEdgeIndex(px, py, positions, proj);
  }

  const prevNode = state.hovered, prevEdge = state.hoveredEdge;
  let changed = false;
  if (hoverNode !== state.hovered) { state.hovered = hoverNode; changed = true; }
  if (hoverEdge !== state.hoveredEdge) { state.hoveredEdge = hoverEdge; changed = true; }
  if (changed) { rebuildPointColors(); rebuildLinkColors(); rebuildLinkWidths(); }

  if (hoverNode != null) { if (hoverNode !== prevNode) showTooltip(hoverNode); }
  else if (hoverEdge != null) { if (hoverEdge !== prevEdge) showEdgeTooltip(hoverEdge); }
  else hideTooltip();
}

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
    this.canvas.addEventListener('dblclick', (ev) => this.onDoubleClick(ev));
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
    if (this.config.onClick) this.config.onClick(i, undefined, ev);
  }

  onDoubleClick(ev) {
    ev.preventDefault();
    const i = this.pickPoint(ev);
    if (i != null && this.config.onPointDoubleClick) {
      this.config.onPointDoubleClick(i, ev);
    }
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
    ctx.fillStyle = this.config.backgroundColor || BRAND_BACKGROUND;
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
      const targetRadius = Math.max(2 / this.scale, (this.sizes[t] || 4) * (this.config.pointSizeScale || 1));
      const sourceRadius = Math.max(2 / this.scale, (this.sizes[s] || 4) * (this.config.pointSizeScale || 1));
      const straightAngle = Math.atan2(dy, dx);
      const startX = sx + Math.cos(straightAngle) * sourceRadius;
      const startY = sy + Math.sin(straightAngle) * sourceRadius;

      let endAngle = straightAngle;
      let endX = tx - Math.cos(endAngle) * targetRadius;
      let endY = ty - Math.sin(endAngle) * targetRadius;
      let cx = null, cy = null;

      if (this.config.curvedLinks) {
        const bend = 0.16;
        cx = (sx + tx) / 2 - dy * bend;
        cy = (sy + ty) / 2 + dx * bend;
        endAngle = Math.atan2(ty - cy, tx - cx);
        endX = tx - Math.cos(endAngle) * targetRadius;
        endY = ty - Math.sin(endAngle) * targetRadius;
      }

      ctx.beginPath();
      ctx.moveTo(startX, startY);
      if (this.config.curvedLinks) {
        ctx.quadraticCurveTo(cx, cy, endX, endY);
      } else {
        ctx.lineTo(endX, endY);
      }
      ctx.strokeStyle = stroke;
      ctx.lineWidth = width;
      ctx.stroke();

      if (this.config.linkArrows || this.config.renderLinkArrows) {
        const arrowLen = Math.max(7 / this.scale, 12 / this.scale);
        const arrowHalf = arrowLen * 0.48;
        const backX = endX - Math.cos(endAngle) * arrowLen;
        const backY = endY - Math.sin(endAngle) * arrowLen;
        const perpX = -Math.sin(endAngle) * arrowHalf;
        const perpY = Math.cos(endAngle) * arrowHalf;
        ctx.beginPath();
        ctx.moveTo(endX, endY);
        ctx.lineTo(backX + perpX, backY + perpY);
        ctx.lineTo(backX - perpX, backY - perpY);
        ctx.closePath();
        ctx.fillStyle = stroke;
        ctx.fill();
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
  backgroundColor: BRAND_BACKGROUND,
  spaceSize: 4096,
  pointSizeScale: state.nodes.sizeScale,
  linkWidthScale: state.edges.widthScale,
  pointOpacity:   state.nodes.opacity,
  linkOpacity:    state.edges.opacity,
  scalePointsOnZoom: true,
  renderLinks: true,
  curvedLinks: state.edges.curved,
  linkArrows: false,
  renderLinkArrows: false,

  fitViewOnInit: true,
  fitViewDelay: 500,
  fitViewPadding: 0.15,
  enableDrag: true,

  simulationGravity:      state.sim.gravity,
  simulationCenter:       0.35,
  simulationRepulsion:    state.sim.repulsion,
  simulationLinkSpring:   state.sim.linkSpring,
  simulationLinkDistance: state.sim.linkDistance,
  simulationFriction:     state.sim.friction,
  simulationDecay:        state.sim.decay,

  hoveredPointCursor: 'pointer',
  renderHoveredPointRing: true,
  hoveredPointRingColor: BRAND_ACCENT,
  focusedPointRingColor: BRAND_ACCENT,

  // Edge interaction (cosmos.gl v2.5+). When the loaded CDN version is
  // older these are silently ignored — graceful degradation; node
  // interaction continues to work either way.
  hoveredLinkCursor: 'pointer',
  // Do NOT set hoveredLinkColor / hoveredLinkWidthIncrease: cosmos renders a
  // hovered link in a separate pass whose curved-link control point flips
  // relative to the base draw, so the edge visibly swaps concave<->convex on
  // hover. We accent the hovered edge ourselves in the shared link buffer
  // (rebuildLinkColors) instead — same geometry, just recoloured.
  hoveredLinkColor: undefined,
  hoveredLinkWidthIncrease: 0,

  // In WebGL, node + edge hover are owned by our mousemove hit-test
  // (updateHover); cosmos's hover ring still renders for affordance. In the
  // Canvas fallback (no updateHover), these keep node hover working as before.
  onPointMouseOver: (index) => {
    if (!isCanvasRenderer || index == null) return;
    showTooltip(index);
    if (state.hovered !== index) {
      state.hovered = index;
      rebuildPointColors(); rebuildLinkColors(); rebuildLinkWidths();
    }
  },
  onPointMouseOut: () => {
    hideTooltip();
    if (isCanvasRenderer && state.hovered != null) {
      state.hovered = null;
      rebuildPointColors(); rebuildLinkColors(); rebuildLinkWidths();
    }
  },
  onClick: (index, positionOrEvent, maybeEvent) => {
    const ev = browserEventFromArgs(positionOrEvent, maybeEvent);
    hideNodeContextMenu();
    // Shift-click builds a two-node pick and highlights the edge(s) between them.
    if (ev && ev.shiftKey && index != null) {
      const connecting = togglePairPick(index);
      if (connecting != null) {
        showGraphToast(connecting > 0
          ? `${connecting} edge${connecting === 1 ? '' : 's'} highlighted between the two nodes`
          : 'No direct edge between the two nodes');
      } else if (state.pairPick.length === 1) {
        showGraphToast('Shift-click another node to highlight the connection');
      }
      return;
    }
    clearPairPick();
    clearTrace();
    clearEdgeSearch();
    if (state.focusedEdge != null) state.focusedEdge = null;
    setFocused(index ?? null);
  },
  onPointDoubleClick: (index, positionOrEvent, maybeEvent) => {
    const ev = browserEventFromArgs(positionOrEvent, maybeEvent);
    if (ev) ev.preventDefault();
    hideNodeContextMenu();
    drillIntoNode(index);
  },
  onPointContextMenu: (index, positionOrEvent, maybeEvent) => {
    const ev = browserEventFromArgs(positionOrEvent, maybeEvent);
    if (ev) ev.preventDefault();
    showNodeContextMenu(index, ev?.clientX ?? innerWidth / 2, ev?.clientY ?? innerHeight / 2);
  },

  // Edge hover is driven by our own mousemove hit-test (updateHover) with a
  // generous threshold — cosmos's pixel-tight link hover is left unused.
  onLinkMouseOver: () => {},
  onLinkMouseOut: () => {},
  onLinkClick: (linkIndex) => {
    // Clicking an edge clears any node focus and selects this edge
    if (state.focused != null) {
      state.focused = null;
      safeSetFocusedPoint(null);
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

const isCanvasRenderer = graph instanceof CanvasFallbackGraph;
const rendererSelect = document.getElementById('sel-renderer');
if (rendererSelect) {
  rendererSelect.value = isCanvasRenderer ? 'canvas' : 'webgl';
  rendererSelect.title = isCanvasRenderer
    ? 'Canvas renderer active. Switch to WebGL for larger graphs when available.'
    : 'WebGL renderer active. Switch to Canvas for compatibility/debugging.';
  rendererSelect.addEventListener('change', (ev) => {
    const mode = ev.target.value === 'canvas' ? 'canvas' : 'webgl';
    sessionStorage.setItem(RENDERER_MODE_KEY, mode);
    showGraphLoading(`Switching to ${mode === 'canvas' ? 'Canvas' : 'WebGL'}...`);
    window.location.reload();
  });
}
const arrowCanvas = document.createElement('canvas');
const arrowCtx = arrowCanvas.getContext('2d');
arrowCanvas.style.position = 'absolute';
arrowCanvas.style.inset = '0';
arrowCanvas.style.pointerEvents = 'none';
arrowCanvas.style.zIndex = '4';
arrowCanvas.style.display = 'none';
div.appendChild(arrowCanvas);
let arrowRafId = null;

function resizeArrowCanvas() {
  const rect = div.getBoundingClientRect();
  const ratio = Math.min(devicePixelRatio || 1, 2);
  arrowCanvas.width = Math.max(1, Math.floor(rect.width * ratio));
  arrowCanvas.height = Math.max(1, Math.floor(rect.height * ratio));
  arrowCanvas.style.width = rect.width + 'px';
  arrowCanvas.style.height = rect.height + 'px';
  arrowCtx.setTransform(ratio, 0, 0, ratio, 0, 0);
}

function projectToGraphPoint(spacePoint) {
  if (typeof graph.spaceToScreenPosition !== 'function') return null;
  const rect = div.getBoundingClientRect();
  try {
    const sp = graph.spaceToScreenPosition(spacePoint);
    if (!sp) return null;
    if (sp[0] >= -50 && sp[0] <= rect.width + 50 && sp[1] >= -50 && sp[1] <= rect.height + 50) return sp;
    return [sp[0] - rect.left, sp[1] - rect.top];
  } catch (_) {
    return null;
  }
}

function linkRgba(i) {
  const alpha = Math.max(0, Math.min(1, (linkColors[i * 4 + 3] ?? 1) * (state.edges.opacity ?? 1)));
  return `rgba(${Math.round((linkColors[i * 4] ?? 1) * 255)},` +
         `${Math.round((linkColors[i * 4 + 1] ?? 1) * 255)},` +
         `${Math.round((linkColors[i * 4 + 2] ?? 1) * 255)},${Math.max(0.28, alpha)})`;
}

function webglNodeScreenRadius(index, positions, radiusCache) {
  if (radiusCache.has(index)) return radiusCache.get(index);
  const sizeScale = Math.max(0.3, state.nodes.sizeScale || 1);
  const base = pointSizes[index] || 4;
  const x = positions[index * 2];
  const y = positions[index * 2 + 1];
  const centre = projectToGraphPoint([x, y]);
  const xStep = projectToGraphPoint([x + 1, y]);
  const yStep = projectToGraphPoint([x, y + 1]);
  const xScale = centre && xStep ? Math.hypot(xStep[0] - centre[0], xStep[1] - centre[1]) : 0;
  const yScale = centre && yStep ? Math.hypot(yStep[0] - centre[0], yStep[1] - centre[1]) : 0;
  const projected = base * sizeScale * Math.max(xScale, yScale);
  const estimated = base * (2.7 + sizeScale * 2.7);
  const radius = Math.max(10, Math.min(64, Number.isFinite(projected) && projected > 0 ? projected : estimated));
  radiusCache.set(index, radius);
  return radius;
}

function drawArrowOverlay() {
  if (isCanvasRenderer || !state.edges.arrows) return;
  resizeArrowCanvas();
  const rect = div.getBoundingClientRect();
  arrowCtx.clearRect(0, 0, rect.width, rect.height);
  let positions;
  try {
    positions = typeof graph.getPointPositions === 'function' ? graph.getPointPositions() : pointPositions;
  } catch (_) {
    positions = pointPositions;
  }
  if (!positions || positions.length < N * 2) return;

  const radiusCache = new Map();
  const maxArrows = Math.min(L, 60000);
  for (let i = 0; i < maxArrows; i++) {
    const s = linksArr[i * 2], t = linksArr[i * 2 + 1];
    if (s == null || t == null) continue;
    const source = projectToGraphPoint([positions[s * 2], positions[s * 2 + 1]]);
    const target = projectToGraphPoint([positions[t * 2], positions[t * 2 + 1]]);
    if (!source || !target) continue;
    const dx = target[0] - source[0];
    const dy = target[1] - source[1];
    const len = Math.hypot(dx, dy);
    if (len < 8) continue;

    let control = null;
    let sourceTangentX = dx;
    let sourceTangentY = dy;
    let targetTangentX = dx;
    let targetTangentY = dy;
    if (state.edges.curved) {
      const bend = 0.16;
      control = {
        x: (source[0] + target[0]) / 2 - dy * bend,
        y: (source[1] + target[1]) / 2 + dx * bend,
      };
      sourceTangentX = control.x - source[0];
      sourceTangentY = control.y - source[1];
      targetTangentX = target[0] - control.x;
      targetTangentY = target[1] - control.y;
    }

    const sourceTangentLen = Math.hypot(sourceTangentX, sourceTangentY);
    const targetTangentLen = Math.hypot(targetTangentX, targetTangentY);
    if (sourceTangentLen < 1 || targetTangentLen < 1) continue;
    const sux = sourceTangentX / sourceTangentLen;
    const suy = sourceTangentY / sourceTangentLen;
    const tux = targetTangentX / targetTangentLen;
    const tuy = targetTangentY / targetTangentLen;
    const sourceRadius = webglNodeScreenRadius(s, positions, radiusCache);
    const targetRadius = webglNodeScreenRadius(t, positions, radiusCache);
    const startX = source[0] + sux * (sourceRadius + 1);
    const startY = source[1] + suy * (sourceRadius + 1);
    const tipX = target[0] - tux * (targetRadius + 1);
    const tipY = target[1] - tuy * (targetRadius + 1);
    // Match the link colours: neutral unless the edge is highlighted (linkRgba
    // reflects the buffer set by rebuildLinkColors), not always-green upstream.
    const stroke = linkRgba(i);

    arrowCtx.beginPath();
    arrowCtx.moveTo(startX, startY);
    if (control) arrowCtx.quadraticCurveTo(control.x, control.y, tipX, tipY);
    else arrowCtx.lineTo(tipX, tipY);
    arrowCtx.strokeStyle = stroke;
    arrowCtx.lineWidth = Math.max(0.8, Math.min(5, (linkWidths[i] || 1) * (state.edges.widthScale || 1)));
    arrowCtx.lineCap = 'round';
    arrowCtx.stroke();

    const arrowLen = Math.max(8, Math.min(14, 7 + (linkWidths[i] || 1) * 1.2));
    const half = arrowLen * 0.48;
    const baseX = tipX - tux * arrowLen;
    const baseY = tipY - tuy * arrowLen;
    const px = -tuy * half;
    const py = tux * half;
    arrowCtx.beginPath();
    arrowCtx.moveTo(tipX, tipY);
    arrowCtx.lineTo(baseX + px, baseY + py);
    arrowCtx.lineTo(baseX - px, baseY - py);
    arrowCtx.closePath();
    arrowCtx.fillStyle = stroke;
    arrowCtx.fill();
  }
}

function startArrowOverlay() {
  if (isCanvasRenderer || !state.edges.arrows) return;
  arrowCanvas.style.display = 'block';
  if (arrowRafId != null) return;
  const tick = () => {
    drawArrowOverlay();
    arrowRafId = requestAnimationFrame(tick);
  };
  arrowRafId = requestAnimationFrame(tick);
}

function stopArrowOverlay() {
  if (arrowRafId != null) {
    cancelAnimationFrame(arrowRafId);
    arrowRafId = null;
  }
  arrowCtx.clearRect(0, 0, arrowCanvas.width, arrowCanvas.height);
  arrowCanvas.style.display = 'none';
}

function syncArrowOverlay() {
  if (!isCanvasRenderer && state.edges.arrows) startArrowOverlay();
  else stopArrowOverlay();
}

function safeSetFocusedPoint(index) {
  try {
    if (typeof graph.setFocusedPointByIndex === 'function') {
      graph.setFocusedPointByIndex(index == null ? undefined : index);
    } else if (index == null && typeof graph.unselectPoints === 'function') {
      graph.unselectPoints();
    } else if (index != null && typeof graph.selectPointByIndex === 'function') {
      graph.selectPointByIndex(index, true);
    }
  } catch (err) {
    console.warn('focus update failed:', err);
  }
}

function safeZoomToPoint(index, duration = 800, scale = 6) {
  try {
    if (typeof graph.zoomToPointByIndex === 'function') graph.zoomToPointByIndex(index, duration, scale, true);
  } catch (err) {
    console.warn('zoomToPointByIndex failed:', err);
  }
}

function screenPointCandidates(spacePoint) {
  if (typeof graph.spaceToScreenPosition !== 'function') return [];
  try {
    const sp = graph.spaceToScreenPosition(spacePoint);
    if (!sp) return [];
    const rect = div.getBoundingClientRect();
    return [sp, [sp[0] + rect.left, sp[1] + rect.top]];
  } catch (_) {
    return [];
  }
}

function pickPointFromEvent(ev) {
  let positions;
  try {
    positions = typeof graph.getPointPositions === 'function' ? graph.getPointPositions() : pointPositions;
  } catch (_) {
    positions = pointPositions;
  }
  if (!positions || positions.length < N * 2) return null;

  let best = null;
  let bestD = Infinity;
  for (let i = 0; i < N; i++) {
    const candidates = screenPointCandidates([positions[i * 2], positions[i * 2 + 1]]);
    for (const sp of candidates) {
      const dx = sp[0] - ev.clientX;
      const dy = sp[1] - ev.clientY;
      const d = dx * dx + dy * dy;
      if (d < bestD) { best = i; bestD = d; }
    }
  }
  const radius = 18;
  return bestD <= radius * radius ? best : null;
}

function pointIndexFromEvent(ev) {
  return pickPointFromEvent(ev) ?? state.hovered ?? state.focused;
}
// Nearest edge to the event position within the (generous) hover threshold.
function edgeIndexFromEvent(ev) {
  if (isCanvasRenderer || typeof graph.spaceToScreenPosition !== 'function') return null;
  let positions;
  try { positions = graph.getPointPositions(); } catch (_) { return null; }
  if (!positions) return null;
  const rect = div.getBoundingClientRect();
  const projCache = new Array(data.nodes.length);
  const proj = (idx) => {
    if (projCache[idx] !== undefined) return projCache[idx];
    let p; try { p = graph.spaceToScreenPosition([positions[idx * 2], positions[idx * 2 + 1]]); } catch (_) { p = null; }
    return (projCache[idx] = p || null);
  };
  return nearestEdgeIndex(ev.clientX - rect.left, ev.clientY - rect.top, positions, proj);
}
function handleGraphDoubleClick(ev) {
  ev.preventDefault();
  ev.stopPropagation();
  if (typeof ev.stopImmediatePropagation === 'function') ev.stopImmediatePropagation();
  const index = pointIndexFromEvent(ev);
  if (index == null) return;
  hideNodeContextMenu();
  drillIntoNode(index);
}
div.addEventListener('dblclick', handleGraphDoubleClick, { capture: true });
div.addEventListener('contextmenu', (ev) => {
  ev.preventDefault();
  // Precise node pick (no focus fallback) so an edge right-click isn't
  // mis-attributed to a focused node; fall back to the nearest edge.
  const nodeIdx = pickPointFromEvent(ev);
  if (nodeIdx != null) { showNodeContextMenu(nodeIdx, ev.clientX, ev.clientY); return; }
  const edgeIdx = edgeIndexFromEvent(ev);
  if (edgeIdx != null) showEdgeContextMenu(edgeIdx, ev.clientX, ev.clientY);
});
// Safety net: leaving the graph area always clears transient hover + tooltip.
div.addEventListener('mouseleave', () => {
  hideTooltip();
  if (state.hovered != null || state.hoveredEdge != null) {
    state.hovered = null;
    state.hoveredEdge = null;
    rebuildPointColors();
    rebuildLinkColors();
    rebuildLinkWidths();
  }
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
if (isCanvasRenderer) {
  document.body.classList.add('fallback-mode');
  const heading = document.getElementById('simulation-heading');
  if (heading) heading.textContent = 'Layout';
  graph.fitView();
  hideGraphLoading();
} else {
  pauseAndCentre(900);
}

// ============================================================ //
//                       FOCUS / SELECTION                      //
// ============================================================ //

function setFocused(i) {
  state.focused = (i == null) ? null : i;
  state.pinnedLabel = state.focused ?? seedIndex ?? null;
  safeSetFocusedPoint(state.focused);
  if (state.focused != null) setBfsSeedFromNode(state.focused);
  rebuildPointColors();
  rebuildLinkColors();
  rebuildLinkWidths();
  // Keep the projection loop alive for the found halo, and hide it at once on
  // clear so no stale frame lingers after the loop stops.
  if (state.focused == null || state.focused === seedIndex) {
    foundHaloEl.style.display = 'none';
  }
  syncLabelLoop();
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
      safeZoomToPoint(i, 800, 6);
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

function contextMenuSelect(id, labelText, options) {
  const field = document.createElement('div');
  field.className = 'field';

  const label = document.createElement('label');
  label.htmlFor = id;
  label.textContent = labelText;
  field.appendChild(label);

  const select = document.createElement('select');
  select.id = id;
  options.forEach(option => {
    const opt = document.createElement('option');
    opt.value = option.value;
    opt.textContent = option.label;
    if (option.filterValue != null) opt.dataset.filterValue = option.filterValue;
    select.appendChild(opt);
  });
  field.appendChild(select);
  nodeContextMenu.appendChild(field);
  return select;
}

function incidentEdgeTypes(index) {
  const types = new Set();
  (incidentOf.get(index) || new Set()).forEach(edgeIndex => {
    const type = data.links[edgeIndex]?.type;
    if (type != null && type !== '') types.add(type);
  });
  return [...types].sort();
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

  const nodeFilterSelect = contextMenuSelect(
    'context-node-filter',
    'Find actors by',
    [
      { value: 'community', label: 'Community', filterValue: node.community },
      { value: 'category', label: 'Category', filterValue: node.category },
      { value: 'role', label: 'Role', filterValue: node.role },
    ].filter(option => option.filterValue != null && option.filterValue !== '')
  );

  const relationshipOptions = [
    { value: '', label: 'Any relationship' },
    { value: 'strong', label: 'Strong relationships' },
    ...incidentEdgeTypes(index).map(type => ({
      value: 'edge_type',
      label: `Relationship type: ${type}`,
      filterValue: type,
    })),
  ];
  const edgeFilterSelect = contextMenuSelect(
    'context-edge-filter',
    'Relationship evidence',
    relationshipOptions
  );

  nodeContextMenu.appendChild(contextMenuButton('Drill investigation', () => {
    const nodeKey = nodeFilterSelect.value;
    const nodeValue = nodeFilterSelect.selectedOptions[0]?.dataset.filterValue;
    const edgeKey = edgeFilterSelect.value || undefined;
    const edgeValue = edgeFilterSelect.selectedOptions[0]?.dataset.filterValue;
    drillIntoNode(index, nodeKey, nodeValue, edgeKey, edgeValue);
  }));

  nodeContextMenu.appendChild(contextMenuButton('Trace to ultimate parent', () => {
    traceToUltimateParent(index);
  }));

  nodeContextMenu.appendChild(contextMenuButton(
    state.edgeSelect.source === index ? 'Set as edge source ✓' : 'Set as edge source',
    () => setEdgeEndpoint('source', index)));
  nodeContextMenu.appendChild(contextMenuButton(
    state.edgeSelect.target === index ? 'Set as edge target ✓' : 'Set as edge target',
    () => setEdgeEndpoint('target', index)));
  if (state.edgeSelect.source != null || state.edgeSelect.target != null) {
    nodeContextMenu.appendChild(contextMenuButton('Clear edge selection', clearEdgeSelect));
  }

  nodeContextMenu.appendChild(contextMenuButton(
    state.pinnedNodeLabels.has(index) ? 'Hide label' : 'Show label',
    () => toggleNodeLabel(index)));

  nodeContextMenu.style.left = Math.min(x, innerWidth - 250) + 'px';
  nodeContextMenu.style.top = Math.min(y, innerHeight - 160) + 'px';
  nodeContextMenu.style.display = 'block';
}

// Lightweight context menu for an edge (reuses the node menu container).
function showEdgeContextMenu(edgeIndex, x, y) {
  const e = data.links[edgeIndex];
  if (!e) return;
  setFocusedEdge(edgeIndex);
  const s = data.nodes[idIndex.get(e.source)];
  const t = data.nodes[idIndex.get(e.target)];
  nodeContextMenu.innerHTML = '';
  const title = document.createElement('div');
  title.className = 'title';
  title.textContent = `${s ? s.label : '#' + e.source} —${e.type || 'edge'}→ ${t ? t.label : '#' + e.target}`;
  nodeContextMenu.appendChild(title);
  nodeContextMenu.appendChild(contextMenuButton(
    state.pinnedEdgeLabels.has(edgeIndex) ? 'Hide label' : 'Show label',
    () => toggleEdgeLabel(edgeIndex)));
  nodeContextMenu.style.left = Math.min(x, innerWidth - 250) + 'px';
  nodeContextMenu.style.top = Math.min(y, innerHeight - 160) + 'px';
  nodeContextMenu.style.display = 'block';
}

addEventListener('click', (ev) => {
  if (!nodeContextMenu.contains(ev.target)) hideNodeContextMenu();
});
addEventListener('keydown', (ev) => {
  if (ev.key === 'Escape') {
    hideNodeContextMenu();
    if (state.edgeSelect.source != null || state.edgeSelect.target != null) {
      clearEdgeSelect();
    }
    if (state.pairPick.length > 0 || state.trace) {
      clearPairPick();
      clearTrace();
      setFocused(null);
    }
  }
});
let paused = !isCanvasRenderer;
const btnPause = document.getElementById('btn-pause');
if (paused) btnPause.textContent = 'Resume';

function pauseAndCentre(delay = 650, message = 'Centering graph...') {
  if (isCanvasRenderer) return;
  showGraphLoading(message);
  setTimeout(() => {
    graph.fitView(650);
    graph.pause();
    paused = true;
    btnPause.textContent = 'Resume';
    pokeRender();
    hideGraphLoading();
  }, delay);
}

document.getElementById('btn-fit').onclick = () => graph.fitView(750);
btnPause.onclick = () => {
  paused = !paused;
  if (paused) { graph.pause();    btnPause.textContent = 'Resume'; }
  else        { graph.start(0.3); btnPause.textContent = 'Pause';  }
};
document.getElementById('btn-restart').onclick = () => {
  paused = false; btnPause.textContent = 'Pause';
  graph.start(1.0);
  pauseAndCentre(1200, 'Restarting layout...');
};
function settleLayoutView({ fit = true, message = 'Applying layout...' } = {}) {
  showGraphLoading(message);
  requestAnimationFrame(() => {
    requestAnimationFrame(() => {
      if (fit) graph.fitView(750);
      graph.pause();
      paused = true;
      btnPause.textContent = 'Resume';
      pokeRender();
      hideGraphLoading();
    });
  });
}

function applyLayout({ fit = true } = {}) {
  const originalForce = state.layout.mode === 'original' && !isCanvasRenderer;
  showGraphLoading(originalForce ? 'Restoring original render...' : 'Applying layout...');
  if (!isCanvasRenderer) graph.pause();
  seedPositions();
  graph.setPointPositions(pointPositions);
  pokeRender();

  if (isCanvasRenderer) {
    if (fit) graph.fitView(750);
    hideGraphLoading();
    return;
  }

  if (originalForce) {
    paused = false;
    btnPause.textContent = 'Pause';
    graph.start(1.0);
    pauseAndCentre(1200, 'Restoring original render...');
    return;
  }

  settleLayoutView({ fit, message: 'Applying layout...' });
}
document.getElementById('btn-reset').onclick = () => applyLayout();

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

const layoutSelect = document.getElementById('sel-layout');
if (![...layoutSelect.options].some(opt => opt.value === state.layout.mode)) state.layout.mode = 'original';
layoutSelect.value = state.layout.mode;
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

layoutSelect.addEventListener('change', (ev) => {
  state.layout.mode = ev.target.value;
  applyLayout();
  saveUiSettings();
});

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

const searchInput         = document.getElementById('search-input');
const searchImportanceMin = document.getElementById('search-importance-min');
const searchImportanceMax = document.getElementById('search-importance-max');
const searchCommunity     = document.getElementById('search-community');
const searchCategory      = document.getElementById('search-category');
const searchRole          = document.getElementById('search-role');
const searchResults       = document.getElementById('search-results');
const searchStatus        = document.getElementById('search-status');
const searchAttributeSelects = [
  { el: searchCommunity, attr: 'community' },
  { el: searchCategory, attr: 'category' },
  { el: searchRole, attr: 'role' },
];

function populateSearchAttributeSelects() {
  searchAttributeSelects.forEach(({ el, attr }) => {
    colorMaps[attr].values.forEach((value) => {
      const option = document.createElement('option');
      option.value = value;
      option.textContent = value;
      el.appendChild(option);
    });
  });
}
populateSearchAttributeSelects();

function parseImportanceInput(input) {
  const raw = (input?.value || '').trim();
  if (!raw) return null;
  const value = Number(raw);
  if (!Number.isFinite(value)) return null;
  return Math.max(0, Math.min(1, value));
}

function currentImportanceRange() {
  let min = parseImportanceInput(searchImportanceMin);
  let max = parseImportanceInput(searchImportanceMax);
  if (min != null && max != null && min > max) [min, max] = [max, min];
  return { min, max, active: min != null || max != null };
}

function formatImportance(value) {
  return Number.isFinite(Number(value)) ? Number(value).toFixed(2) : 'n/a';
}

function currentAttributeFilters() {
  return searchAttributeSelects
    .map(({ el, attr }) => ({ attr, value: el.value }))
    .filter(({ value }) => value !== '');
}

function formatAttributeName(attr) {
  return attr.charAt(0).toUpperCase() + attr.slice(1);
}

function clearSearch() {
  searchInput.value = '';
  searchImportanceMin.value = '';
  searchImportanceMax.value = '';
  searchAttributeSelects.forEach(({ el }) => { el.value = ''; });
  state.pinnedLabel = seedIndex ?? null;
  runSearch('');
}

let searchRequestSeq = 0;
let searchTimerId = null;

function cancelServerSearch() {
  searchRequestSeq += 1;
  if (searchTimerId != null) {
    clearTimeout(searchTimerId);
    searchTimerId = null;
  }
}

function serverSearchPayload(rawQuery, range) {
  const payload = { query: rawQuery.trim(), limit: 8 };
  if (range.min != null) payload.importance_min = range.min;
  if (range.max != null) payload.importance_max = range.max;
  return payload;
}

async function fetchServerSearch(payload, requestId, suffix) {
  let resp;
  try {
    resp = await fetch('/api/search', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload),
    });
  } catch (_) {
    if (requestId === searchRequestSeq) {
      searchStatus.textContent = `Cannot reach ${window.location.host}. Is the Python server still running?`;
    }
    return;
  }

  if (requestId !== searchRequestSeq) return;
  if (!resp.ok) {
    searchStatus.textContent = `Find failed: ${resp.statusText}`;
    return;
  }

  const body = await resp.json();
  if (requestId !== searchRequestSeq) return;
  renderServerSearchResults(body.nodes || [], suffix);
}

function queueServerSearch(rawQuery, range, suffix) {
  cancelServerSearch();
  if (window.location.protocol === 'file:') {
    searchStatus.textContent = 'Server search needs the running Python server.';
    return;
  }

  const payload = serverSearchPayload(rawQuery, range);
  const requestId = searchRequestSeq;
  searchStatus.textContent = 'Finding entities...';
  searchTimerId = setTimeout(() => {
    searchTimerId = null;
    fetchServerSearch(payload, requestId, suffix);
  }, 220);
}

function openServerSearchNode(node) {
  if (!node) return;
  const depth = getBfsDepth();
  const label = node.label || `#${node.id}`;
  bfsSeedInput.value = `#${node.id} ${label}`;
  searchStatus.textContent = `Opening ${label} at depth ${depth}...`;
  navigateTo(node.id, depth, { label: label + ' depth ' + depth });
}

function renderServerSearchResults(nodes, suffix) {
  state.search.remote = nodes;
  searchResults.innerHTML = '';
  nodes.forEach((n) => {
    const item = document.createElement('div');
    item.className = 'item';
    item.innerHTML = `<span class="label">${n.label}</span>` +
                     `<span class="meta">${n.category} · ${n.community} · ${formatImportance(n.importance)}</span>`;
    item.onclick = () => openServerSearchNode(n);
    searchResults.appendChild(item);
  });

  if (nodes.length === 0) {
    searchStatus.textContent = `No database matches${suffix}`;
  } else if (nodes.length < 8) {
    searchStatus.textContent = `${nodes.length} database match${nodes.length === 1 ? '' : 'es'}${suffix}`;
  } else {
    searchStatus.textContent = `Showing 8 database matches${suffix}`;
  }
}

function runSearch(query) {
  const q = (query || '').trim().toLowerCase();
  const range = currentImportanceRange();
  const attributeFilters = currentAttributeFilters();
  state.search.query = q;
  state.search.remote = [];
  cancelServerSearch();
  searchResults.innerHTML = '';

  if (!q && !range.active && attributeFilters.length === 0) {
    state.search.matches = new Set();
    state.pinnedLabel = seedIndex ?? state.focused ?? null;
    searchStatus.textContent = '';
    rebuildPointColors();
    return;
  }

  clearEdgeSearch();          // node and edge search are mutually exclusive
  clearEdgeSelect();          // a new search deselects any pinned edge
  const matches = [];
  data.nodes.forEach((n, i) => {
    const labelOk = !q || (n.label && n.label.toLowerCase().includes(q));
    const importance = Number(n.importance ?? 0);
    const minOk = range.min == null || importance >= range.min;
    const maxOk = range.max == null || importance <= range.max;
    const attributesOk = attributeFilters.every(({ attr, value }) => n[attr] === value);
    if (labelOk && minOk && maxOk && attributesOk) matches.push(i);
  });

  if (range.active) {
    matches.sort((a, b) => Number(data.nodes[b].importance ?? 0) - Number(data.nodes[a].importance ?? 0));
  }
  state.search.matches = new Set(matches);

  matches.slice(0, 8).forEach(i => {
    const n = data.nodes[i];
    const item = document.createElement('div');
    item.className = 'item';
    item.innerHTML = `<span class="label">${n.label}</span>` +
                     `<span class="meta">${n.category} · ${n.community} · ${formatImportance(n.importance)}</span>`;
    item.onclick = () => focusOnNode(i);
    searchResults.appendChild(item);
  });

  const rangeText = range.active
    ? `importance ${range.min == null ? '0.00' : range.min.toFixed(2)}–${range.max == null ? '1.00' : range.max.toFixed(2)}`
    : '';
  const attributeText = attributeFilters.map(({ attr, value }) => `${formatAttributeName(attr)} ${value}`);
  const filterText = [rangeText, ...attributeText].filter(Boolean).join(' · ');
  const suffix = filterText ? ` · ${filterText}` : '';
  if (matches.length === 0) {
    if (q && attributeFilters.length === 0) {
      queueServerSearch(query || '', range, suffix);
    } else {
      searchStatus.textContent = `No matches${suffix}`;
    }
  } else if (matches.length <= 8) {
    searchStatus.textContent = `${matches.length} match${matches.length === 1 ? '' : 'es'}${suffix}`;
  } else {
    searchStatus.textContent = `Showing 8 of ${matches.length} matches${suffix}`;
  }

  rebuildPointColors();
  if (matches.length === 1) focusOnNode(matches[0]);
}

function focusFirstSearchMatch() {
  const first = [...state.search.matches][0];
  if (first != null) {
    focusOnNode(first);
    return;
  }
  if (state.search.remote.length > 0) {
    openServerSearchNode(state.search.remote[0]);
    return;
  }
  openSearchQueryAsSeed();
}

async function openSearchQueryAsSeed() {
  const raw = searchInput.value.trim();
  if (!raw) return;

  const range = currentImportanceRange();
  const attributeFilters = currentAttributeFilters();
  if (range.active || attributeFilters.length > 0) {
    searchStatus.textContent = 'No visible matches. Clear filters or choose a database result.';
    return;
  }

  if (window.location.protocol === 'file:') {
    searchStatus.textContent = 'Label lookup needs the running server.';
    return;
  }

  const depth = getBfsDepth();
  bfsSeedInput.value = raw;
  searchStatus.textContent = `Opening ${raw} at depth ${depth}...`;
  showGraphLoading('Resolving entity...');
  try {
    const result = await bfsResolveSeed({ seed_label: raw, max_depth: depth });
    if (result.seed_id == null) {
      searchStatus.textContent = 'No entity matched that label.';
      hideGraphLoading();
      return;
    }
    navigateTo(result.seed_id, depth, { label: raw + ' depth ' + depth });
  } catch (_) {
    hideGraphLoading();
  }
}

searchInput.addEventListener('input', (ev) => runSearch(ev.target.value));
searchInput.addEventListener('keydown', (ev) => {
  if (ev.key === 'Escape') {
    clearSearch();
    setFocused(null);
  } else if (ev.key === 'Enter') {
    ev.preventDefault();
    focusFirstSearchMatch();
  }
});
[searchImportanceMin, searchImportanceMax].forEach((input) => {
  input.addEventListener('input', () => runSearch(searchInput.value));
  input.addEventListener('keydown', (ev) => {
    if (ev.key === 'Escape') {
      clearSearch();
      setFocused(null);
    } else if (ev.key === 'Enter') {
      ev.preventDefault();
      focusFirstSearchMatch();
    }
  });
});

// ---- edge (relationship) search ---- //
// Matches on edge type, endpoint labels, strength band, or a weight predicate
// (">0.7", ">=0.5", "<0.3", or a bare number treated as >=). Highlights matches
// in the current view; if none, falls back to a whole-database lookup.
const edgeSearchInput   = document.getElementById('edge-search-input');
const edgeSearchResults = document.getElementById('edge-search-results');
const edgeSearchStatus  = document.getElementById('edge-search-status');

function parseWeightQuery(q) {
  const m = q.match(/^([<>]=?|=)?\s*(\d*\.?\d+)$/);
  if (!m) return null;
  const op = m[1] || '>=';
  const val = parseFloat(m[2]);
  if (!Number.isFinite(val)) return null;
  return (w) => {
    if (op === '>')  return w > val;
    if (op === '>=') return w >= val;
    if (op === '<')  return w < val;
    if (op === '<=') return w <= val;
    if (op === '=')  return Math.abs(w - val) < 1e-9;
    return w >= val;
  };
}

function edgeMatchesQuery(link, q, weightPred) {
  if ((link.type || '').toLowerCase().includes(q)) return true;
  if ((link.strength || '').toLowerCase().includes(q)) return true;
  const s = data.nodes[idIndex.get(link.source)];
  const t = data.nodes[idIndex.get(link.target)];
  if (s && (s.label || '').toLowerCase().includes(q)) return true;
  if (t && (t.label || '').toLowerCase().includes(q)) return true;
  if (weightPred && weightPred(link.weight || 0)) return true;
  return false;
}

function rebuildAllHighlights() {
  rebuildPointColors();
  rebuildLinkColors();
  rebuildLinkWidths();
}

function clearEdgeSearch() {
  state.edgeSearch = { query: '', matches: new Set(), remote: [] };
  if (edgeSearchInput && edgeSearchInput.value) edgeSearchInput.value = '';
  if (edgeSearchResults) edgeSearchResults.innerHTML = '';
  if (edgeSearchStatus) edgeSearchStatus.textContent = '';
}

let edgeSearchRemoteTimer = null;
function runEdgeSearch(query) {
  const q = String(query || '').trim().toLowerCase();
  state.edgeSearch.query = q;
  state.edgeSearch.remote = [];
  if (edgeSearchResults) edgeSearchResults.innerHTML = '';
  if (edgeSearchRemoteTimer) { clearTimeout(edgeSearchRemoteTimer); edgeSearchRemoteTimer = null; }
  if (!q) {
    state.edgeSearch.matches = new Set();
    if (edgeSearchStatus) edgeSearchStatus.textContent = '';
    rebuildAllHighlights();
    return;
  }
  // Edge search owns the highlight — clear conflicting node/pair/trace selections.
  clearSearch();
  clearPairPick();
  clearTrace();
  clearEdgeSelect();
  state.focusedEdge = null;

  const weightPred = parseWeightQuery(q);
  const matches = new Set();
  data.links.forEach((e, i) => { if (edgeMatchesQuery(e, q, weightPred)) matches.add(i); });
  state.edgeSearch.matches = matches;
  rebuildAllHighlights();

  if (matches.size > 0) {
    edgeSearchStatus.textContent =
      `${matches.size} relationship${matches.size === 1 ? '' : 's'} highlighted in view`;
    return;
  }
  edgeSearchStatus.textContent = 'No matches in view — searching database…';
  edgeSearchRemoteTimer = setTimeout(() => queryEdgeSearchRemote(q), 250);
}

async function queryEdgeSearchRemote(q) {
  if (window.location.protocol === 'file:') {
    edgeSearchStatus.textContent = 'No matches in view. Database search needs the running server.';
    return;
  }
  try {
    const resp = await fetch('/api/edge-search', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ query: q, limit: 12 }),
    });
    if (!resp.ok) throw new Error('HTTP ' + resp.status);
    const payload = await resp.json();
    renderEdgeSearchRemote(payload.edges || []);
  } catch (_) {
    edgeSearchStatus.textContent = 'No matches in view, and database search is unavailable.';
  }
}

function renderEdgeSearchRemote(edges) {
  state.edgeSearch.remote = edges;
  if (!edges.length) {
    edgeSearchStatus.textContent = 'No matching relationships found.';
    return;
  }
  edgeSearchStatus.textContent =
    `${edges.length} database match${edges.length === 1 ? '' : 'es'} (not in view) — open one:`;
  edgeSearchResults.innerHTML = '';
  edges.forEach((ed) => {
    const btn = document.createElement('button');
    btn.type = 'button';
    btn.className = 'search-result';
    btn.innerHTML =
      `<div class="er-main">${svgEscape(ed.source_label)}` +
      `<span class="er-arrow">&#8594;</span>${svgEscape(ed.target_label)}</div>` +
      `<div class="er-type">${svgEscape(ed.edge_type)}</div>`;
    btn.title = `${ed.source_label} ${ed.edge_type} ${ed.target_label}`;
    btn.onclick = () => {
      const depth = getBfsDepth();
      navigateTo(ed.source_id, depth, { label: `${ed.source_label} depth ${depth}` });
    };
    edgeSearchResults.appendChild(btn);
  });
}

if (edgeSearchInput) {
  edgeSearchInput.addEventListener('input', (ev) => runEdgeSearch(ev.target.value));
  edgeSearchInput.addEventListener('keydown', (ev) => {
    if (ev.key === 'Escape') { clearEdgeSearch(); rebuildAllHighlights(); }
  });
}
searchAttributeSelects.forEach(({ el }) => {
  el.addEventListener('change', () => runSearch(searchInput.value));
  el.addEventListener('keydown', (ev) => {
    if (ev.key === 'Escape') {
      clearSearch();
      setFocused(null);
    } else if (ev.key === 'Enter') {
      ev.preventDefault();
      focusFirstSearchMatch();
    }
  });
});

// ============================================================ //
//                           LABELS                             //
// ============================================================ //

const labelLayer = document.getElementById('labels');
const seedHaloEl = seedIndex == null ? null : document.createElement('div');
if (seedHaloEl) {
  seedHaloEl.className = 'seed-halo';
  seedHaloEl.title = 'Explored entity';
  labelLayer.appendChild(seedHaloEl);
}

// Halo that marks the currently found / selected entity. Positioned each
// frame in projectAndUpdateLabels(), toggled by setFocused().
const foundHaloEl = document.createElement('div');
foundHaloEl.className = 'found-halo';
foundHaloEl.title = 'Found entity';
labelLayer.appendChild(foundHaloEl);

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
  const pinnedLabel = state.pinnedLabel;

  if (seedHaloEl && seedIndex != null) {
    try {
      const sp = graph.spaceToScreenPosition([
        positions[seedIndex * 2],
        positions[seedIndex * 2 + 1],
      ]);
      if (sp) {
        seedHaloEl.style.display = 'block';
        seedHaloEl.style.transform = `translate(${sp[0]}px, ${sp[1]}px) translate(-50%, -50%)`;
      }
    } catch (_) { labelApiBroken = true; stopLabelLoop(); return; }
  }

  // Found/selected entity halo — suppressed when it coincides with the seed
  // (the SEED halo already marks that node).
  const foundIndex = state.focused;
  if (foundIndex != null && foundIndex !== seedIndex) {
    try {
      const sp = graph.spaceToScreenPosition([
        positions[foundIndex * 2],
        positions[foundIndex * 2 + 1],
      ]);
      if (sp) {
        foundHaloEl.style.display = 'block';
        foundHaloEl.style.transform = `translate(${sp[0]}px, ${sp[1]}px) translate(-50%, -50%)`;
      }
    } catch (_) { labelApiBroken = true; stopLabelLoop(); return; }
  } else {
    foundHaloEl.style.display = 'none';
  }

  for (let i = 0; i < N; i++) {
    const showThisLabel = showN || i === pinnedLabel || state.pinnedNodeLabels.has(i);
    nodeLabelEls[i].style.display = showThisLabel ? 'block' : 'none';
    if (!showThisLabel) continue;
    let sp;
    try {
      sp = graph.spaceToScreenPosition([positions[i * 2], positions[i * 2 + 1]]);
    } catch (_) { labelApiBroken = true; stopLabelLoop(); return; }
    if (!sp) continue;
    const isPinnedSeed = i === pinnedLabel && i === seedIndex;
    const labelOffset = isPinnedSeed
      ? 'translate(calc(-100% - 12px), calc(-100% - 12px))'
      : 'translate(-50%, calc(-100% - 10px))';
    nodeLabelEls[i].style.transform = `translate(${sp[0]}px, ${sp[1]}px) ${labelOffset}`;
  }
  for (let i = 0; i < L; i++) {
    const showThisEdge = showE || state.pinnedEdgeLabels.has(i);
    edgeLabelEls[i].style.display = showThisEdge ? 'block' : 'none';
    if (!showThisEdge) continue;
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

// The projection loop must run whenever anything it positions is on screen:
// a halo (seed or found), a pinned label, or the label overlays.
function labelLoopNeeded() {
  return seedIndex != null || state.focused != null || state.pinnedLabel != null
      || state.labels.nodes || state.labels.edges
      || state.pinnedNodeLabels.size > 0 || state.pinnedEdgeLabels.size > 0;
}
function syncLabelLoop() {
  if (labelLoopNeeded()) startLabelLoop();
  else stopLabelLoop();
}

function setNodeLabelsVisible(show) {
  state.labels.nodes = show;
  nodeLabelEls.forEach((el, i) => {
    el.style.display = (show || i === state.pinnedLabel || state.pinnedNodeLabels.has(i)) ? 'block' : 'none';
  });
  syncLabelLoop();
}
function setEdgeLabelsVisible(show) {
  state.labels.edges = show;
  edgeLabelEls.forEach((el, i) => {
    el.style.display = (show || state.pinnedEdgeLabels.has(i)) ? 'block' : 'none';
  });
  syncLabelLoop();
}

// Right-click label pinning for individual nodes / edges.
function toggleNodeLabel(i) {
  if (state.pinnedNodeLabels.has(i)) state.pinnedNodeLabels.delete(i);
  else state.pinnedNodeLabels.add(i);
  setNodeLabelsVisible(state.labels.nodes);   // re-applies display incl. pins, keeps loop in sync
}
function toggleEdgeLabel(i) {
  if (state.pinnedEdgeLabels.has(i)) state.pinnedEdgeLabels.delete(i);
  else state.pinnedEdgeLabels.add(i);
  setEdgeLabelsVisible(state.labels.edges);
}

document.getElementById('chk-nodeLabels').addEventListener('change', (ev) => {
  setNodeLabelsVisible(ev.target.checked);
  saveUiSettings();
});
document.getElementById('chk-edgeLabels').addEventListener('change', (ev) => {
  setEdgeLabelsVisible(ev.target.checked);
  saveUiSettings();
});
state.pinnedLabel = seedIndex ?? null;
setNodeLabelsVisible(state.labels.nodes);
setEdgeLabelsVisible(state.labels.edges);
syncLabelLoop();

// ============================================================ //
//                    ENTITY EXPLORATION RELOAD                 //
// ============================================================ //
//
// Wires the "Find Entity" section. When launched via
//   python teradata_cosmos_graph.py serve
// the embedded HTTP server resolves seed labels and re-fetches
// subgraphs on demand. The page reloads with new query-string
// parameters so the entire visualisation state is rebuilt cleanly.
// When opened directly as a static file, the buttons fall through
// with a friendly error.

const bfsSeedInput  = document.getElementById('bfs-seed') || searchInput;
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


function svgEscape(value) {
  return String(value ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&apos;');
}

function svgAttr(value) {
  return svgEscape(value);
}

function splitSvgLabel(label, maxChars = 26) {
  const words = String(label || '').split(/\s+/).filter(Boolean);
  const lines = [];
  let current = '';
  words.forEach((word) => {
    if (!current) current = word;
    else if ((current + ' ' + word).length <= maxChars) current += ' ' + word;
    else {
      lines.push(current);
      current = word;
    }
  });
  if (current) lines.push(current);
  return lines.length ? lines.slice(0, 2) : ['Unnamed node'];
}

function rectBoundaryPoint(source, target, inset = 4) {
  const dx = target.x - source.x;
  const dy = target.y - source.y;
  if (dx === 0 && dy === 0) return { x: source.x, y: source.y };
  const halfW = Math.max(1, source.w / 2 - inset);
  const halfH = Math.max(1, source.h / 2 - inset);
  const tx = Math.abs(dx) / halfW;
  const ty = Math.abs(dy) / halfH;
  const scale = 1 / Math.max(tx, ty);
  return { x: source.x + dx * scale, y: source.y + dy * scale };
}

function nodeExportLayout() {
  const exportSeedIndex = nodeIndexById(currentSeedNodeId()) ?? 0;
  const levels = bfsLevels(exportSeedIndex ?? 0);
  const buckets = new Map();
  for (let i = 0; i < N; i++) {
    const level = levels[i] < 0 ? 999 : levels[i];
    if (!buckets.has(level)) buckets.set(level, []);
    buckets.get(level).push(i);
  }
  const orderedLevels = [...buckets.keys()].sort((a, b) => a - b);
  const marginX = 72;
  const marginTop = 118;
  const columnGap = 285;
  const rowGap = 92;
  const nodesByIndex = new Map();
  let maxRows = 1;

  orderedLevels.forEach((level, levelPos) => {
    const indexes = buckets.get(level).sort((a, b) => {
      if (a === exportSeedIndex) return -1;
      if (b === exportSeedIndex) return 1;
      return String(data.nodes[a].label || '').localeCompare(String(data.nodes[b].label || ''));
    });
    maxRows = Math.max(maxRows, indexes.length);
    indexes.forEach((nodeIndex, row) => {
      const n = data.nodes[nodeIndex];
      const labelChars = Math.max(14, String(n.label || '').length);
      const w = Math.max(176, Math.min(280, labelChars * 7 + 48));
      const h = 66;
      const x = marginX + levelPos * columnGap;
      const y = marginTop + row * rowGap;
      nodesByIndex.set(nodeIndex, { index: nodeIndex, level, x, y, w, h });
    });
  });

  return {
    seedIndex: exportSeedIndex,
    levels: orderedLevels,
    nodesByIndex,
    width: Math.max(840, marginX * 2 + Math.max(1, orderedLevels.length - 1) * columnGap + 300),
    height: Math.max(520, marginTop + maxRows * rowGap + 88),
  };
}

function buildSubgraphSvg() {
  if (N === 0 || data._seed_id == null) {
    throw new Error('Open a seed subgraph before downloading SVG.');
  }

  const layout = nodeExportLayout();
  const { cmap } = colorMaps[state.nodes.colorBy];
  const accent = BRAND_ACCENT;
  const panel = 'rgba(255,255,255,0.96)';
  const title = `${BRAND.name || 'Graph'} subgraph: #${data._seed_id}`;
  const subtitle = `${N.toLocaleString()} nodes - ${L.toLocaleString()} edges - depth ${data._max_depth || ''}`;
  const parts = [];

  parts.push(`<?xml version="1.0" encoding="UTF-8"?>`);
  parts.push(`<svg xmlns="http://www.w3.org/2000/svg" width="${layout.width}" height="${layout.height}" viewBox="0 0 ${layout.width} ${layout.height}">`);
  parts.push(`<defs><style><![CDATA[
    .title{font:700 24px Inter,Arial,sans-serif;fill:#111827}.subtitle{font:500 13px Inter,Arial,sans-serif;fill:#4b5563}
    .level{font:700 11px Inter,Arial,sans-serif;fill:${accent};letter-spacing:.08em;text-transform:uppercase}
    .node-label{font:700 13px Inter,Arial,sans-serif;fill:#111827}.node-meta{font:500 11px Inter,Arial,sans-serif;fill:#4b5563}
    .edge-label{font:600 10px Inter,Arial,sans-serif;fill:#374151}.edge{fill:none;stroke-width:1.6;stroke-opacity:.72}
  ]]></style><marker id="arrow" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="7" markerHeight="7" orient="auto-start-reverse"><path d="M 0 0 L 10 5 L 0 10 z" fill="#8FA3B3"/></marker><marker id="arrow-upstream" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="7" markerHeight="7" orient="auto-start-reverse"><path d="M 0 0 L 10 5 L 0 10 z" fill="${UPSTREAM_HEX}"/></marker></defs>`);
  parts.push(`<text class="title" x="48" y="48">${svgEscape(title)}</text>`);
  parts.push(`<text class="subtitle" x="48" y="72">${svgEscape(subtitle)}</text>`);

  layout.levels.forEach((level, pos) => {
    const x = 72 + pos * 285;
    const label = level === 999 ? 'Other' : `Depth ${level}`;
    parts.push(`<text class="level" x="${x}" y="104">${svgEscape(label)}</text>`);
  });

  data.links.forEach((e, i) => {
    const sIdx = idIndex.get(e.source);
    const tIdx = idIndex.get(e.target);
    const source = layout.nodesByIndex.get(sIdx);
    const target = layout.nodesByIndex.get(tIdx);
    if (!source || !target) return;
    const start = rectBoundaryPoint(source, target);
    const end = rectBoundaryPoint(target, source);
    const sameLevel = source.level === target.level;
    let path;
    if (sameLevel) {
      const bend = Math.max(source.w, target.w) * 0.7;
      path = `M ${start.x.toFixed(1)} ${start.y.toFixed(1)} C ${(start.x + bend).toFixed(1)} ${(start.y - 28).toFixed(1)}, ${(end.x + bend).toFixed(1)} ${(end.y + 28).toFixed(1)}, ${end.x.toFixed(1)} ${end.y.toFixed(1)}`;
    } else {
      const midX = (start.x + end.x) / 2;
      path = `M ${start.x.toFixed(1)} ${start.y.toFixed(1)} C ${midX.toFixed(1)} ${start.y.toFixed(1)}, ${midX.toFixed(1)} ${end.y.toFixed(1)}, ${end.x.toFixed(1)} ${end.y.toFixed(1)}`;
    }
    const upstream = source.level > target.level && target.level !== 999;
    const edgeColour = upstream ? UPSTREAM_HEX : '#8FA3B3';
    const marker = upstream ? 'arrow-upstream' : 'arrow';
    parts.push(`<path class="edge" d="${path}" stroke="${edgeColour}" marker-end="url(#${marker})"/>`);
    if (state.labels.edges && e.type) {
      const labelX = ((start.x + end.x) / 2).toFixed(1);
      const labelY = ((start.y + end.y) / 2 - 4).toFixed(1);
      parts.push(`<text class="edge-label" x="${labelX}" y="${labelY}" text-anchor="middle">${svgEscape(e.type)}</text>`);
    }
  });

  layout.nodesByIndex.forEach((box, nodeIndex) => {
    const n = data.nodes[nodeIndex];
    const colour = cmap[n[state.nodes.colorBy]] || accent;
    const isSeed = nodeIndex === layout.seedIndex;
    const x = box.x - box.w / 2;
    const y = box.y - box.h / 2;
    const labelLines = splitSvgLabel(n.label);
    parts.push(`<rect x="${x.toFixed(1)}" y="${y.toFixed(1)}" width="${box.w}" height="${box.h}" rx="8" fill="${panel}" stroke="${svgAttr(isSeed ? '#FFFFFF' : colour)}" stroke-width="${isSeed ? 4 : 2}"/>`);
    parts.push(`<rect x="${x.toFixed(1)}" y="${y.toFixed(1)}" width="7" height="${box.h}" rx="4" fill="${svgAttr(colour)}"/>`);
    labelLines.forEach((line, lineNo) => {
      parts.push(`<text class="node-label" x="${(x + 18).toFixed(1)}" y="${(y + 24 + lineNo * 15).toFixed(1)}">${svgEscape(line)}</text>`);
    });
    const meta = `${n.category || 'Unknown'} - ${n.community || 'No community'} - ${n.role || 'No role'}`;
    parts.push(`<text class="node-meta" x="${(x + 18).toFixed(1)}" y="${(y + box.h - 12).toFixed(1)}">${svgEscape(meta)}</text>`);
    if (isSeed) {
      parts.push(`<text class="level" x="${(x + box.w - 44).toFixed(1)}" y="${(y + 18).toFixed(1)}">SEED</text>`);
    }
  });

  parts.push(`</svg>`);
  return parts.join('\n');
}

function downloadSubgraphSvg() {
  try {
    const svg = buildSubgraphSvg();
    const blob = new Blob([svg], { type: 'image/svg+xml;charset=utf-8' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `subgraph-${data._seed_id}-depth-${data._max_depth || 'x'}.svg`;
    document.body.appendChild(a);
    a.click();
    a.remove();
    URL.revokeObjectURL(url);
    bfsErr.textContent = '';
  } catch (err) {
    bfsErr.textContent = err.message || 'Could not export this subgraph.';
  }
}
function reportNodeName(node) {
  if (!node) return 'Unknown entity';
  const label = String(node.label || '').trim();
  return label || `#${node.id}`;
}

function reportEntityKind(node) {
  if (!node) return 'entity';
  return String(node.role || node.category || 'entity').trim() || 'entity';
}

function reportEntityPhrase(node) {
  const kind = reportEntityKind(node);
  if (!kind || kind.toLowerCase() === 'entity') return reportNodeName(node);
  return `${kind} ${reportNodeName(node)}`;
}

function reportPluralKind(kind) {
  const clean = String(kind || 'entity').trim();
  if (!clean || clean.toLowerCase() === 'entity') return 'entities';
  if (/entities$/i.test(clean)) return clean;
  if (/s$/i.test(clean)) return `${clean} entities`;
  return `${clean} entities`;
}

function reportRelation(edge) {
  const relation = String(edge && edge.type ? edge.type : '').trim();
  if (!relation) return 'is connected to';
  return relation.replace(/[_-]+/g, ' ').replace(/\s+/g, ' ').toLowerCase();
}

function reportSentence(sourceNode, edge, targetNode, includeTargetKind = false) {
  const target = includeTargetKind ? reportEntityPhrase(targetNode) : reportNodeName(targetNode);
  return `${reportEntityPhrase(sourceNode)} ${reportRelation(edge)} ${target}.`;
}

function reportList(names) {
  if (names.length <= 1) return names.join('');
  if (names.length === 2) return `${names[0]} and ${names[1]}`;
  return `${names.slice(0, -1).join(', ')}, and ${names[names.length - 1]}`;
}

function reportEdgesByDepth(levels) {
  const rows = [];
  data.links.forEach((edge) => {
    const sourceIndex = nodeIndexById(edge.source);
    const targetIndex = nodeIndexById(edge.target);
    if (sourceIndex == null || targetIndex == null) return;
    const sourceLevel = levels[sourceIndex];
    const targetLevel = levels[targetIndex];
    if (sourceLevel < 0 || targetLevel < 0) return;
    rows.push({
      edge,
      sourceIndex,
      targetIndex,
      depth: Math.max(sourceLevel, targetLevel),
      sourceLevel,
      targetLevel,
    });
  });
  return rows.sort((a, b) => {
    if (a.depth !== b.depth) return a.depth - b.depth;
    const sourceCmp = reportNodeName(data.nodes[a.sourceIndex]).localeCompare(reportNodeName(data.nodes[b.sourceIndex]));
    if (sourceCmp !== 0) return sourceCmp;
    return reportNodeName(data.nodes[a.targetIndex]).localeCompare(reportNodeName(data.nodes[b.targetIndex]));
  });
}

function reportWeight(value) {
  const num = Number(value);
  return Number.isFinite(num) ? num.toFixed(2) : '';
}

// Relations with a clean passive form, so upstream edges can read focus-first
// (e.g. "Henry Levy was recruited by Lily Martinez"). Anything not listed here
// falls back to active voice, which is always grammatical.
const UPSTREAM_PASSIVE = {
  'recruited': 'was recruited by',
  'owns': 'is owned by',
  'owned': 'was owned by',
  'controls': 'is controlled by',
  'controlled': 'was controlled by',
  'employs': 'is employed by',
  'employed': 'was employed by',
  'manages': 'is managed by',
  'managed': 'was managed by',
  'created': 'was created by',
  'funds': 'is funded by',
  'funded': 'was funded by',
  'directs': 'is directed by',
  'operates': 'is operated by',
};

// Plain-English reading of an upstream edge. Prefers a focus-first passive
// ("Henry Levy was recruited by Lily Martinez."); otherwise active voice
// ("Acct #446 transfers to Henry Levy.") — the source acts on the focus entity.
function reportUpstreamSentence(row, seedNode) {
  const sourceNode = data.nodes[row.sourceIndex];
  const relation = reportRelation(row.edge);
  const passive = UPSTREAM_PASSIVE[relation];
  if (passive) {
    return `${reportNodeName(seedNode)} ${passive} ${reportNodeName(sourceNode)}.`;
  }
  return `${reportNodeName(sourceNode)} ${relation} ${reportNodeName(seedNode)}.`;
}

function reportDetailRowHtml(row, focusIndex = null) {
  const sourceNode = data.nodes[row.sourceIndex];
  const targetNode = data.nodes[row.targetIndex];
  const upstream = focusIndex != null && row.targetIndex === focusIndex;
  return `<tr class="${upstream ? 'is-upstream' : ''}">` +
    `<td class="num">${row.depth}</td>` +
    `<td>${svgEscape(reportNodeName(sourceNode))}</td>` +
    `<td class="rel">${svgEscape(reportRelation(row.edge))}</td>` +
    `<td>${svgEscape(reportNodeName(targetNode))}</td>` +
    `<td class="num">${reportWeight(row.edge.weight)}</td>` +
    `<td>${svgEscape(row.edge.strength ?? '')}</td>` +
    `<td class="note">${upstream ? '&uarr; into focus' : ''}</td>` +
    `</tr>`;
}
function reportNarrativeGroups(levels) {
  const groups = new Map();
  reportEdgesByDepth(levels).forEach((row) => {
    if (row.targetLevel !== row.sourceLevel + 1) return;
    const targetNode = data.nodes[row.targetIndex];
    const kind = reportEntityKind(targetNode);
    const key = `${row.sourceIndex}|${reportRelation(row.edge)}|${kind}`;
    if (!groups.has(key)) {
      groups.set(key, {
        sourceIndex: row.sourceIndex,
        depth: row.targetLevel,
        relation: reportRelation(row.edge),
        kind,
        targets: [],
      });
    }
    groups.get(key).targets.push(targetNode);
  });
  return [...groups.values()].sort((a, b) => {
    if (a.depth !== b.depth) return a.depth - b.depth;
    return reportNodeName(data.nodes[a.sourceIndex]).localeCompare(reportNodeName(data.nodes[b.sourceIndex]));
  });
}

// Heading for a source entity in the narrative, e.g. "Lily Martinez (Lieutenant):".
function reportSourceHeading(sourceNode) {
  const name = reportNodeName(sourceNode);
  const kind = reportEntityKind(sourceNode);
  return kind && kind.toLowerCase() !== 'entity' ? `${name} (${kind}):` : `${name}:`;
}

// One relationship bullet under a source heading. A single target reads inline
// ("employs Forger Anton Sanchez."); multiple targets become a sub-list under
// "…the following <Kind> entities:" with a trailing Oxford-comma "and".
function reportRelationshipBullet(group) {
  if (group.targets.length === 1) {
    return `<li>${svgEscape(`${group.relation} ${reportEntityPhrase(group.targets[0])}.`)}</li>`;
  }
  const names = group.targets.map(reportNodeName).sort((a, b) => a.localeCompare(b));
  const head = `${group.relation} the following ${reportPluralKind(group.kind)}:`;
  const items = names.map((name, i) => {
    let connector = ',';
    if (i === names.length - 1) connector = '.';
    else if (i === names.length - 2) connector = names.length === 2 ? ' and' : ', and';
    return `<li>${svgEscape(name + connector)}</li>`;
  });
  return `<li>${svgEscape(head)}<ul class="rel-targets">${items.join('')}</ul></li>`;
}

// Build a Teradata query that lets an analyst manually validate every
// relationship in the report. Each traversed edge becomes one (source_id,
// target_id) predicate; joining graph_edges back to graph_nodes confirms the
// edge exists and resolves both node labels. Returns null if there is nothing
// to validate. REPORT_SQL_MAX_PAIRS bounds the generated SQL for large views.
const REPORT_SQL_MAX_PAIRS = 500;
function reportValidationSql(edgeRows) {
  const edgeTable = data._database ? `${data._database}.graph_edges` : 'graph_edges';
  const nodeTable = data._database ? `${data._database}.graph_nodes` : 'graph_nodes';

  const seen = new Set();
  const pairs = [];
  for (const row of edgeRows) {
    const sourceId = Number(data.nodes[row.sourceIndex]?.id);
    const targetId = Number(data.nodes[row.targetIndex]?.id);
    if (!Number.isFinite(sourceId) || !Number.isFinite(targetId)) continue;
    const key = `${sourceId}|${targetId}`;
    if (seen.has(key)) continue;
    seen.add(key);
    pairs.push([sourceId, targetId]);
  }
  if (pairs.length === 0) return null;

  const truncated = pairs.length > REPORT_SQL_MAX_PAIRS;
  const shown = truncated ? pairs.slice(0, REPORT_SQL_MAX_PAIRS) : pairs;
  const predicates = shown
    .map(([s, t], i) => `${i === 0 ? 'WHERE   ' : '   OR   '}(e.source_id = ${s} AND e.target_id = ${t})`)
    .join('\n');

  const note = truncated
    ? `-- NOTE: showing the first ${REPORT_SQL_MAX_PAIRS} of ${pairs.length} relationships.\n`
    : '';

  return (
    `${note}` +
    `/* Validation query: confirms every relationship in this report actually\n` +
    `   exists in ${edgeTable}. Each predicate below is one edge from the report;\n` +
    `   the joins verify it and resolve the node labels for eyeballing. */\n` +
    `SELECT  e.edge_id,\n` +
    `        e.source_id,\n` +
    `        s.node_label   AS source_label,\n` +
    `        e.edge_type,\n` +
    `        e.target_id,\n` +
    `        t.node_label   AS target_label,\n` +
    `        e.edge_weight,\n` +
    `        e.strength\n` +
    `FROM        ${edgeTable} AS e\n` +
    `INNER JOIN  ${nodeTable} AS s ON s.node_id = e.source_id\n` +
    `INNER JOIN  ${nodeTable} AS t ON t.node_id = e.target_id\n` +
    `${predicates}\n` +
    `ORDER BY    source_label, target_label;`
  );
}

function reportStyleSheet() {
  const accent = BRAND_ACCENT;
  return `
    :root { --accent: ${accent}; --ink: #1f2933; --muted: #6b7785;
            --line: #e2e8f0; --panel: #f8fafc; --up: #2f8f3f; }
    * { box-sizing: border-box; }
    body { margin: 0; padding: 40px 32px 64px;
           font: 15px/1.6 Inter, -apple-system, "Segoe UI", Roboto, Arial, sans-serif;
           color: var(--ink); background: #ffffff; }
    main { max-width: 960px; margin: 0 auto; }
    header { border-bottom: 3px solid var(--accent); padding-bottom: 20px; margin-bottom: 28px; }
    .brand { color: var(--accent); font-weight: 800; text-transform: uppercase;
             letter-spacing: .12em; font-size: 12px; }
    h1 { font-size: 26px; margin: 6px 0 18px; }
    h2 { font-size: 18px; margin: 34px 0 12px; padding-bottom: 6px;
         border-bottom: 1px solid var(--line); }
    h3 { font-size: 14px; margin: 20px 0 8px; color: var(--muted);
         text-transform: uppercase; letter-spacing: .06em; }
    .meta { display: grid; grid-template-columns: repeat(auto-fit, minmax(220px, 1fr));
            gap: 10px 28px; margin: 0; }
    .meta div { display: flex; flex-direction: column; }
    .meta .k { font-size: 11px; text-transform: uppercase; letter-spacing: .06em;
               color: var(--muted); font-weight: 700; }
    .meta .v { font-size: 15px; }
    .summary { background: var(--panel); border: 1px solid var(--line);
               border-radius: 10px; padding: 18px 22px; }
    .summary h2 { margin-top: 0; border: 0; padding: 0; }
    ul { margin: 8px 0; padding-left: 22px; }
    li { margin: 4px 0; }
    p { margin: 8px 0; }
    .muted { color: var(--muted); font-size: 13px; }
    .rel-source { font-weight: 700; margin: 16px 0 4px; }
    .rel-list { margin: 0 0 14px; }
    .rel-list > li { margin: 3px 0; }
    .rel-targets { list-style: circle; margin: 3px 0 6px; }
    pre.sql { background: #0f172a; color: #e2e8f0; border-radius: 8px;
              padding: 16px 18px; overflow-x: auto; font-size: 12.5px;
              line-height: 1.5; white-space: pre; }
    pre.sql code { font: inherit; }
    code { background: var(--panel); border: 1px solid var(--line);
           border-radius: 4px; padding: 1px 5px; font-size: 12.5px; }
    .table-wrap { overflow-x: auto; border: 1px solid var(--line); border-radius: 10px; }
    table { border-collapse: collapse; width: 100%; font-size: 14px; }
    th, td { text-align: left; padding: 9px 14px; border-bottom: 1px solid var(--line);
             white-space: nowrap; }
    th { background: var(--panel); font-size: 11px; text-transform: uppercase;
         letter-spacing: .05em; color: var(--muted); position: sticky; top: 0; }
    tbody tr:nth-child(even) { background: #fcfdfe; }
    tbody tr:last-child td { border-bottom: 0; }
    td.num { text-align: right; font-variant-numeric: tabular-nums; }
    td.rel { color: var(--accent); font-weight: 600; }
    td.note { color: var(--up); font-weight: 600; }
    tr.is-upstream { background: rgba(47, 143, 63, 0.06); }
    tr.is-upstream:nth-child(even) { background: rgba(47, 143, 63, 0.09); }
    .diagram { border: 1px solid var(--line); border-radius: 10px; padding: 12px;
               overflow-x: auto; background: var(--panel); }
    .diagram svg { max-width: 100%; height: auto; display: block; }
    footer { margin-top: 40px; padding-top: 16px; border-top: 1px solid var(--line);
             color: var(--muted); font-size: 12px; }
    @media print {
      body { padding: 0; } .summary, .table-wrap, .diagram { break-inside: avoid; }
      th { position: static; }
    }
  `;
}

function buildRelationshipReport() {
  if (N === 0 || data._seed_id == null) {
    throw new Error('Open an entity relationship view before downloading a report.');
  }

  const seedIndex = nodeIndexById(currentSeedNodeId());
  if (seedIndex == null) {
    throw new Error('The focused entity is not available in this graph view.');
  }

  const seedNode = data.nodes[seedIndex];
  const levels = bfsLevels(seedIndex);
  const edgeRows = reportEdgesByDepth(levels);
  const upstreamToFocusRows = edgeRows.filter((row) => row.targetIndex === seedIndex);
  const narrativeGroups = reportNarrativeGroups(levels);
  const generated = new Date().toLocaleString();
  const database = data._database || 'current database';
  const maxDepth = data._max_depth || Math.max(...levels.filter((level) => level >= 0));
  const brandName = BRAND.name || 'Graph';

  // Reusable prose for a narrative group (single target vs. list).
  const groupSentence = (group) => {
    const sourceNode = data.nodes[group.sourceIndex];
    const targetNames = group.targets.map(reportNodeName).sort((a, b) => a.localeCompare(b));
    if (targetNames.length === 1) {
      return reportSentence(sourceNode, { type: group.relation }, group.targets[0], true);
    }
    return `${reportNodeName(sourceNode)} ${group.relation} the following ` +
           `${reportPluralKind(group.kind)}: ${reportList(targetNames)}.`;
  };

  const out = [];
  out.push('<!doctype html><html lang="en"><head><meta charset="utf-8">');
  out.push('<meta name="viewport" content="width=device-width, initial-scale=1">');
  out.push(`<title>Relationship Report · #${svgEscape(seedNode.id)} · ${svgEscape(brandName)}</title>`);
  out.push(`<style>${reportStyleSheet()}</style></head><body><main>`);

  // Header + metadata
  out.push('<header>');
  out.push(`<div class="brand">${svgEscape(brandName)}</div>`);
  out.push('<h1>Relationship Investigation Report</h1>');
  out.push('<div class="meta">');
  out.push(`<div><span class="k">Focus entity</span><span class="v">${svgEscape(reportEntityPhrase(seedNode))} (#${svgEscape(seedNode.id)})</span></div>`);
  out.push(`<div><span class="k">Relationship depth</span><span class="v">${svgEscape(maxDepth)}</span></div>`);
  out.push(`<div><span class="k">Database</span><span class="v">${svgEscape(database)}</span></div>`);
  out.push(`<div><span class="k">Scope</span><span class="v">${N.toLocaleString()} entities · ${L.toLocaleString()} relationships</span></div>`);
  out.push(`<div><span class="k">Generated</span><span class="v">${svgEscape(generated)}</span></div>`);
  out.push('</div></header>');

  // Executive summary
  out.push('<section class="summary"><h2>Executive summary</h2>');
  out.push(`<p>${svgEscape(reportNodeName(seedNode))} is the focus entity for this relationship view. ` +
    `The current graph contains ${N.toLocaleString()} entities and ${L.toLocaleString()} ` +
    `relationships within depth ${svgEscape(maxDepth)}.</p>`);
  if (upstreamToFocusRows.length === 1) {
    out.push(`<p>${svgEscape(reportUpstreamSentence(upstreamToFocusRows[0], seedNode))}</p>`);
  } else if (upstreamToFocusRows.length > 1) {
    out.push(`<p>${upstreamToFocusRows.length.toLocaleString()} relationships point directly into ${svgEscape(reportNodeName(seedNode))}:</p><ul>`);
    upstreamToFocusRows.slice(0, 6).forEach((row) =>
      out.push(`<li>${svgEscape(reportUpstreamSentence(row, seedNode))}</li>`));
    out.push('</ul>');
    if (upstreamToFocusRows.length > 6) {
      out.push(`<p class="muted">…and ${(upstreamToFocusRows.length - 6).toLocaleString()} more, listed below.</p>`);
    }
  }
  if (narrativeGroups.length > 0) {
    out.push('<ul>');
    narrativeGroups.slice(0, 8).forEach((group) => out.push(`<li>${svgEscape(groupSentence(group))}</li>`));
    out.push('</ul>');
    if (narrativeGroups.length > 8) {
      out.push(`<p class="muted">A further ${(narrativeGroups.length - 8).toLocaleString()} relationship groups are listed below.</p>`);
    }
  }
  out.push('</section>');

  // Upstream relationships table
  if (upstreamToFocusRows.length > 0) {
    out.push(`<section><h2>Relationships into ${svgEscape(reportNodeName(seedNode))}</h2>`);
    out.push(`<p>These point directly at ${svgEscape(reportNodeName(seedNode))}:</p><ul>`);
    upstreamToFocusRows.forEach((row) =>
      out.push(`<li>${svgEscape(reportUpstreamSentence(row, seedNode))}</li>`));
    out.push('</ul>');
    out.push('<div class="table-wrap"><table><thead><tr>' +
      '<th class="num">Depth</th><th>Source</th><th>Relationship</th><th>Target</th>' +
      '<th class="num">Weight</th><th>Strength</th><th>Note</th></tr></thead><tbody>');
    upstreamToFocusRows.forEach((row) => out.push(reportDetailRowHtml(row, seedIndex)));
    out.push('</tbody></table></div></section>');
  }

  // Relationship narrative — grouped by source entity, split into Direct
  // (depth 1, i.e. the focus entity's own relationships) and Indirect (deeper).
  out.push('<section><h2>Relationship narrative</h2>');
  if (narrativeGroups.length === 0) {
    out.push('<p class="muted">No outward depth-by-depth relationship path was found in this view.</p>');
  } else {
    const buckets = [
      ['Direct Relationships', narrativeGroups.filter((group) => group.depth <= 1)],
      ['Indirect Relationships', narrativeGroups.filter((group) => group.depth >= 2)],
    ];
    buckets.forEach(([heading, groups]) => {
      if (groups.length === 0) return;
      out.push(`<h3>${heading}</h3>`);
      // Cluster this bucket's relationship groups under their source entity.
      const bySource = new Map();
      groups.forEach((group) => {
        if (!bySource.has(group.sourceIndex)) bySource.set(group.sourceIndex, []);
        bySource.get(group.sourceIndex).push(group);
      });
      bySource.forEach((sourceGroups, sourceIndex) => {
        out.push(`<p class="rel-source">${svgEscape(reportSourceHeading(data.nodes[sourceIndex]))}</p>`);
        out.push('<ul class="rel-list">');
        sourceGroups.forEach((group) => out.push(reportRelationshipBullet(group)));
        out.push('</ul>');
      });
    });
  }
  out.push('</section>');

  // Full relationship detail table
  out.push('<section><h2>Relationship detail</h2>');
  out.push('<div class="table-wrap"><table><thead><tr>' +
    '<th class="num">Depth</th><th>Source</th><th>Relationship</th><th>Target</th>' +
    '<th class="num">Weight</th><th>Strength</th><th>Note</th></tr></thead><tbody>');
  edgeRows.forEach((row) => out.push(reportDetailRowHtml(row, seedIndex)));
  out.push('</tbody></table></div></section>');

  // Validation SQL — lets the reader confirm every relationship against the
  // source database by hand.
  const validationSql = reportValidationSql(edgeRows);
  if (validationSql) {
    out.push('<section><h2>Validation SQL</h2>');
    out.push(`<p>Run this against <code>${svgEscape(database)}</code> to verify every relationship above directly from ` +
      '<code>graph_edges</code> / <code>graph_nodes</code>:</p>');
    out.push(`<pre class="sql"><code>${svgEscape(validationSql)}</code></pre>`);
    out.push('</section>');
  }

  // Inline diagram — strip the XML prolog so the SVG embeds cleanly in HTML.
  try {
    const svg = buildSubgraphSvg().replace(/^<\?xml[^>]*\?>\s*/, '');
    out.push(`<section><h2>Graph visualisation</h2><div class="diagram">${svg}</div></section>`);
  } catch (_) {
    // Diagram is best-effort; omit it rather than fail the whole report.
  }

  out.push(`<footer>Generated by ${svgEscape(brandName)} Graph Explorer · ${svgEscape(generated)}</footer>`);
  out.push('</main></body></html>');
  return out.join('\n');
}

function downloadRelationshipReport() {
  try {
    const report = buildRelationshipReport();
    const blob = new Blob([report], { type: 'text/html;charset=utf-8' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `relationship-report-${data._seed_id}-depth-${data._max_depth || 'x'}.html`;
    document.body.appendChild(a);
    a.click();
    a.remove();
    URL.revokeObjectURL(url);
    bfsErr.textContent = '';
  } catch (err) {
    bfsErr.textContent = err.message || 'Could not export this relationship report.';
  }
}

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
  // Only surface the trail bar once there is somewhere to navigate back to.
  bfsBreadcrumb.style.display = crumbs.length > 1 ? 'flex' : 'none';
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

  const svgExportButton = document.getElementById('btn-svg-export');
  if (svgExportButton) svgExportButton.disabled = seedId == null;
  const reportExportButton = document.getElementById('btn-report-export');
  if (reportExportButton) reportExportButton.disabled = seedId == null;

  if (isEmpty) {
    bfsStatusMode.textContent = 'no data';
    bfsStatusStat.textContent = 'find an entity →';
    document.getElementById('empty-state').style.display = 'block';
    document.getElementById('legend').style.display = 'none';
    document.getElementById('stats').textContent = '0 nodes · 0 edges';
    bfsSeedInput.focus();
    hideGraphLoading();
    return;
  }

  if (seedId != null) {
    bfsStatusMode.textContent = `relationships (depth ${data._max_depth})`;
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
  showGraphLoading(seedId != null ? 'Opening subgraph...' : 'Opening full graph...');
  saveUiSettings();
  // opts: { full: bool } — explicit "full graph" navigation
  const u = new URL(window.location.href);
  u.searchParams.delete('seed_id');
  u.searchParams.delete('max_depth');
  u.searchParams.delete('full');
  u.searchParams.delete('filter_key');
  u.searchParams.delete('filter_value');
  u.searchParams.delete('edge_filter_key');
  u.searchParams.delete('edge_filter_value');
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
  if (opts && opts.edgeFilterKey) {
    u.searchParams.set('edge_filter_key', opts.edgeFilterKey);
    if (opts.edgeFilterValue != null) {
      u.searchParams.set('edge_filter_value', opts.edgeFilterValue);
    }
  }
  if (opts && opts.label) queueNextCrumb(opts.label);
  window.location.href = u.toString();
}

function drillIntoNode(index, filterKey, filterValue, edgeFilterKey, edgeFilterValue) {
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
  const filterNames = { community: 'Community', category: 'Category', role: 'Role' };
  const edgeFilterNames = {
    edge_type: `relationship type (${edgeFilterValue})`,
    strong: 'strong relationships',
  };
  const filterLabel = filterKey ? ` same ${filterNames[filterKey] || filterKey} (${filterValue})` : '';
  const edgeLabel = edgeFilterKey ? ` via ${edgeFilterNames[edgeFilterKey] || edgeFilterKey}` : '';
  bfsErr.textContent = `Opening ${label}${filterLabel}${edgeLabel} at depth ${depth}...`;
  navigateTo(node.id, depth, {
    label: label + filterLabel + edgeLabel + ' depth ' + depth,
    filterKey,
    filterValue,
    edgeFilterKey,
    edgeFilterValue,
  });
}

document.getElementById('btn-bfs-run').onclick = async () => {
  const raw = bfsSeedInput.value.trim();
  if (!raw) {
    bfsErr.textContent = 'Enter an entity label or #id';
    return;
  }
  if (state.search.remote.length > 0) {
    openServerSearchNode(state.search.remote[0]);
    return;
  }
  const depth = getBfsDepth();
  const seedIdMatch = raw.match(/^#\s*(\d+)/);
  const payload = seedIdMatch
    ? { seed_id: parseInt(seedIdMatch[1], 10), max_depth: depth }
    : { seed_label: raw, max_depth: depth };
  showGraphLoading('Resolving entity...');
  try {
    const result = await bfsResolveSeed(payload);
    if (result.seed_id == null) {
      bfsErr.textContent = 'No entity matched that label.';
      hideGraphLoading();
      return;
    }
    navigateTo(result.seed_id, depth, { label: raw.replace(/^#\s*/, '#') + ' depth ' + depth });
  } catch (_) { hideGraphLoading(); /* error already shown */ }
};

document.getElementById('btn-bfs-reset').onclick = () => navigateTo(null, null, { full: true, label: 'Full graph' });
document.getElementById('btn-svg-export').onclick = downloadSubgraphSvg;
const reportButton = document.getElementById('btn-report-export');
if (reportButton) reportButton.onclick = downloadRelationshipReport;

// ---- Validation SQL pane ---- //
// Which edges the SQL covers: narrow to an active selection, else the whole view.
function currentSqlScope() {
  const rowsFrom = (linkIdxs) => [...linkIdxs].map((i) => ({
    sourceIndex: idIndex.get(data.links[i].source),
    targetIndex: idIndex.get(data.links[i].target),
  }));
  if (state.trace && state.trace.edges.size)
    return { rows: rowsFrom(state.trace.edges), label: 'ancestor trace' };
  if (state.pairPick.length === 2 && state.pairEdges.size)
    return { rows: rowsFrom(state.pairEdges), label: 'selected pair' };
  if (state.focusedEdge != null)
    return { rows: rowsFrom([state.focusedEdge]), label: 'focused relationship' };
  if (state.focused != null)
    return { rows: rowsFrom(incidentOf.get(state.focused) || new Set()),
             label: `relationships of ${data.nodes[state.focused].label || 'node'}` };
  return { rows: data.links.map((e) => ({
    sourceIndex: idIndex.get(e.source), targetIndex: idIndex.get(e.target),
  })), label: `current view · ${data.links.length} edge${data.links.length === 1 ? '' : 's'}` };
}

const sqlPane = document.getElementById('sql-pane');
function showSqlPane() {
  const { rows, label } = currentSqlScope();
  const sql = reportValidationSql(rows) || '-- No relationships in the current selection.';
  sqlPane.querySelector('#sql-pane-code code').textContent = sql;
  document.getElementById('sql-pane-scope').textContent = `Scope: ${label}`;
  sqlPane.style.display = 'flex';
}
document.getElementById('btn-sql-view').onclick = showSqlPane;
document.getElementById('btn-sql-close').onclick = () => { sqlPane.style.display = 'none'; };
document.getElementById('btn-sql-copy').onclick = async () => {
  const codeEl = sqlPane.querySelector('#sql-pane-code code');
  try {
    await navigator.clipboard.writeText(codeEl.textContent);
    showGraphToast('SQL copied to clipboard');
  } catch (_) {
    // Clipboard API can be blocked (file://); select the text for manual copy.
    const range = document.createRange();
    range.selectNodeContents(codeEl);
    const sel = getSelection();
    sel.removeAllRanges();
    sel.addRange(range);
    showGraphToast('Press Ctrl+C to copy');
  }
};

// Submit on Enter in the legacy seed input, if a template still provides one.
if (bfsSeedInput !== searchInput) {
  bfsSeedInput.addEventListener('keydown', (ev) => {
    if (ev.key === 'Enter') document.getElementById('btn-bfs-run').click();
  });
}
