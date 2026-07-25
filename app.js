/* RouteMaker — rail map designer */
"use strict";

// ---------------------------------------------------------------- constants
const GRID = 10; // snap step — fine enough to lay parallel lines nearly touching
const PALETTE = [
  "#E6002D", "#F15A22", "#F6AA00", "#EFC800", "#8FC31F", "#2E9A44",
  "#00A7A8", "#00B2E3", "#0072BC", "#1A2E8C", "#7B1FA2", "#E85298",
  "#8B5A2B", "#5A5A5A", "#111111",
];
const DIRS = {
  e:  [1, 0], w: [-1, 0], n: [0, -1], s: [0, 1],
  ne: [0.72, -0.72], nw: [-0.72, -0.72], se: [0.72, 0.72], sw: [-0.72, 0.72],
};
const LINE_STYLES = [
  ["solid", "Solid"],
  ["stripe", "Shinkansen stripe"],
  ["dashed", "Dashed"],
  ["dotted", "Dotted"],
  ["broken", "Broken (white ticks)"],
  ["hollow", "Hollow (white core)"],
  ["double", "Double track"],
  ["edged", "Edged (dark outline)"],
  ["hatch", "Diagonal hatch"],
  ["zigzag", "Zigzag"],
  ["wave", "Wave"],
  ["chevron", "Chevron"],
  ["crosshatch", "Cross-hatch"],
  ["rail", "Rail ties"],
  ["dashdot", "Dash-dot"],
];
const CORRIDOR_GAP = 1;   // hairline seam between parallel lines sharing a corridor
const MAPS_KEY = "routemaker.maps.v1";
const CUR_KEY = "routemaker.current.v1";
const LEGACY_KEY = "routemaker.v1"; // pre-multi-map single save slot

// ---------------------------------------------------------------- state
let state = {
  lines: [],           // {id,name,color,width,badge,style,corner,closed,points:[{x,y,station}]}
  tool: "select",
  selection: null,     // {lineId, pointIndex?} | null
  view: { x: 40, y: 20, scale: 1 },
  showGrid: true, snap45: true, showLineNames: true, showLegend: true,
  snapAngle: "45", gridSize: GRID, gridContrast: 55, guides: [],
  features: [], featureKind: "water",
};
let drawing = null;    // {lineId} while draw tool is placing points
let featureDraft = null; // {kind, points:[]} while the Shapes tool is outlining an area
let nextId = 1;
const undoStack = [], redoStack = [];
let geomCache = new Map(); // lineId -> rendered (corridor-offset) points

// ---------------------------------------------------------------- editor UI prefs
const UI_KEY = "routemaker.ui.v1";
const PAPER_STOCKS = ["#faf7ef", "#ffffff", "#f2efe6", "#e8e4d8"];
const TOOL_META = {
  select:  { name: "Select",  hint: "Drag a point to move it · ⌥-drag or double-click a segment to add a bend" },
  draw:    { name: "Draw",    hint: "Tap to place points · tap the last point (or ✓ Finish) to stop · tap the first point to close a loop" },
  station: { name: "Station", hint: "Click anywhere on a line to add a station · click a station to edit it" },
  label:   { name: "Label",   hint: "Click a station to rename it and edit its label position / angle" },
  guides:  { name: "Guides",  hint: "Drag out of a ruler to add a guide · drop it back on the ruler to remove it" },
  zoom:    { name: "Zoom",    hint: "Click to zoom in · ⌥-click to zoom out · double-click to fit" },
  shapes:  { name: "Shapes",  hint: "Click to outline an area · click the first point or double-click to finish · pick Water / Park" },
};
const ACCENTS = { blue: "#4d8fd6", amber: "#c9902a", teal: "#3f8b95", rose: "#b8556f" };
let ui = {
  showNav: true,
  paper: PAPER_STOCKS[0],
  accent: ACCENTS.blue,
  openSections: { feature: true, station: true, stroke: true, stations: true, labels: true, geometry: false, document: false, history: false },
};
function loadUI() {
  try {
    const u = JSON.parse(localStorage.getItem(UI_KEY));
    if (u && typeof u === "object") ui = { ...ui, ...u, openSections: { ...ui.openSections, ...(u.openSections || {}) } };
  } catch (e) { /* ignore */ }
}
function saveUI() { try { localStorage.setItem(UI_KEY, JSON.stringify(ui)); } catch (e) { /* ignore */ } }

const svg = document.getElementById("canvas");
const world = document.getElementById("world");
const layers = {
  features: document.getElementById("layer-features"),
  lines: document.getElementById("layer-lines"),
  linelabels: document.getElementById("layer-linelabels"),
  stations: document.getElementById("layer-stations"),
  overlay: document.getElementById("layer-overlay"),
};
const FEATURE_STYLES = {
  water: { fill: "#cfe3f2", stroke: "#a9cbe6", label: "Water" },
  park:  { fill: "#d9ead0", stroke: "#bcd8ae", label: "Park" },
};
const gridRect = document.getElementById("grid-rect");
const measureCtx = document.createElement("canvas").getContext("2d");

// ---------------------------------------------------------------- helpers
const uid = () => "L" + nextId++;
function el(tag, attrs = {}, text) {
  const n = document.createElementNS("http://www.w3.org/2000/svg", tag);
  for (const [k, v] of Object.entries(attrs)) n.setAttribute(k, v);
  if (text != null) n.textContent = text;
  return n;
}
const gridStep = () => state.gridSize || GRID;
const snap = (v) => Math.round(v / gridStep()) * gridStep();
const lineById = (id) => state.lines.find((l) => l.id === id);
const clone = (o) => JSON.parse(JSON.stringify(o));
const fmt = (v) => Math.round(v * 100) / 100;
const lineStyle = (l) => l.style || "solid";
const lineCorner = (l) => (l.corner == null ? 16 : l.corner);

function toWorld(clientX, clientY) {
  const r = svg.getBoundingClientRect();
  return {
    x: (clientX - r.left - state.view.x) / state.view.scale,
    y: (clientY - r.top - state.view.y) / state.view.scale,
  };
}

// Octilinear snap of point p relative to anchor a
function snapOcta(a, p) {
  const dx = p.x - a.x, dy = p.y - a.y;
  const adx = Math.abs(dx), ady = Math.abs(dy);
  if (adx < ady / 2) return { x: a.x, y: a.y + snap(dy) };            // vertical
  if (ady < adx / 2) return { x: a.x + snap(dx), y: a.y };            // horizontal
  const k = snap((adx + ady) / 2);                                    // diagonal
  return { x: a.x + Math.sign(dx) * k, y: a.y + Math.sign(dy) * k };
}

// Snap p to a fixed-angle ray from a; step is 45/30/90 degrees, magnitude grid-snapped.
function snapAngleFn(a, p, mode) {
  if (mode === "45" || !mode) return snapOcta(a, p);
  const dx = p.x - a.x, dy = p.y - a.y;
  const dist = Math.hypot(dx, dy);
  if (dist < 0.01) return { x: a.x, y: a.y };
  const step = mode === "90" ? 90 : 30;
  const ang = Math.round(Math.atan2(dy, dx) * 180 / Math.PI / step) * step * Math.PI / 180;
  const len = snap(dist);
  return { x: a.x + Math.cos(ang) * len, y: a.y + Math.sin(ang) * len };
}

// Snap a dragged point: to a nearby vertex of another line, else to grid + guides.
function objectSnap(w, exclLine, exclIdx) {
  const th = 8 / state.view.scale;
  let best = null, bestD = th;
  for (const line of state.lines) {
    if (line.visible === false) continue;
    for (let i = 0; i < line.points.length; i++) {
      if (line === exclLine && i === exclIdx) continue;
      const q = line.points[i];
      const d = Math.hypot(w.x - q.x, w.y - q.y);
      if (d < bestD) { bestD = d; best = { x: q.x, y: q.y }; }
    }
  }
  if (best) return best;
  let gx = snap(w.x), gy = snap(w.y);
  for (const g of state.guides) {
    if (g.axis === "x" && Math.abs(w.x - g.pos) < th) gx = g.pos;
    if (g.axis === "y" && Math.abs(w.y - g.pos) < th) gy = g.pos;
  }
  return { x: gx, y: gy };
}

// Nearest 8-way compass key for a vector (screen coords: +y is south/down).
function dirFromVec(dx, dy) {
  if (Math.abs(dx) < 0.01 && Math.abs(dy) < 0.01) return null;
  const ang = Math.atan2(dy, dx) * 180 / Math.PI;
  const idx = Math.round(((ang + 360) % 360) / 45) % 8;
  return ["e", "se", "s", "sw", "w", "nw", "n", "ne"][idx];
}

// ---- background features (water / parks)
function finishFeature() {
  if (featureDraft && featureDraft.points.length >= 3) {
    snapshot("Add " + (FEATURE_STYLES[featureDraft.kind] || {}).label);
    const f = { id: "F" + (nextId++), kind: featureDraft.kind, points: featureDraft.points.map((p) => ({ x: p.x, y: p.y })) };
    state.features.push(f);
    state.selection = { featureId: f.id };
  }
  featureDraft = null;
  renderAll();
}
function pointInPoly(p, poly) {
  let inside = false;
  for (let i = 0, j = poly.length - 1; i < poly.length; j = i++) {
    const xi = poly[i].x, yi = poly[i].y, xj = poly[j].x, yj = poly[j].y;
    if (((yi > p.y) !== (yj > p.y)) && (p.x < (xj - xi) * (p.y - yi) / (yj - yi) + xi)) inside = !inside;
  }
  return inside;
}
function featureAt(w) {
  for (let i = state.features.length - 1; i >= 0; i--) {
    if (pointInPoly(w, state.features[i].points)) return state.features[i];
  }
  return null;
}
function featureById(id) { return state.features.find((f) => f.id === id); }

function distToSegment(p, a, b) {
  const vx = b.x - a.x, vy = b.y - a.y;
  const len2 = vx * vx + vy * vy;
  let t = len2 ? ((p.x - a.x) * vx + (p.y - a.y) * vy) / len2 : 0;
  t = Math.max(0, Math.min(1, t));
  const qx = a.x + t * vx, qy = a.y + t * vy;
  return { d: Math.hypot(p.x - qx, p.y - qy), t, x: qx, y: qy };
}

function measureText(text, size, weight) {
  measureCtx.font = `${weight || 400} ${size}px -apple-system, "Segoe UI", Helvetica, Arial, sans-serif`;
  return measureCtx.measureText(text).width;
}

function darken(hex, f = 0.62) {
  const m = /^#?([0-9a-f]{6})$/i.exec(hex);
  if (!m) return "#333";
  const n = parseInt(m[1], 16);
  const r = Math.round(((n >> 16) & 255) * f), g = Math.round(((n >> 8) & 255) * f), b = Math.round((n & 255) * f);
  return "#" + ((1 << 24) | (r << 16) | (g << 8) | b).toString(16).slice(1);
}

// ---- direction-following ornaments (hatch / zigzag / wave / chevron / crosshatch / rail)
// Marks are placed ALONG the centre-line and oriented to the local tangent, so the
// texture reads the same on horizontal, vertical and diagonal segments alike.
let sceneDefs = el("defs"), scenePatterns = new Map();

// Walk the rendered polyline and yield {x,y,tx,ty} samples every `step` units.
function samplePath(rp, closed, step) {
  const out = [];
  const n = closed ? rp.length : rp.length - 1;
  let carry = step / 2;
  for (let i = 0; i < n; i++) {
    const a = rp[i], b = rp[(i + 1) % rp.length];
    const dx = b.x - a.x, dy = b.y - a.y, len = Math.hypot(dx, dy);
    if (len < 0.01) continue;
    const tx = dx / len, ty = dy / len;
    let d = carry;
    while (d <= len) { out.push({ x: a.x + tx * d, y: a.y + ty * d, tx, ty }); d += step; }
    carry = d - len;
  }
  return out;
}

// A white poly-line that oscillates perpendicular to the path (wave = sine, zigzag = triangle).
function oscPath(rp, closed, amp, wavelen, kind) {
  const pts = [];
  const n = closed ? rp.length : rp.length - 1;
  const sample = Math.max(1.5, wavelen / 8);
  let s = 0;
  const emit = (x, y, tx, ty, dist) => {
    const f = ((dist / wavelen) % 1 + 1) % 1;
    const off = (kind === "wave" ? Math.sin(f * Math.PI * 2) : (1 - 4 * Math.abs(f - 0.5))) * amp;
    pts.push(fmt(x - ty * off) + " " + fmt(y + tx * off));
  };
  for (let i = 0; i < n; i++) {
    const a = rp[i], b = rp[(i + 1) % rp.length];
    const dx = b.x - a.x, dy = b.y - a.y, len = Math.hypot(dx, dy);
    if (len < 0.01) continue;
    const tx = dx / len, ty = dy / len;
    for (let d = 0; d < len; d += sample) emit(a.x + tx * d, a.y + ty * d, tx, ty, s + d);
    s += len;
    emit(b.x, b.y, tx, ty, s);
  }
  return pts.length ? "M" + pts.join(" L") : "M0 0";
}

// Draws the white marks for a mark-based texture on top of the coloured band.
function drawOrnaments(g, rp, closed, style, w) {
  if (!rp || rp.length < 2) return;
  const white = "rgba(255,255,255,0.92)";
  const half = w * 0.42, sw = Math.max(1.2, w * 0.16);
  const line2 = (x1, y1, x2, y2) => g.append(el("line", { x1: fmt(x1), y1: fmt(y1), x2: fmt(x2), y2: fmt(y2), stroke: white, "stroke-width": sw, "stroke-linecap": "round" }));
  if (style === "wave" || style === "zigzag") {
    g.append(el("path", { d: oscPath(rp, closed, w * 0.3, w * 1.7, style), fill: "none", stroke: white, "stroke-width": Math.max(1.3, w * 0.17), "stroke-linejoin": "round", "stroke-linecap": "round" }));
    return;
  }
  const step = style === "rail" ? w * 0.72 : w * 0.9;
  for (const s of samplePath(rp, closed, step)) {
    const nx = -s.ty, ny = s.tx;               // unit normal
    if (style === "rail") {                     // perpendicular sleeper
      line2(s.x - nx * half, s.y - ny * half, s.x + nx * half, s.y + ny * half);
    } else if (style === "hatch") {             // single 45°-to-tangent stripe
      const ux = (s.tx + nx), uy = (s.ty + ny), l = Math.hypot(ux, uy) || 1;
      line2(s.x - ux / l * half, s.y - uy / l * half, s.x + ux / l * half, s.y + uy / l * half);
    } else if (style === "crosshatch") {        // an X
      let ux = s.tx + nx, uy = s.ty + ny, l = Math.hypot(ux, uy) || 1;
      line2(s.x - ux / l * half, s.y - uy / l * half, s.x + ux / l * half, s.y + uy / l * half);
      ux = s.tx - nx; uy = s.ty - ny; l = Math.hypot(ux, uy) || 1;
      line2(s.x - ux / l * half, s.y - uy / l * half, s.x + ux / l * half, s.y + uy / l * half);
    } else if (style === "chevron") {           // arrow pointing along the tangent
      const ax = s.x + s.tx * half, ay = s.y + s.ty * half;
      g.append(el("path", {
        d: `M${fmt(s.x - s.tx * half + nx * half)} ${fmt(s.y - s.ty * half + ny * half)} L${fmt(ax)} ${fmt(ay)} L${fmt(s.x - s.tx * half - nx * half)} ${fmt(s.y - s.ty * half - ny * half)}`,
        fill: "none", stroke: white, "stroke-width": sw, "stroke-linejoin": "round", "stroke-linecap": "round",
      }));
    }
  }
}

// (legacy) pattern paints kept for reference; no longer used by drawTexturedPath.
function ensurePattern(kind, color) {
  const key = kind + color;
  if (scenePatterns.has(key)) return scenePatterns.get(key);
  const id = "pat-" + kind + "-" + color.replace(/[^0-9a-zA-Z]/g, "");
  const W = "rgba(255,255,255,0.85)";
  const mk = (attrs) => el("pattern", Object.assign({ id, patternUnits: "userSpaceOnUse" }, attrs));
  let pat;
  if (kind === "hatch") {
    pat = mk({ width: 7, height: 7, patternTransform: "rotate(45)" });
    pat.append(el("rect", { width: 7, height: 7, fill: color }));
    pat.append(el("rect", { width: 7, height: 1.8, fill: "rgba(255,255,255,0.75)" }));
  } else if (kind === "crosshatch") {
    pat = mk({ width: 8, height: 8 });
    pat.append(el("rect", { width: 8, height: 8, fill: color }));
    pat.append(el("path", { d: "M0 0 L8 8 M8 0 L0 8", fill: "none", stroke: W, "stroke-width": 1.2 }));
  } else if (kind === "wave") {
    pat = mk({ width: 16, height: 12 });
    pat.append(el("rect", { width: 16, height: 12, fill: color }));
    pat.append(el("path", { d: "M0 6 Q4 0 8 6 T16 6", fill: "none", stroke: W, "stroke-width": 1.5, "stroke-linecap": "round" }));
  } else if (kind === "chevron") {
    pat = mk({ width: 10, height: 10 });
    pat.append(el("rect", { width: 10, height: 10, fill: color }));
    pat.append(el("path", { d: "M0 8.5 L5 3.5 L10 8.5", fill: "none", stroke: W, "stroke-width": 1.5, "stroke-linejoin": "round" }));
  } else if (kind === "rail") {
    pat = mk({ width: 8, height: 10 });
    pat.append(el("rect", { width: 8, height: 10, fill: color }));
    pat.append(el("rect", { x: 0, width: 2.4, height: 10, fill: W }));
  } else { // zigzag
    pat = mk({ width: 12, height: 12 });
    pat.append(el("rect", { width: 12, height: 12, fill: color }));
    pat.append(el("path", {
      d: "M0 8.5 L3 4.5 L6 8.5 L9 4.5 L12 8.5", fill: "none",
      stroke: W, "stroke-width": 1.4,
    }));
  }
  sceneDefs.append(pat);
  scenePatterns.set(key, id);
  return id;
}

// Draws a path with the line's texture into g (used by the map and the legend).
// rp/closed are the rendered polyline points, needed for direction-following textures.
function drawTexturedPath(g, d, line, w, rp, closed) {
  const color = line.color, style = lineStyle(line);
  const push = (attrs) => g.append(el("path", Object.assign(
    { d, fill: "none", "stroke-linejoin": "round", "stroke-linecap": "round" }, attrs)));
  switch (style) {
    case "dashed":
      push({ stroke: color, "stroke-width": w, "stroke-dasharray": `${w * 1.8} ${w * 1.1}`, "stroke-linecap": "butt" });
      break;
    case "dotted":
      push({ stroke: color, "stroke-width": w, "stroke-dasharray": `0.1 ${w * 1.7}` });
      break;
    case "hatch":
    case "zigzag":
    case "wave":
    case "chevron":
    case "crosshatch":
    case "rail":
      push({ stroke: color, "stroke-width": w });   // coloured band
      drawOrnaments(g, rp, closed, style, w);        // white marks that follow the line
      break;
    case "dashdot":
      push({ stroke: color, "stroke-width": w, "stroke-dasharray": `${w * 2.2} ${w} 0.1 ${w}`, "stroke-linecap": "round" });
      break;
    case "edged":
      push({ stroke: darken(color), "stroke-width": w + 3.5 });
      push({ stroke: color, "stroke-width": Math.max(1.5, w - 1.5) });
      break;
    default:
      push({ stroke: color, "stroke-width": w });
  }
  if (style === "stripe") {
    push({ stroke: "#fff", "stroke-width": Math.max(1.4, w * 0.42),
           "stroke-dasharray": `${w * 0.9} ${w * 0.9}`, "stroke-linecap": "butt" });
  } else if (style === "hollow") {
    push({ stroke: "#fff", "stroke-width": Math.max(1.5, w - 4.5) });
  } else if (style === "double") {
    push({ stroke: "#fbfaf5", "stroke-width": Math.max(1.5, w * 0.45), "stroke-linecap": "butt" });
  } else if (style === "broken") {
    push({ stroke: "#fff", "stroke-width": w, "stroke-dasharray": `2.2 ${w * 1.9}`, "stroke-linecap": "butt" });
  }
}

// ---------------------------------------------------------------- undo/redo
function snapshot(label = "Edit") {
  undoStack.push({ lines: clone(state.lines), features: clone(state.features), label });
  if (undoStack.length > 100) undoStack.shift();
  redoStack.length = 0;
}
function undo() {
  if (!undoStack.length) return;
  const cur = undoStack.pop();
  redoStack.push({ lines: clone(state.lines), features: clone(state.features), label: cur.label });
  state.lines = cur.lines;
  state.features = cur.features || [];
  cancelDrawing(false);
  validateSelection();
  renderAll();
}
function redo() {
  if (!redoStack.length) return;
  const nxt = redoStack.pop();
  undoStack.push({ lines: clone(state.lines), features: clone(state.features), label: nxt.label });
  state.lines = nxt.lines;
  state.features = nxt.features || [];
  validateSelection();
  renderAll();
}
function validateSelection() {
  if (!state.selection) return;
  const l = lineById(state.selection.lineId);
  if (!l) state.selection = null;
  else if (state.selection.pointIndex != null && state.selection.pointIndex >= l.points.length)
    state.selection = { lineId: l.id };
}

// ---------------------------------------------------------------- persistence
// Maps live in localStorage under MAPS_KEY: {maps:[{id,name,updatedAt,lines}]}.
// The current map's slot is updated automatically on every edit.
let currentMapId = null;

function loadStore() {
  try {
    const s = JSON.parse(localStorage.getItem(MAPS_KEY));
    if (s && Array.isArray(s.maps)) return s;
  } catch (e) { /* fall through */ }
  return { maps: [] };
}
function saveStore(s) {
  try { localStorage.setItem(MAPS_KEY, JSON.stringify(s)); } catch (e) { /* ignore */ }
}
function currentMapName() {
  return document.getElementById("map-name").value.trim() || "Untitled Map";
}
function serialize() {
  return JSON.stringify({ app: "routemaker", version: 1, name: currentMapName(), lines: state.lines, features: state.features }, null, 2);
}
function autosave() {
  const s = loadStore();
  const m = s.maps.find((x) => x.id === currentMapId);
  if (!m) return;
  m.lines = state.lines;
  m.features = state.features;
  m.name = currentMapName();
  m.updatedAt = Date.now();
  saveStore(s);
}
function clearHistory() { undoStack.length = 0; redoStack.length = 0; }
function setLines(lines, features) {
  state.lines = lines;
  state.features = clone(features || []);
  let maxN = 0;
  for (const l of state.lines) {
    const m = /^L(\d+)$/.exec(l.id);
    if (m) maxN = Math.max(maxN, +m[1]);
  }
  nextId = maxN + 1;
  state.selection = null;
  cancelDrawing(false);
  featureDraft = null;
  clearHistory();
}
function createMap(name, lines, features) {
  const s = loadStore();
  const id = "M" + Date.now().toString(36) + Math.random().toString(36).slice(2, 6);
  s.maps.push({ id, name, updatedAt: Date.now(), lines: clone(lines), features: clone(features || []) });
  saveStore(s);
  currentMapId = id;
  try { localStorage.setItem(CUR_KEY, id); } catch (e) { /* ignore */ }
  document.getElementById("map-name").value = name;
  setLines(clone(lines), features);
  renderAll();
  fitView();
}
function openMap(id) {
  const s = loadStore();
  const m = s.maps.find((x) => x.id === id);
  if (!m) return;
  currentMapId = id;
  try { localStorage.setItem(CUR_KEY, id); } catch (e) { /* ignore */ }
  document.getElementById("map-name").value = m.name;
  setLines(clone(m.lines), m.features);
  renderAll();
  fitView();
}
function deleteMap(id) {
  const s = loadStore();
  s.maps = s.maps.filter((m) => m.id !== id);
  saveStore(s);
  if (currentMapId === id) {
    const rest = [...s.maps].sort((a, b) => b.updatedAt - a.updatedAt);
    if (rest.length) openMap(rest[0].id);
    else createMap("Untitled Map", []);
  }
}
function untitledName() {
  const s = loadStore();
  let n = 1, name = "Untitled Map";
  while (s.maps.some((m) => m.name === name)) name = "Untitled Map " + ++n;
  return name;
}
function parseMapFile(json) {
  const data = JSON.parse(json);
  if (!Array.isArray(data.lines)) throw new Error("Not a RouteMaker file");
  return data;
}

// ---------------------------------------------------------------- geometry
// Segments shared by several lines (same two grid points) fan out into
// parallel tracks. Returns Map lineId -> rendered points.
function computeGeometry() {
  const groups = new Map(); // canonical segment key -> {ux,uy,members:[{li,i,width}]}
  state.lines.forEach((line, li) => {
    const pts = line.points, n = pts.length;
    const segCount = line.closed ? n : n - 1;
    for (let i = 0; i < segCount; i++) {
      const a = pts[i], b = pts[(i + 1) % n];
      if (a.x === b.x && a.y === b.y) continue;
      const swapped = b.x < a.x || (b.x === a.x && b.y < a.y);
      const p = swapped ? b : a, q = swapped ? a : b;
      const key = p.x + "," + p.y + "|" + q.x + "," + q.y;
      if (!groups.has(key)) {
        const len = Math.hypot(q.x - p.x, q.y - p.y);
        groups.set(key, { ux: -(q.y - p.y) / len, uy: (q.x - p.x) / len, members: [] });
      }
      // sign: does this line travel the segment along canonical order or against it?
      groups.get(key).members.push({ li, i, width: line.width, sign: swapped ? -1 : 1 });
    }
  });

  // per-line, per-segment perpendicular offset vectors. Offsets are oriented by
  // each line's direction of travel (sign) so a track stays on the same side
  // through corners instead of swapping and crossing its neighbor.
  const offsets = state.lines.map((l) => l.points.map(() => ({ x: 0, y: 0 })));
  for (const { ux, uy, members } of groups.values()) {
    if (members.length < 2) continue;
    members.sort((A, B) => A.li - B.li);
    const spacing = Math.max(...members.map((M) => M.width)) + CORRIDOR_GAP;
    let lat = members.map((M, k) => (k - (members.length - 1) / 2) * spacing * M.sign);
    // lines traveling opposite ways can land on the same slot — fall back to
    // plain world-frame slots so tracks at least never overlap
    if (new Set(lat.map((v) => Math.round(v * 8))).size !== lat.length)
      lat = members.map((_, k) => (k - (members.length - 1) / 2) * spacing);
    members.forEach((M, k) => {
      offsets[M.li][M.i] = { x: ux * lat[k], y: uy * lat[k] };
    });
  }

  // rendered vertices: intersect the two adjacent offset segments (miter)
  const geom = new Map();
  state.lines.forEach((line, li) => {
    const pts = line.points, n = pts.length, off = offsets[li];
    const out = [];
    for (let i = 0; i < n; i++) {
      const p = pts[i];
      const inSeg = line.closed ? (i - 1 + n) % n : i > 0 ? i - 1 : null;
      const outSeg = line.closed ? i : i < n - 1 ? i : null;
      if (inSeg == null && outSeg == null) { out.push({ x: p.x, y: p.y }); continue; }
      if (inSeg == null) { out.push({ x: p.x + off[outSeg].x, y: p.y + off[outSeg].y }); continue; }
      if (outSeg == null) { out.push({ x: p.x + off[inSeg].x, y: p.y + off[inSeg].y }); continue; }
      const o1 = off[inSeg], o2 = off[outSeg];
      if (o1.x === o2.x && o1.y === o2.y) { out.push({ x: p.x + o1.x, y: p.y + o1.y }); continue; }
      const a = pts[(i - 1 + n) % n], b = pts[(i + 1) % n];
      const d1 = { x: p.x - a.x, y: p.y - a.y }, d2 = { x: b.x - p.x, y: b.y - p.y };
      const cross = d1.x * d2.y - d1.y * d2.x;
      if (Math.abs(cross) < 1e-6) {
        out.push({ x: p.x + (o1.x + o2.x) / 2, y: p.y + (o1.y + o2.y) / 2 });
      } else {
        const ax = a.x + o1.x, ay = a.y + o1.y;
        const bx = p.x + o2.x, by = p.y + o2.y;
        const t = ((bx - ax) * d2.y - (by - ay) * d2.x) / cross;
        out.push({ x: ax + t * d1.x, y: ay + t * d1.y });
      }
    }
    geom.set(line.id, out);
  });
  return geom;
}

// simple polyline path (used for overlays / previews)
function pathFrom(points, closed) {
  let d = "";
  points.forEach((p, i) => { d += (i ? "L" : "M") + fmt(p.x) + " " + fmt(p.y) + " "; });
  if (closed) d += "Z";
  return d;
}

// path with rounded corners; vertices holding stations stay sharp so the
// station dot sits exactly on the line. rawPts (the unoffset editable points)
// let corridor tracks compensate their radius so parallel turns stay
// concentric — the inner track curves tighter, the outer wider.
function buildPathD(pts, closed, radius, stationAt, rawPts) {
  const n = pts.length;
  if (n < 2) return "";
  if (!radius || n === 2) return pathFrom(pts, closed);
  const P = (i) => pts[((i % n) + n) % n];
  const S = (i) => stationAt[((i % n) + n) % n];
  const radiusAt = (i) => {
    if (!rawPts) return radius;
    const raw = rawPts[((i % n) + n) % n];
    const p = P(i), a = P(i - 1), b = P(i + 1);
    const l1 = Math.hypot(p.x - a.x, p.y - a.y) || 1, l2 = Math.hypot(b.x - p.x, b.y - p.y) || 1;
    const u1 = { x: (p.x - a.x) / l1, y: (p.y - a.y) / l1 };
    const u2 = { x: (b.x - p.x) / l2, y: (b.y - p.y) / l2 };
    const cx = u2.x - u1.x, cy = u2.y - u1.y;   // bisector toward the turn's center
    const cl = Math.hypot(cx, cy);
    if (cl < 0.3) return radius;                 // straight-through / jog: no turn
    const shift = ((p.x - raw.x) * cx + (p.y - raw.y) * cy) / cl;
    return Math.max(2, radius - shift);
  };
  const d = [];
  const corner = (i) => {
    const p = P(i), a = P(i - 1), b = P(i + 1);
    const r1 = Math.hypot(p.x - a.x, p.y - a.y), r2 = Math.hypot(p.x - b.x, p.y - b.y);
    const r = Math.min(radiusAt(i), r1 * 0.5, r2 * 0.5);
    if (S(i) || r < 0.5 || r1 < 0.01 || r2 < 0.01) { d.push("L" + fmt(p.x) + " " + fmt(p.y)); return; }
    const e1 = { x: p.x + ((a.x - p.x) / r1) * r, y: p.y + ((a.y - p.y) / r1) * r };
    const e2 = { x: p.x + ((b.x - p.x) / r2) * r, y: p.y + ((b.y - p.y) / r2) * r };
    d.push("L" + fmt(e1.x) + " " + fmt(e1.y),
           "Q" + fmt(p.x) + " " + fmt(p.y) + " " + fmt(e2.x) + " " + fmt(e2.y));
  };
  if (closed) {
    const m = { x: (P(0).x + P(1).x) / 2, y: (P(0).y + P(1).y) / 2 };
    d.push("M" + fmt(m.x) + " " + fmt(m.y));
    for (let i = 1; i <= n; i++) corner(i);
    d.push("Z");
  } else {
    d.push("M" + fmt(pts[0].x) + " " + fmt(pts[0].y));
    for (let i = 1; i < n - 1; i++) corner(i);
    d.push("L" + fmt(pts[n - 1].x) + " " + fmt(pts[n - 1].y));
  }
  return d.join(" ");
}

function stationRadius(line, st) {
  if (st.type === "major") return line.width * 0.85 + 4.5;
  // normal stations are small white dots fully inset in the line's band
  const ms = +line.markerSize;
  return ms ? Math.max(1.4, ms) : Math.max(1.6, line.width * 0.34);
}
function stationTangent(rp, i) {
  const a = rp[Math.max(0, i - 1)], b = rp[Math.min(rp.length - 1, i + 1)];
  const dx = b.x - a.x, dy = b.y - a.y;
  const len = Math.hypot(dx, dy) || 1;
  return [dx / len, dy / len];
}

function rawBounds() {
  let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
  for (const l of state.lines) for (const p of l.points) {
    minX = Math.min(minX, p.x); maxX = Math.max(maxX, p.x);
    minY = Math.min(minY, p.y); maxY = Math.max(maxY, p.y);
  }
  if (!isFinite(minX)) return null;
  return { minX, minY, maxX, maxY, w: maxX - minX, h: maxY - minY };
}

// ---------------------------------------------------------------- scene
// Build the map itself (lines, stations, labels, legend) into a group.
// Used by both the editor canvas and the exporter.
function buildScene(g) {
  const gFeatures = el("g"), gLines = el("g"), gLineLabels = el("g"), gStations = el("g"), gLegend = el("g");
  sceneDefs = el("defs");
  scenePatterns = new Map();
  g.append(sceneDefs, gFeatures, gLines, gLineLabels, gStations, gLegend);

  // ---- background features (water / parks) behind the network
  for (const f of state.features) {
    if (!f.points || f.points.length < 3) continue;
    const fs = FEATURE_STYLES[f.kind] || FEATURE_STYLES.water;
    const d = "M" + f.points.map((p) => fmt(p.x) + " " + fmt(p.y)).join(" L") + " Z";
    gFeatures.append(el("path", { d, fill: fs.fill, stroke: fs.stroke, "stroke-width": 2, "stroke-linejoin": "round" }));
  }

  const geom = computeGeometry();
  geomCache = geom;

  // ---- lines (with per-line texture)
  for (const line of state.lines) {
    if (line.points.length < 2 || line.visible === false) continue;
    const rp = geom.get(line.id);
    const stationAt = line.points.map((p) => !!p.station);
    const d = buildPathD(rp, line.closed, lineCorner(line), stationAt, line.points);
    const op = (line.opacity == null ? 100 : line.opacity) / 100;
    const target = op < 1 ? el("g", { opacity: fmt(op) }) : gLines;
    const casing = +line.casing || 0;
    if (casing > 0) {
      // paper-colored under-stroke: masks lines below, like a transit-map bridge
      target.append(el("path", {
        d, fill: "none", "stroke-linejoin": "round", "stroke-linecap": "round",
        stroke: ui.paper || "#faf7ef", "stroke-width": line.width + casing * 2,
      }));
    }
    drawTexturedPath(target, d, line, line.width, rp, line.closed);
    if (target !== gLines) gLines.append(target);
  }

  // ---- line names at termini
  if (state.showLineNames) {
    for (const line of state.lines) {
      if (line.points.length < 2 || !line.name || line.visible === false) continue;
      const rp = geom.get(line.id);
      let px, py, ux = 1, uy = 0;
      if (line.closed) {
        const p = rp[Math.floor(rp.length / 2)];
        px = p.x + 14; py = p.y - 14;
      } else {
        const a = rp[0], b = rp[1];
        const len = Math.hypot(b.x - a.x, b.y - a.y) || 1;
        ux = (a.x - b.x) / len; uy = (a.y - b.y) / len;
        px = a.x + ux * 30; py = a.y + uy * 30;
      }
      const vertical = Math.abs(uy) > 0.85;
      const anchor = vertical ? "middle" : ux < -0.3 ? "end" : "start";
      const lg = el("g", { transform: `translate(${fmt(px)},${fmt(py)})` });
      if (line.badge) {
        lg.append(el("circle", { cx: 0, cy: 0, r: 8, fill: line.color }));
        lg.append(el("text", {
          x: 0, y: 0, fill: "#fff", "font-size": 9, "font-weight": 700,
          "text-anchor": "middle", "dominant-baseline": "central",
          "font-family": "Helvetica, Arial, sans-serif",
        }, line.badge));
      }
      const tx = vertical ? 0 : line.badge ? (anchor === "end" ? -12 : 12) : 0;
      const ty = vertical && line.badge ? uy * 19 : 0;
      lg.append(el("text", {
        x: tx, y: ty, fill: line.color,
        "font-size": 12, "font-weight": 700,
        "text-anchor": anchor, "dominant-baseline": "central",
        "font-family": "Helvetica, Arial, sans-serif",
        stroke: "#fbfaf5", "stroke-width": 3, "paint-order": "stroke",
      }, line.name));
      gLineLabels.append(lg);
    }
  }

  // ---- stations
  // vertices grouped by raw coordinate, for capsule interchange markers
  const atCoord = new Map(); // "x,y" -> [{line, rp:{x,y}}]
  state.lines.forEach((line) => {
    if (line.visible === false) return;
    const rp = geom.get(line.id);
    line.points.forEach((p, i) => {
      const key = p.x + "," + p.y;
      if (!atCoord.has(key)) atCoord.set(key, []);
      atCoord.get(key).push({ line, rp: rp[i] });
    });
  });

  const capsuleDone = new Set();
  state.lines.forEach((line) => {
    const rp = geom.get(line.id);
    line.points.forEach((p, i) => {
      const st = p.station;
      if (!st) return;
      const pos = rp[i];
      const r = stationRadius(line, st);
      const asMajor = st.type === "major" && line.interchangeRings !== false;
      if (asMajor) {
        const key = p.x + "," + p.y;
        const here = atCoord.get(key);
        // farthest pair of rendered positions at this map location
        let A = pos, B = pos, span = 0;
        for (let a = 0; a < here.length; a++) for (let b = a + 1; b < here.length; b++) {
          const dd = Math.hypot(here[a].rp.x - here[b].rp.x, here[a].rp.y - here[b].rp.y);
          if (dd > span) { span = dd; A = here[a].rp; B = here[b].rp; }
        }
        if (span > 2) {
          // capsule spanning the parallel tracks
          if (!capsuleDone.has(key)) {
            capsuleDone.add(key);
            const W = Math.max(...here.map((h) => h.line.width)) + 6;
            gStations.append(el("path", {
              d: `M${fmt(A.x)} ${fmt(A.y)} L${fmt(B.x)} ${fmt(B.y)}`,
              stroke: "#111", "stroke-width": W + 5, "stroke-linecap": "round", fill: "none",
            }));
            gStations.append(el("path", {
              d: `M${fmt(A.x)} ${fmt(A.y)} L${fmt(B.x)} ${fmt(B.y)}`,
              stroke: "#fff", "stroke-width": W, "stroke-linecap": "round", fill: "none",
            }));
          }
        } else {
          gStations.append(el("circle", {
            cx: fmt(pos.x), cy: fmt(pos.y), r, fill: "#fff", stroke: "#111", "stroke-width": 2.6,
          }));
        }
      } else {
        const marker = line.marker || "dot";
        if (marker === "ring") {
          gStations.append(el("circle", {
            cx: fmt(pos.x), cy: fmt(pos.y), r: fmt(r + 0.6), fill: ui.paper || "#fff",
            stroke: line.color, "stroke-width": Math.max(1.4, line.width * 0.26),
          }));
        } else if (marker === "tick") {
          const [tx, ty] = stationTangent(rp, i);
          const nx = -ty, ny = tx, half = line.width * 0.6;
          gStations.append(el("line", {
            x1: fmt(pos.x - nx * half), y1: fmt(pos.y - ny * half),
            x2: fmt(pos.x + nx * half), y2: fmt(pos.y + ny * half),
            stroke: "#fff", "stroke-width": Math.max(1.6, r), "stroke-linecap": "round",
          }));
        } else {
          // hairline stroke in the line color: invisible on a solid band, but keeps
          // the dot visible on hollow / white-cored textures
          gStations.append(el("circle", {
            cx: fmt(pos.x), cy: fmt(pos.y), r, fill: "#fff", stroke: line.color, "stroke-width": 1,
          }));
        }
      }
      // labels clear the band edge, not just the dot
      if (st.name) gStations.append(buildStationLabel(pos, st, asMajor ? r : Math.max(r, line.width / 2),
        { size: +line.labelSize || null, halo: line.halo !== false }));
    });
  });

  // ---- legend strip beneath the map
  if (state.showLegend) {
    const rb = rawBounds();
    if (rb) buildLegend(gLegend, rb.minX - 40, rb.maxY + 80, rb.w + 80);
  }
}

function buildStationLabel(p, st, r, opts = {}) {
  const dir = DIRS[st.dir] || DIRS.e;
  const rot = st.rot || 0;
  const dist = r + 7;
  const ox = dir[0] * dist, oy = dir[1] * dist;
  const anchor = dir[0] > 0.3 ? "start" : dir[0] < -0.3 ? "end" : "middle";
  const g = el("g", { transform: `translate(${fmt(p.x)},${fmt(p.y)}) rotate(${rot})` });

  if (st.type === "major") {
    const fs = opts.size ? Math.max(9, opts.size + 1.5) : 13, padX = 8, h = Math.max(20, (opts.size || 13) + 7);
    const w = measureText(st.name, fs, 700) + padX * 2;
    let x0 = ox, y0 = oy - h / 2;
    if (anchor === "end") x0 = ox - w;
    else if (anchor === "middle") x0 = ox - w / 2;
    if (dir[1] < -0.3) y0 = oy - h; else if (dir[1] > 0.3) y0 = oy;
    g.append(el("rect", { x: fmt(x0), y: fmt(y0), width: fmt(w), height: h, rx: 9.5, fill: "#111" }));
    g.append(el("text", {
      x: fmt(x0 + w / 2), y: fmt(y0 + h / 2 + 0.5), fill: "#fff",
      "font-size": fs, "font-weight": 700, "text-anchor": "middle",
      "dominant-baseline": "central",
      "font-family": "Helvetica, Arial, sans-serif",
    }, st.name));
  } else {
    const attrs = {
      x: fmt(ox), y: fmt(oy), fill: "#1c1c1c", "font-size": opts.size || 11.5, "font-weight": 500,
      "text-anchor": anchor, "dominant-baseline": "central",
      "font-family": "Helvetica, Arial, sans-serif",
    };
    if (opts.halo !== false) { attrs.stroke = "#fbfaf5"; attrs["stroke-width"] = 2.5; attrs["paint-order"] = "stroke"; }
    g.append(el("text", attrs, st.name));
  }
  return g;
}

// Draws the legend into g at (x,y), wrapping within maxW. Returns its height.
function buildLegend(g, x, y, maxW) {
  const items = state.lines.filter((l) => l.name && l.points.length > 1 && l.visible !== false);
  if (!items.length) return 0;
  const rowH = 28;
  g.append(el("line", {
    x1: fmt(x), y1: fmt(y - 10), x2: fmt(x + maxW), y2: fmt(y - 10),
    stroke: "#d8d3c3", "stroke-width": 1.5,
  }));
  let cx = x, cy = y;
  for (const line of items) {
    const badgeW = line.badge ? 21 : 0;
    const tw = measureText(line.name, 12, 600);
    const w = 30 + 8 + badgeW + tw + 28;
    if (cx > x && cx + w > x + maxW) { cx = x; cy += rowH; }
    const ym = cy + rowH / 2;
    const d = `M${fmt(cx)} ${fmt(ym)} L${fmt(cx + 30)} ${fmt(ym)}`;
    drawTexturedPath(g, d, line, 6, [{ x: cx, y: ym }, { x: cx + 30, y: ym }], false);
    let tx = cx + 38;
    if (line.badge) {
      g.append(el("circle", { cx: fmt(tx + 8), cy: fmt(ym), r: 8, fill: line.color }));
      g.append(el("text", {
        x: fmt(tx + 8), y: fmt(ym), fill: "#fff", "font-size": 9, "font-weight": 700,
        "text-anchor": "middle", "dominant-baseline": "central",
        "font-family": "Helvetica, Arial, sans-serif",
      }, line.badge));
      tx += badgeW;
    }
    g.append(el("text", {
      x: fmt(tx), y: fmt(ym), fill: "#333", "font-size": 12, "font-weight": 600,
      "dominant-baseline": "central", "font-family": "Helvetica, Arial, sans-serif",
    }, line.name));
    cx += w;
  }
  return cy + rowH - y;
}

function renderScene() {
  layers.lines.replaceChildren();
  layers.linelabels.replaceChildren();
  layers.stations.replaceChildren();
  buildScene(layers.lines);
  renderOverlay();
}

function renderOverlay() {
  layers.overlay.replaceChildren();
  const s = state.view.scale;
  const sel = state.selection;
  if (sel) {
    const line = lineById(sel.lineId);
    if (line && line.points.length) {
      // thin dashed skeleton along the editable (raw) geometry
      layers.overlay.append(el("path", {
        d: pathFrom(line.points, line.closed),
        fill: "none", stroke: "#4c8dff", "stroke-width": 1.5 / s,
        "stroke-dasharray": `${6 / s} ${4 / s}`,
        "pointer-events": "none",
      }));
      line.points.forEach((p, i) => {
        const isSel = sel.pointIndex === i;
        layers.overlay.append(el("rect", {
          x: p.x - 4.5 / s, y: p.y - 4.5 / s, width: 9 / s, height: 9 / s,
          fill: isSel ? "#4c8dff" : "#fff", stroke: "#4c8dff",
          "stroke-width": 1.6 / s, "pointer-events": "none",
        }));
      });
    }
  }
  if (state.tool === "draw" && !drawing) {
    // rings on open-line endpoints: click one to extend that line
    for (const line of state.lines) {
      if (line.closed || line.points.length < 2) continue;
      const rp = geomCache.get(line.id) || line.points;
      for (const idx of [0, line.points.length - 1]) {
        const p = rp[idx];
        layers.overlay.append(el("circle", {
          cx: p.x, cy: p.y, r: line.width / 2 + 5 / s,
          fill: "none", stroke: "#4c8dff", "stroke-width": 1.8 / s,
          opacity: 0.85, "pointer-events": "none",
        }));
      }
    }
  }
  if (drawing) {
    const line = lineById(drawing.lineId);
    if (line && line.points.length && drawing.cursor) {
      const last = line.points[line.points.length - 1];
      layers.overlay.append(el("line", {
        x1: last.x, y1: last.y, x2: drawing.cursor.x, y2: drawing.cursor.y,
        stroke: line.color, "stroke-width": line.width, opacity: 0.45,
        "stroke-linecap": "round", "pointer-events": "none",
      }));
      layers.overlay.append(el("circle", {
        cx: drawing.cursor.x, cy: drawing.cursor.y, r: 4 / s,
        fill: "#4c8dff", "pointer-events": "none",
      }));
    }
  }
  for (const gd of state.guides) {
    const gw = 1 / state.view.scale;
    const a = gd.axis === "y"
      ? { x1: -100000, y1: gd.pos, x2: 100000, y2: gd.pos }
      : { x1: gd.pos, y1: -100000, x2: gd.pos, y2: 100000 };
    layers.overlay.append(el("line", { ...a, stroke: "#12a5c0", "stroke-width": gw, opacity: 0.85, "pointer-events": "none" }));
  }
  if (featureDraft && featureDraft.points.length) {
    const fs = FEATURE_STYLES[featureDraft.kind] || FEATURE_STYLES.water;
    layers.overlay.append(el("path", {
      d: "M" + featureDraft.points.map((p) => fmt(p.x) + " " + fmt(p.y)).join(" L"),
      fill: "none", stroke: fs.stroke, "stroke-width": 2 / s, "stroke-dasharray": `${5 / s} ${4 / s}`, "pointer-events": "none",
    }));
    for (const p of featureDraft.points)
      layers.overlay.append(el("rect", { x: p.x - 3 / s, y: p.y - 3 / s, width: 6 / s, height: 6 / s, fill: fs.stroke, "pointer-events": "none" }));
  }
  if (state.selection && state.selection.featureId) {
    const f = featureById(state.selection.featureId);
    if (f) layers.overlay.append(el("path", {
      d: "M" + f.points.map((p) => fmt(p.x) + " " + fmt(p.y)).join(" L") + " Z",
      fill: "none", stroke: "#4c8dff", "stroke-width": 2 / s, "stroke-dasharray": `${6 / s} ${4 / s}`, "pointer-events": "none",
    }));
  }
  if (typeof syncCanvasControls === "function") syncCanvasControls();
}

function applyView() {
  world.setAttribute("transform",
    `translate(${state.view.x},${state.view.y}) scale(${state.view.scale})`);
  gridRect.style.display = state.showGrid ? "" : "none";
  const z = Math.round(state.view.scale * 100) + "%";
  setText("status-zoom", z); setText("sb-zoom", z); setText("nav-zoom", z);
}

function renderAll() {
  applyView();
  renderScene();
  renderLineList();
  renderProps();
  renderNavigator();
  syncOptionsBar();
  updateStatus();
  autosave();
}

// small DOM helpers for the chrome
function setText(id, txt) { const n = document.getElementById(id); if (n) n.textContent = txt; }
function stationCount() {
  return state.lines.reduce((n, l) => n + l.points.filter((p) => p.station).length, 0);
}

function updateStatus() {
  // options-bar contextual hint
  let hint = (TOOL_META[state.tool] || TOOL_META.select).hint;
  if (drawing) hint = "Placing points · tap the last point or ✓ Finish to stop · tap the first point to close a loop · Esc undoes last";
  setText("ob-hint", hint);

  // status bar readouts
  const nStations = stationCount();
  const nLines = state.lines.filter((l) => l.visible !== false).length;
  setText("sb-snap", state.snap45 ? (state.snapAngle || "45") + "° snap" : "Free angle");
  setText("sb-counts", `${nLines} line${nLines === 1 ? "" : "s"} · ${nStations} station${nStations === 1 ? "" : "s"}`);
  setText("line-stats", `${nLines} line${nLines === 1 ? "" : "s"} · ${nStations} station${nStations === 1 ? "" : "s"}`);
  setText("line-count", String(state.lines.length));

  const sel = state.selection && lineById(state.selection.lineId);
  if (!sel) setText("sb-sel", "No selection");
  else if (state.selection.pointIndex != null) {
    const p = sel.points[state.selection.pointIndex];
    setText("sb-sel", (p && p.station ? p.station.name || "Station" : "Point") + " · " + (sel.name || "line"));
  } else setText("sb-sel", (sel.name || "line") + " · " + sel.points.length + " points");
}

function syncOptionsBar() {
  toggleAttr("opt-grid", state.showGrid);
  toggleAttr("opt-snap", state.snap45);
  toggleAttr("opt-labels", state.showLineNames);
  toggleAttr("opt-legend", state.showLegend);
  const sel = state.selection && lineById(state.selection.lineId);
  setText("ob-stroke", sel ? fmt(sel.width) + " pt" : "—");
  setText("ob-corner", sel ? lineCorner(sel) + " pt" : "—");
  const chip = document.getElementById("ob-color");
  if (chip) chip.style.background = sel ? sel.color : "#3a3a3a";
  const ink = document.getElementById("tr-ink");
  if (ink) ink.style.background = sel ? sel.color : "var(--acc)";
  const paper = document.querySelector(".tr-paper");
  if (paper) paper.style.background = ui.paper;
}
function toggleAttr(id, on) {
  const n = document.getElementById(id);
  if (n) n.setAttribute("data-on", on ? "1" : "0");
}

function renderNavigator() {
  const nav = document.getElementById("navigator");
  if (nav) nav.classList.toggle("hidden", !ui.showNav);
  const svg2 = document.getElementById("nav-svg");
  if (!svg2 || !ui.showNav) return;
  svg2.replaceChildren();
  const bb = rawBounds();
  const VW = 222, VH = 138, pad = 8;
  if (!bb) return;
  const s = Math.min((VW - pad * 2) / bb.w, (VH - pad * 2) / bb.h);
  const ox = (VW - bb.w * s) / 2 - bb.minX * s;
  const oy = (VH - bb.h * s) / 2 - bb.minY * s;
  const g = el("g", { transform: `translate(${fmt(ox)},${fmt(oy)}) scale(${fmt(s)})` });
  for (const line of state.lines) {
    if (line.points.length < 2 || line.visible === false) continue;
    const rp = geomCache.get(line.id) || line.points;
    const stationAt = line.points.map((p) => !!p.station);
    const d = buildPathD(rp, line.closed, lineCorner(line), stationAt, line.points);
    g.append(el("path", { d, fill: "none", stroke: line.color, "stroke-width": Math.max(line.width, 6), "stroke-linejoin": "round", "stroke-linecap": "round" }));
  }
  svg2.append(g);
}

// ---------------------------------------------------------------- sidebar
const EYE_SVG = '<svg width="13" height="13" viewBox="0 0 13 13"><ellipse cx="6.5" cy="6.5" rx="6" ry="3.6" fill="none" stroke="currentColor" stroke-width="1.1"/><circle cx="6.5" cy="6.5" r="1.7" fill="currentColor"/></svg>';
function renderLineList() {
  const ul = document.getElementById("line-list");
  ul.replaceChildren();
  state.lines.forEach((line, idx) => {
    const selected = state.selection && state.selection.lineId === line.id;
    const hidden = line.visible === false;
    const nStops = line.points.filter((p) => p.station).length;

    const row = document.createElement("div");
    row.className = "ln-row" + (selected ? " selected" : "");
    // tap body to select; tap the name of an already-selected line to rename
    row.addEventListener("click", (e) => {
      if (e.target.closest(".ln-grip,.ln-eye,.ln-lock,.ln-rename")) return;
      if (selected && e.target.closest(".ln-name")) { startInlineRename(text, nm, line); return; }
      state.selection = { lineId: line.id }; renderAll();
    });

    const bar = document.createElement("div"); bar.className = "ln-bar";

    const grip = document.createElement("div");
    grip.className = "ln-grip"; grip.textContent = "⠿"; grip.title = "Drag to reorder (z-order)";
    grip.addEventListener("pointerdown", (e) => startRowDrag(e, idx, row));

    const eye = document.createElement("button");
    eye.className = "ln-eye" + (hidden ? " off" : "");
    eye.innerHTML = EYE_SVG;
    eye.title = hidden ? "Show line" : "Hide line";
    eye.onclick = (e) => { e.stopPropagation(); line.visible = hidden; renderAll(); };

    const chip = document.createElement("span");
    chip.className = "ln-chip"; chip.style.background = line.color;

    const text = document.createElement("div"); text.className = "ln-text";
    const nm = document.createElement("div");
    nm.className = "ln-name" + (hidden ? " hidden-line" : "");
    nm.textContent = line.name || "(unnamed line)";
    nm.title = selected ? "Tap again to rename" : "";
    const meta = document.createElement("div");
    meta.className = "ln-meta";
    meta.textContent = `${nStops} stop${nStops === 1 ? "" : "s"}` + (line.closed ? " · loop" : "");
    text.append(nm, meta);

    const lock = document.createElement("button");
    lock.className = "ln-lock" + (line.locked ? " on" : "");
    lock.title = line.locked ? "Unlock line" : "Lock line";
    lock.onclick = (e) => { e.stopPropagation(); line.locked = !line.locked; renderAll(); };

    row.append(bar, grip, eye, chip, text, lock);
    ul.append(row);
  });
}
// Pointer-based row reordering — works with mouse, touch and Pencil (grip has
// touch-action:none so the vertical drag reorders instead of scrolling the list).
function startRowDrag(e, idx, row) {
  e.preventDefault(); e.stopPropagation();
  const ul = document.getElementById("line-list");
  const startY = e.clientY;
  let moved = false, to = idx;
  const onMove = (ev) => {
    if (!moved && Math.abs(ev.clientY - startY) < 4) return;
    moved = true; row.classList.add("dragging");
    const rows = [...ul.children];
    to = rows.length;
    for (let i = 0; i < rows.length; i++) {
      const r = rows[i].getBoundingClientRect();
      if (ev.clientY < r.top + r.height / 2) { to = i; break; }
    }
    rows.forEach((r, i) => r.classList.toggle("drag-over", moved && i === to));
  };
  const onUp = () => {
    window.removeEventListener("pointermove", onMove);
    window.removeEventListener("pointerup", onUp);
    [...ul.children].forEach((r) => r.classList.remove("drag-over", "dragging"));
    if (!moved) return;
    let dst = to; if (dst > idx) dst -= 1;
    if (dst === idx) return;
    snapshot("Reorder lines");
    const [m] = state.lines.splice(idx, 1);
    state.lines.splice(dst, 0, m);
    renderAll();
  };
  window.addEventListener("pointermove", onMove);
  window.addEventListener("pointerup", onUp);
}
function startInlineRename(textEl, nm, line) {
  const inp = document.createElement("input");
  inp.type = "text"; inp.className = "ln-rename"; inp.value = line.name || "";
  let done = false;
  const commit = (save) => {
    if (done) return; done = true;
    if (save) { snapshot("Rename line"); line.name = inp.value.trim() || line.name; }
    renderAll();
  };
  inp.onkeydown = (e) => { e.stopPropagation(); if (e.key === "Enter") commit(true); else if (e.key === "Escape") commit(false); };
  inp.onblur = () => commit(true);
  inp.onclick = (e) => e.stopPropagation();
  textEl.replaceChildren(inp);
  inp.focus(); inp.select();
}

// ---------------------------------------------------------------- inspector builders
function elh(tag, cls, txt) {
  const n = document.createElement(tag);
  if (cls) n.className = cls;
  if (txt != null) n.textContent = txt;
  return n;
}
// live line edit that must NOT rebuild the inspector (keeps sliders/inputs alive)
function liveEdit() { renderScene(); renderLineList(); syncOptionsBar(); renderNavigator(); updateStatus(); autosave(); }

function propSlider(label, min, max, step, value, fmtVal, onInput, opts = {}) {
  const row = elh("div", "prow" + (opts.disabled ? " disabled" : ""));
  row.append(elh("span", "prow-lab", label));
  const sl = elh("div", "slider");
  const track = elh("div", "strack"), fill = elh("div", "sfill"), handle = elh("div", "shandle");
  const input = document.createElement("input");
  input.type = "range"; input.className = "sinput";
  input.min = min; input.max = max; input.step = step; input.value = value;
  if (opts.disabled) input.disabled = true;
  const field = elh("span", "sfield");
  const upd = (v) => {
    const pct = (max === min) ? 0 : (v - min) / (max - min) * 100;
    fill.style.width = pct + "%"; handle.style.left = pct + "%"; field.textContent = fmtVal(v);
  };
  upd(+value);
  let snapped = false;
  input.addEventListener("pointerdown", () => { snapped = false; });
  input.addEventListener("input", () => {
    if (!snapped) { snapshot(); snapped = true; }
    const v = +input.value; upd(v); onInput(v); liveEdit();
  });
  sl.append(track, fill, handle, input);
  row.append(sl, field);
  return row;
}
function propSeg(label, options, value, onPick) {
  const row = elh("div", "prow");
  row.append(elh("span", "prow-lab", label));
  const seg = elh("div", "seg");
  for (const [v, lab, inert] of options) {
    const b = elh("button", "seg-btn" + (v === value ? " active" : "") + (inert ? " inert" : ""), lab);
    if (!inert) b.onclick = () => onPick(v);
    seg.append(b);
  }
  row.append(seg);
  return row;
}
function propSelect(label, options, value, onPick) {
  const row = elh("div", "prow");
  row.append(elh("span", "prow-lab", label));
  const s = document.createElement("select");
  for (const [v, lab] of options) {
    const o = document.createElement("option"); o.value = v; o.textContent = lab;
    if (v === value) o.selected = true; s.append(o);
  }
  s.onchange = () => onPick(s.value);
  row.append(s);
  return row;
}
function propText(label, value, onInput, attrs = {}) {
  const row = elh("div", "prow");
  row.append(elh("span", "prow-lab", label));
  const i = document.createElement("input");
  i.type = "text"; i.value = value; Object.assign(i, attrs);
  let snapped = false;
  i.addEventListener("focus", () => { snapped = false; });
  i.addEventListener("input", () => {
    if (!snapped) { snapshot(); snapped = true; }
    onInput(i.value); renderScene(); renderLineList(); syncOptionsBar(); updateStatus(); autosave();
  });
  row.append(i);
  return row;
}
function propCheck(label, checked, onToggle, opts = {}) {
  const row = elh("div", "ck2" + (checked ? " on" : "") + (opts.disabled ? " disabled prow disabled" : ""));
  row.append(elh("span", "ck"), elh("span", "ck2-lab", label));
  if (!opts.disabled) row.onclick = () => onToggle(!checked);
  return row;
}
function section(key, title, summary, buildBody) {
  const sec = elh("div", "insp-section" + (ui.openSections[key] ? " open" : ""));
  const head = elh("div", "sec-head");
  head.append(elh("span", "sec-caret", "▸"), elh("span", "sec-title", title), elh("span", "sec-sum", summary));
  head.onclick = () => { ui.openSections[key] = !ui.openSections[key]; saveUI(); sec.classList.toggle("open"); };
  const body = elh("div", "sec-body");
  buildBody(body);
  sec.append(head, body);
  return sec;
}
function commitPick(mutate) { snapshot(); mutate(); renderScene(); renderProps(); renderLineList(); syncOptionsBar(); renderNavigator(); updateStatus(); autosave(); }
function lineBounds(line) {
  const xs = line.points.map((p) => p.x), ys = line.points.map((p) => p.y);
  if (!xs.length) return { x: 0, y: 0, w: 0, h: 0 };
  const minX = Math.min(...xs), minY = Math.min(...ys), maxX = Math.max(...xs), maxY = Math.max(...ys);
  return { x: minX, y: minY, w: maxX - minX, h: maxY - minY };
}
function styleLabel(v) { return (LINE_STYLES.find(([s]) => s === v) || [null, "Solid"])[1]; }

function renderProps() {
  const hd = document.getElementById("inspector-header");
  const box = document.getElementById("props");
  if (!hd || !box) return;
  hd.replaceChildren(); box.replaceChildren();
  const sel = state.selection;
  if (sel && sel.featureId) {
    const f = featureById(sel.featureId);
    if (f) { buildFeatureInspector(hd, box, f); return; }
  }
  const line = sel && lineById(sel.lineId);

  if (!line) {
    const e = elh("div", "insp-empty");
    e.innerHTML = "Select a line, or a station point, to edit it.<br><br>" +
      "<b>Draw (D)</b> places points — tap the last point (or the ✓ Finish button) to stop, or the first point to close a loop.<br>" +
      "<b>Station (S)</b> adds a stop anywhere on a line.<br>" +
      "<b>Select (V)</b> drags points; ⌥-drag or double-click a segment to add a bend.";
    box.append(e);
    return;
  }

  buildInspectorHeader(hd, line);
  if (sel.pointIndex != null) box.append(buildStationSection(line, sel.pointIndex));
  box.append(buildStrokeSection(line));
  box.append(buildStationsSection(line));
  box.append(buildLabelsSection(line));
  box.append(buildGeometrySection(line));
  box.append(buildDocumentSection());
  box.append(buildHistorySection());
}

function buildInspectorHeader(hd, line) {
  const r1 = elh("div", "ihd-row");
  const chip = elh("div", "insp-color"); chip.style.background = line.color;
  const colorIn = document.createElement("input");
  colorIn.type = "color"; colorIn.value = /^#[0-9a-f]{6}$/i.test(line.color) ? line.color : "#4d8fd6";
  colorIn.style.cssText = "position:absolute;width:0;height:0;opacity:0;pointer-events:none";
  let colorSnapped = false;
  colorIn.oninput = () => {
    if (!colorSnapped) { snapshot(); colorSnapped = true; }
    line.color = colorIn.value; chip.style.background = colorIn.value; liveEdit();
  };
  colorIn.onchange = () => { colorSnapped = false; renderProps(); };
  chip.title = "Click for a custom color";
  chip.onclick = () => colorIn.click();
  const name = document.createElement("input");
  name.type = "text"; name.className = "insp-name"; name.value = line.name || "";
  let snapped = false;
  name.addEventListener("focus", () => { snapped = false; });
  name.addEventListener("input", () => {
    if (!snapped) { snapshot(); snapped = true; }
    line.name = name.value; renderScene(); renderLineList(); updateStatus(); autosave();
  });
  r1.append(chip, name, colorIn);

  const r2 = elh("div", "ihd-row");
  r2.append(elh("span", "ihd-lab", "Type"));
  const typeSel = document.createElement("select"); typeSel.className = "insp-type";
  for (const [v, lab] of LINE_STYLES) {
    const o = document.createElement("option"); o.value = v; o.textContent = lab;
    if (v === lineStyle(line)) o.selected = true; typeSel.append(o);
  }
  typeSel.onchange = () => commitPick(() => (line.style = typeSel.value));
  r2.append(typeSel, elh("span", "insp-id", line.id));

  const pal = elh("div", "insp-palette");
  for (const c of PALETTE) {
    const b = elh("button", "pal" + (line.color.toLowerCase() === c.toLowerCase() ? " sel" : ""));
    b.style.background = c;
    b.onclick = () => commitPick(() => (line.color = c));
    pal.append(b);
  }
  hd.append(r1, r2, pal);
}

function buildStrokeSection(line) {
  return section("stroke", "Stroke", fmt(line.width) + " pt · " + styleLabel(lineStyle(line)), (body) => {
    body.append(propSlider("Width", 3, 16, 1, line.width, (v) => v + " pt", (v) => (line.width = v)));
    body.append(propSlider("Casing", 0, 6, 0.5, +line.casing || 0, (v) => v + " pt", (v) => (line.casing = v)));
    body.append(propSlider("Corner", 0, 40, 2, lineCorner(line), (v) => v + " pt", (v) => (line.corner = v)));
    body.append(propSlider("Opacity", 10, 100, 5, line.opacity == null ? 100 : line.opacity, (v) => v + "%", (v) => (line.opacity = v)));
    body.append(propText("Badge", line.badge || "", (v) => (line.badge = v.trim()), { maxLength: 3, placeholder: "e.g. 9" }));
  });
}
function buildStationsSection(line) {
  const marker = line.marker || "dot";
  return section("stations", "Stations", marker[0].toUpperCase() + marker.slice(1) + " · " + fmt(+line.markerSize || 3.2) + " pt", (body) => {
    body.append(propSeg("Marker", [["dot", "Dot"], ["ring", "Ring"], ["tick", "Tick"]], marker, (v) => commitPick(() => (line.marker = v))));
    body.append(propSlider("Size", 1.5, 8, 0.5, +line.markerSize || 3.2, (v) => v + " pt", (v) => (line.markerSize = v)));
    body.append(propCheck("Interchange rings", line.interchangeRings !== false, (v) => commitPick(() => (line.interchangeRings = v))));
  });
}
function buildLabelsSection(line) {
  return section("labels", "Labels", (+line.labelSize || 9.5) + " pt" + (line.halo === false ? "" : " · halo"), (body) => {
    body.append(propSlider("Size", 7, 16, 0.5, +line.labelSize || 9.5, (v) => v + " pt", (v) => (line.labelSize = v)));
    body.append(propCheck("Halo behind text", line.halo !== false, (v) => commitPick(() => (line.halo = v))));
    body.append(elh("div", "hist-item", "Select a station point to set its label position →"));
  });
}
function buildGeometrySection(line) {
  const b = lineBounds(line);
  const cur = state.snap45 ? (state.snapAngle || "45") : "free";
  return section("geometry", "Geometry", state.snap45 ? (state.snapAngle || "45") + "° snap" : "Free", (body) => {
    body.append(propSeg("Snap", [["45", "45°"], ["30", "30°"], ["90", "90°"], ["free", "Free"]], cur, (v) => {
      if (v === "free") state.snap45 = false; else { state.snap45 = true; state.snapAngle = v; }
      toggleAttr("opt-snap", state.snap45); renderProps(); updateStatus();
    }));
    const bg = elh("div", "bounds-grid");
    bg.append(elh("span", "bl", "X"), elh("span", "bv", Math.round(b.x)),
              elh("span", "bl", "Y"), elh("span", "bv", Math.round(b.y)),
              elh("span", "bl", "W"), elh("span", "bv", Math.round(b.w)),
              elh("span", "bl", "H"), elh("span", "bv", Math.round(b.h)));
    body.append(elh("div", "prow-lab", "Bounds"), bg);
    body.append(propCheck("Closed loop", !!line.closed, (v) => commitPick(() => (line.closed = v))));
    body.append(propCheck("Lock this line", !!line.locked, (v) => { line.locked = v; renderLineList(); renderProps(); }));
  });
}
function buildDocumentSection() {
  return section("document", "Document", (state.gridSize || GRID) + " pt grid", (body) => {
    body.append(propSlider("Grid", 8, 64, 1, state.gridSize || GRID, (v) => v + " pt", (v) => { state.gridSize = v; applyGrid(); }));
    body.append(propSlider("Contrast", 0, 100, 5, state.gridContrast == null ? 55 : state.gridContrast, (v) => v + "%", (v) => { state.gridContrast = v; applyGrid(); }));
    const row = elh("div", "prow"); row.append(elh("span", "prow-lab", "Paper"));
    const strip = elh("div", "paper-strip");
    for (const c of PAPER_STOCKS) {
      const sw = elh("button", "paper-sw" + (ui.paper === c ? " sel" : "")); sw.style.background = c;
      sw.onclick = () => { ui.paper = c; saveUI(); applyPaper(); renderProps(); };
      strip.append(sw);
    }
    row.append(strip); body.append(row);
  });
}
function buildHistorySection() {
  const n = undoStack.length;
  return section("history", "History", n + " step" + (n === 1 ? "" : "s"), (body) => {
    const list = elh("div", "hist-list");
    list.append(elh("div", "hist-item current", "● Current state"));
    for (const entry of undoStack.slice(-8).reverse()) list.append(elh("div", "hist-item", entry.label || "Edit"));
    if (!n) list.append(elh("div", "hist-item", "No history yet"));
    body.append(list);
  });
}

function buildStationSection(line, idx) {
  const p = line.points[idx];
  return section("station", "Station", p.station ? (p.station.type === "major" ? "Major" : "Stop") : "None", (body) => {
    body.append(propSelect("Type", [["none", "No station"], ["normal", "Station"], ["major", "Major (pill)"]],
      p.station ? p.station.type : "none",
      (v) => commitPick(() => {
        if (v === "none") p.station = null;
        else if (!p.station) p.station = { name: "Station", type: v, dir: "e", rot: 0 };
        else p.station.type = v;
      })));
    if (p.station) {
      const st = p.station;
      body.append(propText("Name", st.name || "", (v) => (st.name = v)));
      body.append(propSelect("Position",
        [["e", "Right"], ["w", "Left"], ["n", "Above"], ["s", "Below"], ["ne", "Upper right"], ["nw", "Upper left"], ["se", "Lower right"], ["sw", "Lower left"]],
        st.dir || "e", (v) => commitPick(() => (st.dir = v))));
      body.append(propSlider("Angle", -90, 90, 5, st.rot || 0, (v) => v + "°", (v) => (st.rot = v)));
    }
    const dz = elh("div", "sec-danger");
    const del = elh("button", null, "Delete point");
    del.onclick = () => {
      snapshot();
      line.points.splice(idx, 1);
      if (line.points.length < 2) state.lines = state.lines.filter((l) => l.id !== line.id);
      state.selection = { lineId: line.id };
      validateSelection(); renderAll();
    };
    dz.append(del); body.append(dz);
  });
}
function buildFeatureInspector(hd, box, f) {
  const fs = FEATURE_STYLES[f.kind] || FEATURE_STYLES.water;
  const r1 = elh("div", "ihd-row");
  const chip = elh("div", "insp-color"); chip.style.background = fs.fill; chip.style.borderColor = fs.stroke;
  r1.append(chip, elh("div", "insp-name-static", (fs.label || "Area") + " feature"));
  hd.append(r1);
  box.append(section("feature", "Feature", fs.label, (body) => {
    body.append(propSelect("Kind", [["water", "Water"], ["park", "Park"]], f.kind, (v) => commitPick(() => (f.kind = v))));
    body.append(elh("div", "hist-item", f.points.length + " points · behind the network"));
    const dz = elh("div", "sec-danger");
    const del = elh("button", null, "Delete feature");
    del.onclick = () => { snapshot("Delete feature"); state.features = state.features.filter((x) => x.id !== f.id); state.selection = null; renderAll(); };
    dz.append(del); body.append(dz);
  }));
}
function applyPaper() {
  const c = document.getElementById("canvas");
  if (c) c.style.background = ui.paper;
  const p = document.querySelector(".tr-paper");
  if (p) p.style.background = ui.paper;
}
function hexA(hex, a) {
  const m = /^#?([0-9a-f]{6})$/i.exec(hex || "");
  if (!m) return hex;
  const n = parseInt(m[1], 16);
  return `rgba(${(n >> 16) & 255},${(n >> 8) & 255},${n & 255},${a})`;
}
function applyAccent() {
  const c = ui.accent || ACCENTS.blue;
  const r = document.documentElement.style;
  r.setProperty("--acc", c);
  r.setProperty("--acc-soft", hexA(c, 0.22));
  r.setProperty("--acc-border", hexA(c, 0.9));
}
function applyGrid() {
  const gs = state.gridSize || GRID;
  const op = fmt((state.gridContrast == null ? 55 : state.gridContrast) / 100);
  for (const [id, size] of [["gridpat", gs], ["gridpat-mid", gs * 5], ["gridpat-major", gs * 10]]) {
    const pat = document.getElementById(id);
    if (!pat) continue;
    pat.setAttribute("width", size); pat.setAttribute("height", size);
    const rect = pat.querySelector("rect");
    if (rect) { rect.setAttribute("width", size); rect.setAttribute("height", size); }
    const path = pat.querySelector("path");
    if (path) { path.setAttribute("d", `M ${size} 0 L 0 0 0 ${size}`); path.setAttribute("stroke-opacity", op); }
  }
}

// ---------------------------------------------------------------- hit testing
// Tests against rendered (corridor-offset) geometry so clicks land on the
// track the user sees; indices map back to the raw editable points.
function hitTest(w) {
  const tol = 9 / state.view.scale;
  const visible = state.lines.filter((l) => l.visible !== false);
  const linesOrdered = state.selection
    ? [lineById(state.selection.lineId), ...visible.filter((l) => l.id !== state.selection.lineId)].filter(Boolean)
    : [...visible].reverse();
  for (const line of linesOrdered) {
    const rp = geomCache.get(line.id) || line.points;
    for (let i = 0; i < line.points.length; i++) {
      const p = rp[i] || line.points[i];
      const r = line.points[i].station
        ? stationRadius(line, line.points[i].station) + 4 / state.view.scale : tol;
      if (Math.hypot(w.x - p.x, w.y - p.y) <= Math.max(r, tol))
        return { type: "point", line, index: i };
    }
  }
  for (const line of linesOrdered) {
    const rp = geomCache.get(line.id) || line.points;
    const n = line.closed ? rp.length : rp.length - 1;
    for (let i = 0; i < n; i++) {
      const a = rp[i], b = rp[(i + 1) % rp.length];
      const res = distToSegment(w, a, b);
      if (res.d <= Math.max(line.width / 2 + 3 / state.view.scale, tol))
        return { type: "segment", line, index: i, at: res };
    }
  }
  return null;
}

// ---------------------------------------------------------------- tools & mouse
let mouse = null; // {mode, startClient, startView, line, index, orig, moved}

function setTool(t) {
  if (!TOOL_META[t]) return;
  state.tool = t;
  if (t !== "draw") finishDrawing();
  if (t !== "shapes" && featureDraft) { featureDraft = null; }
  const ids = { select: "tool-select", draw: "tool-draw", station: "tool-station", label: "tool-label", guides: "tool-guides", zoom: "tool-zoom", shapes: "tool-shapes" };
  for (const [tool, id] of Object.entries(ids)) {
    const b = document.getElementById(id); if (b) b.classList.toggle("active", t === tool);
  }
  const shapesBar = document.getElementById("ob-shapes");
  if (shapesBar) shapesBar.classList.toggle("hidden", t !== "shapes");
  svg.classList.toggle("tool-draw", t === "draw" || t === "station" || t === "label" || t === "zoom" || t === "shapes");
  // options-bar tool glyph mirrors the active rail button; name from metadata
  const railBtn = document.getElementById(ids[t]);
  const glyph = document.getElementById("ob-tool-glyph");
  if (railBtn && glyph) glyph.innerHTML = railBtn.innerHTML;
  setText("ob-tool-name", TOOL_META[t].name);
  updateStatus();
  renderOverlay();
}

function startLine() {
  snapshot();
  const used = new Set(state.lines.map((l) => l.color));
  const color = PALETTE.find((c) => !used.has(c)) || PALETTE[state.lines.length % PALETTE.length];
  const line = {
    id: uid(), name: "New Line " + (state.lines.length + 1),
    color, width: 9, badge: "", style: "solid", corner: 16, closed: false, points: [],
  };
  state.lines.push(line);
  drawing = { lineId: line.id, cursor: null };
  state.selection = { lineId: line.id };
  return line;
}

function drawSnap(line, w) {
  const pts = line.points;
  if (pts.length && state.snap45) return snapAngleFn(pts[pts.length - 1], w, state.snapAngle);
  return { x: snap(w.x), y: snap(w.y) };
}

function finishDrawing() {
  if (!drawing) return;
  const line = lineById(drawing.lineId);
  drawing = null;
  if (line) {
    // dedupe consecutive points
    for (let i = line.points.length - 1; i > 0; i--) {
      const a = line.points[i], b = line.points[i - 1];
      if (a.x === b.x && a.y === b.y) line.points.splice(i, 1);
    }
    if (line.points.length < 2) {
      state.lines = state.lines.filter((l) => l.id !== line.id);
      if (state.selection?.lineId === line.id) state.selection = null;
    }
  }
  renderAll();
}
function cancelDrawing(rerender = true) {
  drawing = null;
  if (rerender) renderAll();
}

// ------------------------------------------------------------ pointer input
// Pointer Events unify mouse, pen (Apple Pencil) and touch behind one path, so
// desktop behaviour is unchanged while iPad/Pencil gets first-class support.
const activePointers = new Map(); // pointerId -> { x, y }
let pinch = null;                 // two-finger zoom/pan gesture
let lastTap = null;               // pen/touch double-tap detector: { t, x, y }
let lastDoubleAt = 0;             // guard so a synthesized dblclick can't double-fire

function onPointerDown(e) {
  activePointers.set(e.pointerId, { x: e.clientX, y: e.clientY });

  // A second touch starts a pinch-zoom / two-finger pan; abort any single-pointer op.
  if (e.pointerType === "touch" && activePointers.size === 2) {
    if (mouse) { mouse = null; svg.classList.remove("panning"); }
    const [a, b] = [...activePointers.values()];
    const r = svg.getBoundingClientRect();
    const mcx = (a.x + b.x) / 2 - r.left, mcy = (a.y + b.y) / 2 - r.top;
    pinch = {
      startDist: Math.hypot(a.x - b.x, a.y - b.y) || 1,
      startScale: state.view.scale,
      worldX: (mcx - state.view.x) / state.view.scale,
      worldY: (mcy - state.view.y) / state.view.scale,
    };
    if (drawing) { drawing.cursor = null; renderOverlay(); }
    e.preventDefault();
    return;
  }
  if (activePointers.size > 1) return; // ignore a 3rd+ finger mid-gesture

  try { svg.setPointerCapture(e.pointerId); } catch (_) {}

  // Middle-button, or space+drag, pans (desktop mouse).
  if (e.button === 1 || (e.button === 0 && spaceDown)) {
    mouse = { mode: "pan", startClient: [e.clientX, e.clientY], startView: { ...state.view } };
    svg.classList.add("panning");
    e.preventDefault();
    return;
  }
  if (e.button !== 0) return;

  // Pen/touch double-tap mirrors mouse double-click (finish line / add bend / station).
  if (e.pointerType !== "mouse") {
    const now = performance.now();
    if (lastTap && now - lastTap.t < 300 &&
        Math.hypot(e.clientX - lastTap.x, e.clientY - lastTap.y) < 24) {
      lastTap = null;
      activateDouble(e.clientX, e.clientY);
      return;
    }
    lastTap = { t: now, x: e.clientX, y: e.clientY };
  }

  const w = toWorld(e.clientX, e.clientY);

  if (state.tool === "zoom") {
    zoomAt(e.clientX, e.clientY, e.altKey ? 1 / 1.35 : 1.35);
    return;
  }
  if (state.tool === "shapes") {
    const pt = { x: snap(w.x), y: snap(w.y) };
    if (!featureDraft) featureDraft = { kind: state.featureKind, points: [], cursor: null };
    if (featureDraft.points.length >= 3) {
      const f0 = featureDraft.points[0];
      if (Math.hypot(pt.x - f0.x, pt.y - f0.y) < 12 / state.view.scale) { finishFeature(); return; }
    }
    const last = featureDraft.points[featureDraft.points.length - 1];
    if (!last || last.x !== pt.x || last.y !== pt.y) featureDraft.points.push(pt);
    renderOverlay();
    return;
  }
  if (state.tool === "label") {
    const hit = hitTest(w);
    if (hit && hit.type === "point" && hit.line.points[hit.index].station) {
      // select the stop and arm a drag to swing its label around (8-way)
      state.selection = { lineId: hit.line.id, pointIndex: hit.index };
      mouse = { mode: "moveLabel", line: hit.line, index: hit.index, startClient: [e.clientX, e.clientY], moved: false };
      renderAll();
    } else if (hit) {
      state.selection = hit.type === "point" ? { lineId: hit.line.id, pointIndex: hit.index } : { lineId: hit.line.id };
      renderAll();
    }
    return;
  }

  if (state.tool === "draw") {
    let line = drawing ? lineById(drawing.lineId) : null;
    if (!line) {
      // clicking an endpoint of an existing open line resumes drawing it
      const hit = hitTest(w);
      if (hit && hit.type === "point" && !hit.line.closed && hit.line.points.length > 1 &&
          (hit.index === 0 || hit.index === hit.line.points.length - 1)) {
        snapshot();
        if (hit.index === 0) hit.line.points.reverse();
        drawing = { lineId: hit.line.id, cursor: null };
        state.selection = { lineId: hit.line.id };
        renderAll();
        return;
      }
      line = startLine();
    }
    const pt = drawSnap(line, w);
    // tapping the first point closes the loop
    if (line.points.length >= 3) {
      const first = line.points[0];
      if (Math.hypot(pt.x - first.x, pt.y - first.y) < 15) {
        line.closed = true;
        finishDrawing();
        return;
      }
    }
    // tapping the last point (the tip you just placed) finishes an open line —
    // the Pencil-friendly "stop drawing" gesture (no right-click on the web).
    if (line.points.length >= 2) {
      const lastP = line.points[line.points.length - 1];
      if (Math.hypot(pt.x - lastP.x, pt.y - lastP.y) < 14 / state.view.scale) {
        finishDrawing();
        return;
      }
    }
    const last = line.points[line.points.length - 1];
    if (!last || last.x !== pt.x || last.y !== pt.y) line.points.push({ ...pt, station: null });
    renderScene(); renderLineList();
    return;
  }

  if (state.tool === "station") {
    const hit = hitTest(w);
    if (hit) {
      snapshot();
      let index = hit.index;
      if (hit.type === "segment") {
        // insert a new point right where the user clicked on the line
        hit.line.points.splice(hit.index + 1, 0, { x: snap(hit.at.x), y: snap(hit.at.y), station: null });
        index = hit.index + 1;
      }
      const p = hit.line.points[index];
      if (!p.station) p.station = { name: "New Station", type: "normal", dir: "e", rot: 0 };
      state.selection = { lineId: hit.line.id, pointIndex: index };
      renderAll();
      const nameInput = document.querySelector('#props input[type="text"]');
      if (nameInput) { nameInput.focus(); nameInput.select(); }
    }
    return;
  }

  // select tool
  const hit = hitTest(w);
  if (hit && hit.line.locked) {
    // locked lines can be selected but not edited on the canvas
    state.selection = hit.type === "point"
      ? { lineId: hit.line.id, pointIndex: hit.index }
      : { lineId: hit.line.id };
    renderAll();
    return;
  }
  if (hit && hit.type === "point") {
    state.selection = { lineId: hit.line.id, pointIndex: hit.index };
    mouse = {
      mode: "movePoint", line: hit.line, index: hit.index,
      startClient: [e.clientX, e.clientY], orig: { ...hit.line.points[hit.index] }, moved: false,
    };
    renderAll();
  } else if (hit && hit.type === "segment") {
    if (e.altKey) {
      // alt-drag a segment: pull out a new bend point right here
      snapshot();
      const pt = { x: snap(hit.at.x), y: snap(hit.at.y), station: null };
      hit.line.points.splice(hit.index + 1, 0, pt);
      state.selection = { lineId: hit.line.id, pointIndex: hit.index + 1 };
      mouse = {
        mode: "movePoint", line: hit.line, index: hit.index + 1,
        startClient: [e.clientX, e.clientY], orig: { ...pt }, moved: false, snapshotted: true,
      };
      renderAll();
      return;
    }
    state.selection = { lineId: hit.line.id };
    mouse = {
      mode: "moveLine", line: hit.line,
      startClient: [e.clientX, e.clientY],
      orig: clone(hit.line.points), moved: false,
    };
    renderAll();
  } else {
    const f = featureAt(w);
    if (f) { state.selection = { featureId: f.id }; renderAll(); return; }
    mouse = { mode: "panMaybe", startClient: [e.clientX, e.clientY], startView: { ...state.view }, moved: false };
  }
}

function onPointerMove(e) {
  if (activePointers.has(e.pointerId)) activePointers.set(e.pointerId, { x: e.clientX, y: e.clientY });

  if (pinch) {
    const pts = [...activePointers.values()];
    if (pts.length >= 2) {
      const [a, b] = pts;
      const dist = Math.hypot(a.x - b.x, a.y - b.y) || 1;
      const r = svg.getBoundingClientRect();
      const mcx = (a.x + b.x) / 2 - r.left, mcy = (a.y + b.y) / 2 - r.top;
      const s1 = Math.min(4, Math.max(0.15, pinch.startScale * dist / pinch.startDist));
      state.view.scale = s1;
      state.view.x = mcx - pinch.worldX * s1;
      state.view.y = mcy - pinch.worldY * s1;
      applyView(); renderOverlay();
    }
    return;
  }

  if (state.tool === "draw" && drawing) {
    const line = lineById(drawing.lineId);
    if (line && line.points.length) {
      drawing.cursor = drawSnap(line, toWorld(e.clientX, e.clientY));
      renderOverlay();
    }
  }
  if (!mouse) return;
  const dxc = e.clientX - mouse.startClient[0];
  const dyc = e.clientY - mouse.startClient[1];
  if (Math.abs(dxc) + Math.abs(dyc) > 3) mouse.moved = true;

  if (mouse.mode === "pan" || mouse.mode === "panMaybe") {
    if (mouse.mode === "panMaybe" && !mouse.moved) return;
    svg.classList.add("panning");
    state.view.x = mouse.startView.x + dxc;
    state.view.y = mouse.startView.y + dyc;
    applyView();
  } else if (mouse.mode === "movePoint") {
    if (!mouse.snapshotted && mouse.moved) { snapshot(); mouse.snapshotted = true; }
    if (!mouse.moved) return;
    const w = toWorld(e.clientX, e.clientY);
    const p = mouse.line.points[mouse.index];
    const sn = objectSnap(w, mouse.line, mouse.index);
    p.x = sn.x; p.y = sn.y;
    renderScene();
  } else if (mouse.mode === "moveLabel") {
    if (!mouse.snapshotted && mouse.moved) { snapshot("Move label"); mouse.snapshotted = true; }
    if (!mouse.moved) return;
    const w = toWorld(e.clientX, e.clientY);
    const p = mouse.line.points[mouse.index], st = p.station;
    if (st) { const d = dirFromVec(w.x - p.x, w.y - p.y); if (d) st.dir = d; renderScene(); }
  } else if (mouse.mode === "moveLine") {
    if (!mouse.snapshotted && mouse.moved) { snapshot(); mouse.snapshotted = true; }
    if (!mouse.moved) return;
    const dx = snap(dxc / state.view.scale), dy = snap(dyc / state.view.scale);
    mouse.line.points.forEach((p, i) => {
      p.x = mouse.orig[i].x + dx;
      p.y = mouse.orig[i].y + dy;
    });
    renderScene();
  }
}

function onPointerUp(e) {
  activePointers.delete(e.pointerId);
  try { svg.releasePointerCapture(e.pointerId); } catch (_) {}
  if (pinch) {
    if (activePointers.size < 2) pinch = null;
    return; // a pinch never falls through to click/drag cleanup
  }
  if (!mouse) return;
  const wasClickOnEmpty = mouse.mode === "panMaybe" && !mouse.moved;
  const mutated = (mouse.mode === "movePoint" || mouse.mode === "moveLine" || mouse.mode === "moveLabel") && mouse.moved;
  svg.classList.remove("panning");
  mouse = null;
  if (wasClickOnEmpty && state.selection) {
    state.selection = null;
    renderAll();
  } else if (mutated) {
    renderAll();
  }
}

svg.addEventListener("pointerdown", onPointerDown);
window.addEventListener("pointermove", onPointerMove);
window.addEventListener("pointerup", onPointerUp);
window.addEventListener("pointercancel", onPointerUp);

// Double-activate: finish a line, or add a bend/station. Reached by mouse
// double-click and by the pen/touch double-tap detected in onPointerDown.
function activateDouble(clientX, clientY) {
  lastDoubleAt = performance.now();
  const w = toWorld(clientX, clientY);
  if (state.tool === "draw") { finishDrawing(); return; }
  if (state.tool === "shapes") { finishFeature(); return; }
  if (state.tool === "zoom") { fitView(); return; }
  const hit = hitTest(w);
  if (hit && hit.type === "point") {
    const p = hit.line.points[hit.index];
    snapshot();
    if (!p.station) p.station = { name: "Station", type: "normal", dir: "e", rot: 0 };
    state.selection = { lineId: hit.line.id, pointIndex: hit.index };
    renderAll();
    const nameInput = document.querySelector('#props input[type="text"]');
    if (nameInput) { nameInput.focus(); nameInput.select(); }
  } else if (hit && hit.type === "segment") {
    snapshot();
    const pt = { x: snap(hit.at.x), y: snap(hit.at.y), station: null };
    hit.line.points.splice(hit.index + 1, 0, pt);
    state.selection = { lineId: hit.line.id, pointIndex: hit.index + 1 };
    renderAll();
  }
}

svg.addEventListener("dblclick", (e) => {
  // Mouse double-click; pen/touch is already handled via double-tap in onPointerDown.
  if (performance.now() - lastDoubleAt < 500) return;
  activateDouble(e.clientX, e.clientY);
});

svg.addEventListener("contextmenu", (e) => {
  e.preventDefault();
  if (drawing) finishDrawing();
});

// On-canvas "Finish line" affordance — pen/touch have no double-click or Enter key.
// Shown only while an open line with ≥2 points is being drawn.
document.getElementById("btn-finish-line").addEventListener("click", () => finishDrawing());
function syncCanvasControls() {
  const btn = document.getElementById("btn-finish-line");
  if (!btn) return;
  const active = state.tool === "draw" && !!drawing &&
    (lineById(drawing.lineId)?.points.length || 0) >= 2;
  btn.classList.toggle("hidden", !active);
}

svg.addEventListener("wheel", (e) => {
  e.preventDefault();
  const factor = Math.exp(-e.deltaY * 0.0015);
  const r = svg.getBoundingClientRect();
  const mx = e.clientX - r.left, my = e.clientY - r.top;
  const s0 = state.view.scale;
  const s1 = Math.min(4, Math.max(0.15, s0 * factor));
  state.view.x = mx - ((mx - state.view.x) / s0) * s1;
  state.view.y = my - ((my - state.view.y) / s0) * s1;
  state.view.scale = s1;
  applyView();
  renderOverlay();
}, { passive: false });

// ---------------------------------------------------------------- keyboard
let spaceDown = false;
window.addEventListener("keydown", (e) => {
  if (e.key === "Escape") {
    closeMenus();
    if (!aboutModal.classList.contains("hidden")) { hideAbout(); return; }
    if (!shortcutsModal.classList.contains("hidden")) { hideShortcuts(); return; }
    const modal = document.getElementById("open-modal");
    if (!modal.classList.contains("hidden")) { modal.classList.add("hidden"); return; }
  }
  const inInput = /^(INPUT|TEXTAREA|SELECT)$/.test(document.activeElement?.tagName || "");
  if (e.code === "Space" && !inInput) { spaceDown = true; e.preventDefault(); }
  if (inInput) {
    if (e.key === "Escape") document.activeElement.blur();
    return;
  }
  if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === "z") {
    e.preventDefault();
    e.shiftKey ? redo() : undo();
    return;
  }
  if ((e.metaKey || e.ctrlKey) && !e.shiftKey) {
    const k = e.key.toLowerCase();
    if (k === "c") { copySelection(); e.preventDefault(); return; }
    if (k === "v") { pasteClipboard(); e.preventDefault(); return; }
    if (k === "d") { duplicateSelectedLine(); e.preventDefault(); return; }
  }
  switch (e.key) {
    case "v": case "V": setTool("select"); break;
    case "d": case "D": setTool("draw"); break;
    case "t": case "T": setTool("label"); break;
    case "z": case "Z": setTool("zoom"); break;
    case "h": case "H": setTool("shapes"); break;
    case "ArrowUp": case "ArrowDown": case "ArrowLeft": case "ArrowRight": {
      const sel = state.selection;
      const line = sel && lineById(sel.lineId);
      if (!line || line.locked) break;
      const d = e.shiftKey ? gridStep() * 5 : gridStep();
      const dx = e.key === "ArrowLeft" ? -d : e.key === "ArrowRight" ? d : 0;
      const dy = e.key === "ArrowUp" ? -d : e.key === "ArrowDown" ? d : 0;
      snapshot("Nudge");
      if (sel.pointIndex != null) { const p = line.points[sel.pointIndex]; p.x += dx; p.y += dy; }
      else line.points.forEach((p) => { p.x += dx; p.y += dy; });
      renderAll();
      e.preventDefault();
      break;
    }
    case "?": showShortcuts(); break;
    case "Enter":
      if (drawing) finishDrawing();
      else if (featureDraft) finishFeature();
      break;
    case "Escape":
      if (drawing) {
        const line = lineById(drawing.lineId);
        if (line && line.points.length > 1) { line.points.pop(); if (drawing) drawing.cursor = null; renderScene(); }
        else finishDrawing();
      } else if (featureDraft) {
        featureDraft.points.pop();
        if (!featureDraft.points.length) featureDraft = null;
        renderOverlay();
      } else if (state.selection) { state.selection = null; renderAll(); }
      break;
    case "Backspace": case "Delete": {
      const sel = state.selection;
      if (!sel) break;
      if (sel.featureId) {
        snapshot("Delete feature");
        state.features = state.features.filter((f) => f.id !== sel.featureId);
        state.selection = null;
        renderAll(); e.preventDefault(); break;
      }
      const line = lineById(sel.lineId);
      if (!line) break;
      snapshot();
      if (sel.pointIndex != null) {
        line.points.splice(sel.pointIndex, 1);
        if (line.points.length < 2) {
          state.lines = state.lines.filter((l) => l.id !== line.id);
          state.selection = null;
        } else state.selection = { lineId: line.id };
      } else {
        state.lines = state.lines.filter((l) => l.id !== line.id);
        state.selection = null;
      }
      renderAll();
      e.preventDefault();
      break;
    }
    case "s": case "S": {
      const sel = state.selection;
      if (!sel || sel.pointIndex == null) { setTool("station"); break; }
      const line = lineById(sel.lineId);
      const p = line?.points[sel.pointIndex];
      if (p) {
        snapshot();
        if (!p.station) p.station = { name: "Station", type: "normal", dir: "e", rot: 0 };
        else if (p.station.type === "normal") p.station.type = "major";
        else p.station = null;
        renderAll();
      }
      break;
    }
    case "g": case "G": setTool("guides"); break;
  }
});
window.addEventListener("keyup", (e) => {
  if (e.code === "Space") spaceDown = false;
});

// ---------------------------------------------------------------- export
function contentBBox() {
  const rb = rawBounds();
  if (!rb) return { x: 0, y: 0, w: 800, h: 600 };
  const m = 130;
  const bb = { x: rb.minX - m, y: rb.minY - m, w: rb.w + 2 * m, h: rb.h + 2 * m };
  if (state.showLegend) {
    const legH = buildLegend(el("g"), 0, 0, rb.w + 80);
    if (legH) bb.h = Math.max(bb.h, rb.maxY + 80 + legH + 30 - bb.y);
  }
  return bb;
}

function buildExportSVG() {
  const bb = contentBBox();
  const ex = el("svg", {
    xmlns: "http://www.w3.org/2000/svg",
    viewBox: `${bb.x} ${bb.y} ${bb.w} ${bb.h}`,
    width: bb.w, height: bb.h,
  });
  ex.append(el("rect", { x: bb.x, y: bb.y, width: bb.w, height: bb.h, fill: "#fbfaf5" }));
  const g = el("g");
  ex.append(g);
  buildScene(g);
  return { svgEl: ex, bb };
}

function download(filename, blob) {
  const a = document.createElement("a");
  a.href = URL.createObjectURL(blob);
  a.download = filename;
  a.click();
  setTimeout(() => URL.revokeObjectURL(a.href), 5000);
}

function exportFileName(ext) {
  return (currentMapName().replace(/[^\w\- ]+/g, "").trim().replace(/\s+/g, "-").toLowerCase() || "railmap") + "." + ext;
}

function exportSVGFile() {
  const { svgEl } = buildExportSVG();
  const xml = new XMLSerializer().serializeToString(svgEl);
  download(exportFileName("svg"), new Blob([xml], { type: "image/svg+xml" }));
  renderScene(); // buildScene refreshed geomCache against export state; re-sync
}

function exportPNGFile() {
  const { svgEl, bb } = buildExportSVG();
  const xml = new XMLSerializer().serializeToString(svgEl);
  const url = URL.createObjectURL(new Blob([xml], { type: "image/svg+xml" }));
  const img = new Image();
  img.onload = () => {
    const scale = 2;
    const c = document.createElement("canvas");
    c.width = bb.w * scale; c.height = bb.h * scale;
    const ctx = c.getContext("2d");
    ctx.fillStyle = "#fbfaf5";
    ctx.fillRect(0, 0, c.width, c.height);
    ctx.drawImage(img, 0, 0, c.width, c.height);
    c.toBlob((blob) => download(exportFileName("png"), blob), "image/png");
    URL.revokeObjectURL(url);
  };
  img.src = url;
  renderScene();
}

function exportJSONFile() {
  download(exportFileName("json"), new Blob([serialize()], { type: "application/json" }));
}

// ---------------------------------------------------------------- toolbar wiring
document.getElementById("tool-select").onclick = () => setTool("select");
document.getElementById("tool-draw").onclick = () => setTool("draw");
document.getElementById("tool-station").onclick = () => setTool("station");
document.getElementById("tool-label").onclick = () => setTool("label");
document.getElementById("tool-guides").onclick = () => setTool("guides");
document.getElementById("tool-zoom").onclick = () => setTool("zoom");
document.getElementById("tool-shapes").onclick = () => setTool("shapes");
document.querySelectorAll("#ob-feature-kind .seg-btn").forEach((b) => {
  b.onclick = () => {
    state.featureKind = b.dataset.kind;
    document.querySelectorAll("#ob-feature-kind .seg-btn").forEach((x) => x.classList.toggle("active", x === b));
    if (featureDraft) { featureDraft.kind = state.featureKind; renderOverlay(); }
  };
});
document.getElementById("btn-undo").onclick = undo;
document.getElementById("btn-redo").onclick = redo;

// options-bar document toggles (custom checkboxes, replace the old <input> boxes)
document.getElementById("opt-grid").onclick = () => { state.showGrid = !state.showGrid; toggleAttr("opt-grid", state.showGrid); applyView(); };
document.getElementById("opt-snap").onclick = () => { state.snap45 = !state.snap45; toggleAttr("opt-snap", state.snap45); updateStatus(); };
document.getElementById("opt-labels").onclick = () => { state.showLineNames = !state.showLineNames; toggleAttr("opt-labels", state.showLineNames); renderScene(); renderNavigator(); };
document.getElementById("opt-legend").onclick = () => { state.showLegend = !state.showLegend; toggleAttr("opt-legend", state.showLegend); renderScene(); };

// lines-panel footer
function newLineTool() { setTool("draw"); }
function duplicateSelectedLine() {
  const line = state.selection && lineById(state.selection.lineId);
  if (!line) { setTool("draw"); return; }
  snapshot();
  const copy = clone(line);
  copy.id = uid();
  copy.name = line.name + " (parallel)";
  copy.badge = "";
  copy.points.forEach((p) => (p.station = null));
  const used = new Set(state.lines.map((l) => l.color));
  copy.color = PALETTE.find((c) => !used.has(c)) || copy.color;
  state.lines.push(copy);
  state.selection = { lineId: copy.id };
  renderAll();
}
function deleteSelectedLine() {
  const line = state.selection && lineById(state.selection.lineId);
  if (!line) return;
  snapshot();
  state.lines = state.lines.filter((l) => l.id !== line.id);
  state.selection = null;
  renderAll();
}
document.getElementById("btn-new-line").onclick = newLineTool;
document.getElementById("btn-dup-line").onclick = duplicateSelectedLine;
document.getElementById("btn-del-line").onclick = deleteSelectedLine;

// clipboard: copy / paste / duplicate the selected line
let clipboard = null;
function copySelection() {
  const line = state.selection && lineById(state.selection.lineId);
  if (line) clipboard = clone(line);
}
function pasteClipboard() {
  if (!clipboard) return;
  snapshot("Paste line");
  const copy = clone(clipboard);
  copy.id = uid();
  copy.name = clipboard.name + " copy";
  copy.visible = true; copy.locked = false;
  copy.points.forEach((p) => { p.x += GRID * 2; p.y += GRID * 2; });
  state.lines.push(copy);
  state.selection = { lineId: copy.id };
  renderAll();
}

// menu-bar dropdowns: Edit / View / Line / Window
setupMenu("btn-edit", "edit-menu", (act) => { if (act === "undo") undo(); else if (act === "redo") redo(); });
setupMenu("btn-view", "view-menu", (act) => {
  if (act === "grid") { state.showGrid = !state.showGrid; toggleAttr("opt-grid", state.showGrid); applyView(); }
  else if (act === "snap") { state.snap45 = !state.snap45; toggleAttr("opt-snap", state.snap45); updateStatus(); }
  else if (act === "labels") { state.showLineNames = !state.showLineNames; toggleAttr("opt-labels", state.showLineNames); renderScene(); renderNavigator(); }
  else if (act === "legend") { state.showLegend = !state.showLegend; toggleAttr("opt-legend", state.showLegend); renderScene(); }
  else if (act === "fit") fitView();
});
setupMenu("btn-line", "line-menu", (act) => {
  if (act === "newline") newLineTool();
  else if (act === "duplicate") duplicateSelectedLine();
  else if (act === "delline") deleteSelectedLine();
});
setupMenu("btn-window", "window-menu", (act) => {
  if (act === "navigator") { ui.showNav = !ui.showNav; saveUI(); renderNavigator(); }
  else if (act.startsWith("accent-")) { ui.accent = ACCENTS[act.slice(7)] || ACCENTS.blue; saveUI(); applyAccent(); }
});
setupMenu("btn-help", "help-menu", (act) => {
  if (act === "shortcuts") showShortcuts();
  else if (act === "about") showAbout();
});

// live pointer readout in the status bar
svg.addEventListener("pointermove", (e) => {
  const w = toWorld(e.clientX, e.clientY);
  setText("sb-pointer", `X ${Math.round(w.x)} · Y ${Math.round(w.y)}`);
});

// guides: drag out of a ruler to create one; drop it back on the ruler to remove it
function startGuideDrag(axis, e) {
  e.preventDefault();
  const at = (ev) => (axis === "y" ? toWorld(ev.clientX, ev.clientY).y : toWorld(ev.clientX, ev.clientY).x);
  const g = { axis, pos: at(e) };
  state.guides.push(g);
  renderOverlay();
  const move = (ev) => { g.pos = at(ev); renderOverlay(); };
  const up = (ev) => {
    window.removeEventListener("pointermove", move);
    window.removeEventListener("pointerup", up);
    const r = svg.getBoundingClientRect();
    const backOnRuler = axis === "y" ? ev.clientY < r.top + 2 : ev.clientX < r.left + 2;
    if (backOnRuler) { state.guides = state.guides.filter((x) => x !== g); renderOverlay(); }
  };
  window.addEventListener("pointermove", move);
  window.addEventListener("pointerup", up);
}
document.querySelector(".ruler-h").addEventListener("pointerdown", (e) => startGuideDrag("y", e));
document.querySelector(".ruler-v").addEventListener("pointerdown", (e) => startGuideDrag("x", e));

function zoomBy(f) {
  const r = svg.getBoundingClientRect();
  zoomAt(r.left + r.width / 2, r.top + r.height / 2, f);
}
function zoomAt(clientX, clientY, f) {
  const r = svg.getBoundingClientRect();
  const mx = clientX - r.left, my = clientY - r.top;
  const s0 = state.view.scale, s1 = Math.min(4, Math.max(0.15, s0 * f));
  state.view.x = mx - ((mx - state.view.x) / s0) * s1;
  state.view.y = my - ((my - state.view.y) / s0) * s1;
  state.view.scale = s1;
  applyView(); renderOverlay();
}
document.getElementById("btn-zoom-in").onclick = () => zoomBy(1.25);
document.getElementById("btn-zoom-out").onclick = () => zoomBy(0.8);
document.getElementById("btn-fit").onclick = fitView;

function fitView() {
  const bb = contentBBox();
  const r = svg.getBoundingClientRect();
  const s = Math.min(4, Math.max(0.15, Math.min(r.width / bb.w, r.height / bb.h)));
  state.view.scale = s;
  state.view.x = (r.width - bb.w * s) / 2 - bb.x * s;
  state.view.y = (r.height - bb.h * s) / 2 - bb.y * s;
  applyView(); renderOverlay();
}

// ---------------------------------------------------------------- file menu & open dialog
function closeMenus() {
  document.querySelectorAll(".menu").forEach((m) => m.classList.add("hidden"));
}
function setupMenu(btnId, menuId, onAct) {
  const btn = document.getElementById(btnId);
  const menu = document.getElementById(menuId);
  btn.onclick = (e) => {
    e.stopPropagation();
    const wasOpen = !menu.classList.contains("hidden");
    closeMenus();
    if (!wasOpen) menu.classList.remove("hidden");
  };
  menu.addEventListener("click", (e) => {
    const act = e.target.closest("[data-act]")?.dataset.act;
    if (!act) return;
    closeMenus();
    onAct(act);
  });
}
document.addEventListener("click", closeMenus);

function fileAction(act) {
  switch (act) {
    case "new": createMap(untitledName(), []); break;
    case "open": showOpenModal(); break;
    case "import": document.getElementById("file-input").click(); break;
    case "json": exportJSONFile(); break;
    case "svg": exportSVGFile(); break;
    case "png": exportPNGFile(); break;
    case "sample": createMap("Sample Map", sampleLines()); break;
    case "clear":
      if (!confirm("Delete all lines on this map? (Undo is available)")) return;
      snapshot();
      state.lines = [];
      state.selection = null;
      cancelDrawing(false);
      renderAll();
      break;
  }
}
setupMenu("btn-file", "file-menu", fileAction);
setupMenu("btn-export", "export-menu", fileAction);

const openModal = document.getElementById("open-modal");
function showOpenModal() {
  const ul = document.getElementById("map-list");
  ul.replaceChildren();
  const maps = loadStore().maps.sort((a, b) => b.updatedAt - a.updatedAt);
  for (const m of maps) {
    const li = document.createElement("li");
    if (m.id === currentMapId) li.classList.add("current");
    const info = document.createElement("div");
    info.className = "minfo";
    const name = document.createElement("div");
    name.className = "mname";
    name.textContent = m.name + (m.id === currentMapId ? "  (current)" : "");
    const meta = document.createElement("div");
    meta.className = "mmeta";
    const stations = m.lines.reduce((n, l) => n + l.points.filter((p) => p.station).length, 0);
    meta.textContent = `${m.lines.length} line${m.lines.length === 1 ? "" : "s"} · ${stations} station${stations === 1 ? "" : "s"} · edited ${new Date(m.updatedAt).toLocaleString()}`;
    info.append(name, meta);
    const del = document.createElement("button");
    del.className = "mdel"; del.textContent = "✕"; del.title = "Delete map";
    del.onclick = (e) => {
      e.stopPropagation();
      if (!confirm(`Delete map "${m.name}"? This cannot be undone.`)) return;
      deleteMap(m.id);
      showOpenModal();
    };
    li.append(info, del);
    li.onclick = () => { hideOpenModal(); openMap(m.id); };
    ul.append(li);
  }
  openModal.classList.remove("hidden");
}
function hideOpenModal() { openModal.classList.add("hidden"); }
document.getElementById("open-close").onclick = hideOpenModal;
openModal.addEventListener("click", (e) => { if (e.target === openModal) hideOpenModal(); });

// ---------------------------------------------------------------- keyboard-shortcuts overlay
const SHORTCUTS = [
  ["Tools", [["V", "Select"], ["D", "Draw"], ["S", "Station · cycle a selected stop"], ["T", "Label"], ["G", "Guides"], ["Z", "Zoom"]]],
  ["Edit", [["⌘Z / ⇧⌘Z", "Undo / Redo"], ["⌫ / Del", "Delete selected point or line"], ["Arrows", "Nudge selection (⇧ = ×5)"], ["Esc", "Cancel drawing · clear selection"]]],
  ["Draw", [["Click", "Place a point"], ["Click first point", "Close a loop"], ["Double-click / Enter", "Finish the line"]]],
  ["Canvas", [["Scroll / pinch", "Zoom"], ["Space-drag · middle-drag", "Pan"], ["Drag from a ruler", "Add a guide"], ["Double-click a segment", "Add a bend point"]]],
];
const shortcutsModal = document.getElementById("shortcuts-modal");
function showShortcuts() {
  const body = document.getElementById("shortcuts-body");
  body.replaceChildren();
  for (const [group, items] of SHORTCUTS) {
    body.append(elh("div", "sc-group", group));
    for (const [k, desc] of items) {
      const r = elh("div", "sc-row");
      r.append(elh("kbd", "sc-key", k), elh("span", "sc-desc", desc));
      body.append(r);
    }
  }
  shortcutsModal.classList.remove("hidden");
}
function hideShortcuts() { shortcutsModal.classList.add("hidden"); }
document.getElementById("shortcuts-close").onclick = hideShortcuts;
shortcutsModal.addEventListener("click", (e) => { if (e.target === shortcutsModal) hideShortcuts(); });

// ---------------------------------------------------------------- about dialog
const aboutModal = document.getElementById("about-modal");
function showAbout() { aboutModal.classList.remove("hidden"); }
function hideAbout() { aboutModal.classList.add("hidden"); }
document.getElementById("about-close").onclick = hideAbout;
aboutModal.addEventListener("click", (e) => { if (e.target === aboutModal) hideAbout(); });

document.getElementById("map-name").addEventListener("input", autosave);
document.getElementById("map-name").addEventListener("keydown", (e) => {
  if (e.key === "Enter") e.target.blur();
});

document.getElementById("file-input").onchange = (e) => {
  const f = e.target.files[0];
  if (!f) return;
  f.text().then((txt) => {
    try {
      const data = parseMapFile(txt);
      createMap(data.name || f.name.replace(/\.json$/i, ""), data.lines, data.features);
    } catch (err) {
      alert("Could not load file: " + err.message);
    }
  });
  e.target.value = "";
};

// ---------------------------------------------------------------- sample map
function st(name, type = "normal", dir = "e", rot = 0) {
  return { name, type, dir, rot };
}
function sampleLines() {
  return [
    {
      id: "L1", name: "Loop Line", color: "#2E9A44", width: 9, badge: "1",
      style: "solid", corner: 18, closed: true,
      points: [
        { x: 480, y: 180, station: st("Kitagawa", "normal", "nw", -30) },
        { x: 600, y: 180, station: st("Northgate", "major", "n", -30) },
        { x: 720, y: 180, station: st("Higashino", "normal", "ne", -30) },
        { x: 880, y: 340, station: st("Mint Hill", "normal", "ne", 0) },
        { x: 880, y: 420, station: st("Eastside", "major", "e", 0) },
        { x: 880, y: 500, station: st("Tannery", "normal", "e", 0) },
        { x: 720, y: 660, station: st("Kaede", "normal", "se", 30) },
        { x: 600, y: 660, station: st("Southport", "major", "s", 30) },
        { x: 480, y: 660, station: st("Willow", "normal", "sw", 30) },
        { x: 320, y: 500, station: st("Aoba", "normal", "w", 0) },
        { x: 320, y: 420, station: st("West Park", "major", "w", 0) },
        { x: 320, y: 340, station: st("Foundry", "normal", "w", 0) },
      ],
    },
    {
      id: "L2", name: "Crosstown Line", color: "#F15A22", width: 9, badge: "2",
      style: "solid", corner: 16, closed: false,
      points: [
        { x: 80, y: 420, station: st("Milldale", "normal", "n", -45) },
        { x: 200, y: 420, station: st("Brickfields", "normal", "n", -45) },
        { x: 320, y: 420, station: null },
        { x: 460, y: 420, station: st("Old Town", "normal", "n", -45) },
        { x: 600, y: 420, station: st("Central", "major", "s", 0) },
        { x: 740, y: 420, station: st("Riverside", "normal", "n", -45) },
        { x: 880, y: 420, station: null },
        { x: 1000, y: 420, station: st("Harbor East", "normal", "n", -45) },
        { x: 1120, y: 420, station: null },
        { x: 1200, y: 340, station: st("Airport ✈", "major", "e", 0) },
      ],
    },
    {
      id: "L3", name: "Northern Line", color: "#E6002D", width: 9, badge: "3",
      style: "solid", corner: 16, closed: false,
      points: [
        { x: 600, y: 40, station: st("Hilltop", "normal", "e", 0) },
        { x: 600, y: 120, station: st("Observatory", "normal", "e", 0) },
        { x: 600, y: 180, station: null },
        { x: 600, y: 300, station: st("Museum", "normal", "e", 0) },
        { x: 600, y: 420, station: null },
        { x: 600, y: 540, station: st("Market", "normal", "e", 0) },
        { x: 600, y: 660, station: null },
        { x: 600, y: 780, station: st("Ferry Quay", "normal", "e", 0) },
        { x: 600, y: 860, station: st("South Pier", "major", "s", 0) },
      ],
    },
    {
      id: "L4", name: "Sakura Shinkansen", color: "#7B1FA2", width: 10, badge: "4",
      style: "stripe", corner: 20, closed: false,
      points: [
        { x: 280, y: 100, station: st("Highlands", "major", "e", 0) },
        { x: 440, y: 260, station: st("Sakura Park", "normal", "nw", 0) },
        { x: 600, y: 420, station: null },
        { x: 760, y: 580, station: st("Stadium", "normal", "se", 0) },
        { x: 920, y: 740, station: st("Seaview", "major", "e", 0) },
      ],
    },
    {
      id: "L5", name: "Yellow Local", color: "#EFC800", width: 9, badge: "5",
      style: "solid", corner: 16, closed: false,
      points: [
        { x: 160, y: 180, station: st("Lakeside", "normal", "s", 0) },
        { x: 300, y: 180, station: st("Foxhill", "normal", "n", -45) },
        { x: 480, y: 180, station: null },
        { x: 600, y: 180, station: null },
        { x: 720, y: 180, station: null },
        { x: 860, y: 180, station: st("Orchard", "normal", "n", -45) },
        { x: 1040, y: 180, station: st("Easton", "normal", "e", 0) },
      ],
    },
    {
      id: "L6", name: "Bay Monorail", color: "#0072BC", width: 9, badge: "6",
      style: "hollow", corner: 16, closed: false,
      points: [
        { x: 160, y: 740, station: st("Westhaven", "normal", "s", 0) },
        { x: 360, y: 740, station: st("Dockyards", "normal", "s", 0) },
        { x: 520, y: 740, station: st("Cannery Row", "normal", "s", 0) },
        { x: 600, y: 660, station: null },
      ],
    },
  ];
}

// ---------------------------------------------------------------- boot
(function boot() {
  loadUI();
  applyAccent();
  applyPaper();
  applyGrid();
  const s = loadStore();
  if (!s.maps.length) {
    // migrate the old single-slot save, if any
    try {
      const legacy = JSON.parse(localStorage.getItem(LEGACY_KEY));
      if (legacy && Array.isArray(legacy.lines) && legacy.lines.length) {
        s.maps.push({ id: "M-legacy", name: "My Map", updatedAt: Date.now(), lines: legacy.lines });
        localStorage.removeItem(LEGACY_KEY);
      }
    } catch (e) { /* ignore corrupted legacy save */ }
  }
  if (!s.maps.length)
    s.maps.push({ id: "M-sample", name: "Sample Map", updatedAt: Date.now(), lines: sampleLines() });
  saveStore(s);
  let cur = null;
  try { cur = localStorage.getItem(CUR_KEY); } catch (e) { /* ignore */ }
  const m = s.maps.find((x) => x.id === cur) || [...s.maps].sort((a, b) => b.updatedAt - a.updatedAt)[0];
  currentMapId = m.id;
  document.getElementById("map-name").value = m.name;
  setLines(clone(m.lines), m.features);
  setTool("select");
  renderAll();
  requestAnimationFrame(fitView);
})();
