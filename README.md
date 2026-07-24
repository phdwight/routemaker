# 🚆 RouteMaker

A browser-based designer for beautiful transit / rail network maps in the style of the
JR East railway network diagram — octilinear colored lines, white station dots, and
black "pill" labels for major interchanges.

No build step, no dependencies — plain HTML + SVG + JavaScript.

## Run it

Serve the folder with any static server and open it in a browser:

```bash
python3 -m http.server 8517
```

Then visit <http://localhost:8517>.

## Features

- **Draw tool (D)** — click to place points. Lines snap to the grid and to 45°
  (octilinear) angles like a real transit diagram. Click the first point to close a
  loop line; double-click / Enter finishes; Esc removes the last point. Existing
  open lines show rings on their endpoints — click one to keep drawing that line
  from either end.
- **Station tool (S)** — click anywhere on a line to add a station at that spot
  (a point is inserted if needed and the name field is focused right away); click an
  existing station to edit it.
- **Select tool (V)** — click lines or points to select, drag to move (grid-snapped),
  ⌥-drag or double-click a segment to pull out a new bend point. With a point
  selected, press **S** to cycle it: no station → station → major station.
- **Stations** — regular stops render as white dots ringed in the line color; major
  interchanges get a large black-ringed circle and a rotatable black pill label.
  Label position (8 compass directions) and angle are editable per station.
- **Lines** — name, color palette (JR-inspired) or custom color, thickness, numbered
  badge, open/closed loop, corner radius (turns are softened with arcs; corners that
  hold stations stay sharp so the dot sits on the line), and one of ten textures per
  line: solid, white "shinkansen stripe", dashed, dotted, broken (white ticks),
  hollow (white core), double track, edged (dark outline), diagonal hatch, zigzag.
- **Shared corridors** — lines drawn through the same points automatically fan out
  into parallel tracks with a small gap, like the Tōkyō–Shinagawa trunk. A
  "Duplicate as parallel line" button clones a route into the same corridor.
- **Capsule interchanges** — a major station on a multi-track corridor renders as a
  black-ringed white capsule spanning all the parallel lines.
- **Legend** — auto-generated strip beneath the map (toggleable) with each line's
  texture sample, badge, and name; included in exports.
- **Line names** — drawn at each line's terminus with its colored badge (toggleable).
- **Canvas** — pan (drag empty space or space+drag), scroll to zoom, grid toggle (G),
  fit-to-map button.
- **Undo / redo** — ⌘Z / ⇧⌘Z.
- **File menu** — New map, Open map… (multiple named maps stored in the browser,
  listed with line/station counts and last-edited times), Import JSON file, Save as
  JSON, Export SVG/PNG, New from sample map, Clear all lines. The map name is
  editable in the top bar and becomes the export filename.
- **Export menu** — standalone SVG, 2× PNG, or the JSON project file.
- **Autosave** — every edit is saved automatically to the current map's slot in
  browser storage; switching maps never loses work.
- **Sample map** — a small fictional network loads on first run to start from.

## Files

- `index.html` — layout and SVG canvas
- `style.css` — dark editor UI
- `app.js` — state, rendering, tools, export
