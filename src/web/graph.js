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
  layout:  { mode: 'community' },
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
function applyLayout({ fit = true, restart = true } = {}) {
  seedPositions();
  graph.setPointPositions(pointPositions);
  if (restart) {
    paused = false; btnPause.textContent = 'Pause';
    graph.start(1.0);
  } else {
    pokeRender();
  }
  if (fit) setTimeout(() => graph.fitView(750), 120);
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
if (![...layoutSelect.options].some(opt => opt.value === state.layout.mode)) state.layout.mode = 'community';
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
