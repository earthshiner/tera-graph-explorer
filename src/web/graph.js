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
const BRAND_BACKGROUND = BRAND.background || '#00233C';
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
const ORANGE_RGB = hexToRgb(BRAND_ACCENT);

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
  const nativeArrows = isCanvasRenderer && state.edges.arrows;
  graph.setConfig({
    curvedLinks: state.edges.curved,
    linkArrows: nativeArrows,
    renderLinkArrows: nativeArrows,
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
    if (this.config.onClick) this.config.onClick(i);
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
  hoveredLinkColor: BRAND_ACCENT,
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
  const index = pointIndexFromEvent(ev);
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
  safeSetFocusedPoint(state.focused);
  if (state.focused != null) setBfsSeedFromNode(state.focused);
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
  showGraphLoading('Applying layout...');
  if (!isCanvasRenderer) graph.pause();
  seedPositions();
  graph.setPointPositions(pointPositions);
  pokeRender();

  if (isCanvasRenderer) {
    if (fit) graph.fitView(750);
    hideGraphLoading();
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
  runSearch('');
}

function runSearch(query) {
  const q = (query || '').trim().toLowerCase();
  const range = currentImportanceRange();
  const attributeFilters = currentAttributeFilters();
  state.search.query = q;
  searchResults.innerHTML = '';

  if (!q && !range.active && attributeFilters.length === 0) {
    state.search.matches = new Set();
    searchStatus.textContent = '';
    rebuildPointColors();
    return;
  }

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
    searchStatus.textContent = `No matches${suffix}`;
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
  if (first != null) focusOnNode(first);
}

searchInput.addEventListener('input', (ev) => runSearch(ev.target.value));
searchInput.addEventListener('keydown', (ev) => {
  if (ev.key === 'Escape') {
    clearSearch();
    setFocused(null);
  } else if (ev.key === 'Enter') {
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
      focusFirstSearchMatch();
    }
  });
});
searchAttributeSelects.forEach(({ el }) => {
  el.addEventListener('change', () => runSearch(searchInput.value));
  el.addEventListener('keydown', (ev) => {
    if (ev.key === 'Escape') {
      clearSearch();
      setFocused(null);
    } else if (ev.key === 'Enter') {
      focusFirstSearchMatch();
    }
  });
});

// ============================================================ //
//                           LABELS                             //
// ============================================================ //

const labelLayer = document.getElementById('labels');
const seedIndex = data._seed_id == null ? null : idIndex.get(data._seed_id);
const seedHaloEl = seedIndex == null ? null : document.createElement('div');
if (seedHaloEl) {
  seedHaloEl.className = 'seed-halo';
  seedHaloEl.title = 'Drill-down seed node';
  labelLayer.appendChild(seedHaloEl);
}

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
  if (seedHaloEl || state.labels.nodes || state.labels.edges) startLabelLoop();
  else stopLabelLoop();
}
function setEdgeLabelsVisible(show) {
  state.labels.edges = show;
  edgeLabelEls.forEach(el => el.style.display = show ? 'block' : 'none');
  if (seedHaloEl || state.labels.nodes || state.labels.edges) startLabelLoop();
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
if (seedHaloEl) startLabelLoop();

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
  const exportSeedIndex = data._seed_id == null ? 0 : idIndex.get(data._seed_id);
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
  const bg = BRAND_BACKGROUND;
  const panel = 'rgba(255,255,255,0.96)';
  const title = `${BRAND.name || 'Graph'} subgraph: #${data._seed_id}`;
  const subtitle = `${N.toLocaleString()} nodes - ${L.toLocaleString()} edges - depth ${data._max_depth || ''}`;
  const parts = [];

  parts.push(`<?xml version="1.0" encoding="UTF-8"?>`);
  parts.push(`<svg xmlns="http://www.w3.org/2000/svg" width="${layout.width}" height="${layout.height}" viewBox="0 0 ${layout.width} ${layout.height}">`);
  parts.push(`<defs><style><![CDATA[
    .title{font:700 24px Inter,Arial,sans-serif;fill:#fff}.subtitle{font:500 13px Inter,Arial,sans-serif;fill:rgba(255,255,255,.72)}
    .level{font:700 11px Inter,Arial,sans-serif;fill:${accent};letter-spacing:.08em;text-transform:uppercase}
    .node-label{font:700 13px Inter,Arial,sans-serif;fill:#111827}.node-meta{font:500 11px Inter,Arial,sans-serif;fill:#4b5563}
    .edge-label{font:600 10px Inter,Arial,sans-serif;fill:#374151}.edge{fill:none;stroke:#8FA3B3;stroke-width:1.6;stroke-opacity:.72}
  ]]></style><marker id="arrow" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="7" markerHeight="7" orient="auto-start-reverse"><path d="M 0 0 L 10 5 L 0 10 z" fill="#8FA3B3"/></marker></defs>`);
  parts.push(`<rect width="100%" height="100%" fill="${svgAttr(bg)}"/>`);
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
    parts.push(`<path class="edge" d="${path}" marker-end="url(#arrow)"/>`);
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

  const svgExportButton = document.getElementById('btn-svg-export');
  if (svgExportButton) svgExportButton.disabled = seedId == null;

  if (isEmpty) {
    bfsStatusMode.textContent = 'no data';
    bfsStatusStat.textContent = 'enter a seed node →';
    document.getElementById('empty-state').style.display = 'block';
    document.getElementById('legend').style.display = 'none';
    document.getElementById('stats').textContent = '0 nodes · 0 edges';
    bfsSeedInput.focus();
    hideGraphLoading();
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
    bfsErr.textContent = 'Enter a node label or #id';
    return;
  }
  const depth = getBfsDepth();
  const seedIdMatch = raw.match(/^#\s*(\d+)/);
  const payload = seedIdMatch
    ? { seed_id: parseInt(seedIdMatch[1], 10), max_depth: depth }
    : { seed_label: raw, max_depth: depth };
  showGraphLoading('Resolving seed...');
  try {
    const result = await bfsResolveSeed(payload);
    if (result.seed_id == null) {
      bfsErr.textContent = 'No node matched that label.';
      hideGraphLoading();
      return;
    }
    navigateTo(result.seed_id, depth, { label: raw.replace(/^#\s*/, '#') + ' depth ' + depth });
  } catch (_) { hideGraphLoading(); /* error already shown */ }
};

document.getElementById('btn-bfs-reset').onclick = () => navigateTo(null, null, { full: true, label: 'Full graph' });
document.getElementById('btn-svg-export').onclick = downloadSubgraphSvg;

// Submit on Enter in the seed input
bfsSeedInput.addEventListener('keydown', (ev) => {
  if (ev.key === 'Enter') document.getElementById('btn-bfs-run').click();
});
