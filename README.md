# 🚆 RouteMaker

A browser-based designer for beautiful transit / rail network maps — octilinear
colored lines, white station dots, and black "pill" labels for major interchanges.

No build step, no dependencies — plain HTML + SVG + JavaScript, served by nginx.

## Run it

### With Docker (recommended)

The published image is public on GitHub Container Registry, so a single Compose file
works standalone on any machine with Docker — no source code needed:

```bash
docker compose up -d
```

Then visit <http://localhost:8517>. The image is multi-arch, so the same command works
on Intel/AMD and on Apple Silicon / ARM (Raspberry Pi, AWS Graviton, …).

Or run the image directly without Compose:

```bash
docker run -d -p 8517:80 ghcr.io/phdwight/routemaker:latest
```

Update to the newest published image at any time:

```bash
docker compose pull && docker compose up -d
```

### Local development (no Docker)

Serve the folder with any static server:

```bash
python3 -m http.server 8517
```

Then visit <http://localhost:8517>.

## Use it on an iPad (Apple Pencil / touch)

RouteMaker is fully usable with an Apple Pencil or touch — no keyboard required:

- **Draw / edit** — draw and drag with one finger or the Pencil.
- **Zoom & pan** — pinch with two fingers.
- **Finish a line** — double-tap, or tap the floating **✓ Finish line** button that
  appears while drawing.
- **Add a bend / station** — double-tap a segment or point.

A physical keyboard and trackpad (e.g. Magic Keyboard) also work and add the desktop
shortcuts below.

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
- **Lines** — name, preset color palette or custom color, thickness, numbered
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
- **Undo / redo** — ⌘Z / ⇧⌘Z, or the toolbar buttons.
- **File menu** — New map, Open map… (multiple named maps stored in the browser,
  listed with line/station counts and last-edited times), Import JSON file, Save as
  JSON, Export SVG/PNG, New from sample map, Clear all lines. The map name is
  editable in the top bar and becomes the export filename.
- **Export menu** — standalone SVG, 2× PNG, or the JSON project file.
- **Autosave** — every edit is saved automatically to the current map's slot in
  browser storage; switching maps never loses work.
- **Sample map** — a small fictional network loads on first run to start from.

## Your data & multiple users

RouteMaker has **no backend** — every map is stored only in your own browser
(`localStorage`), and nothing is ever uploaded. That means any number of people can use
a shared deployment at the same time with **complete isolation** — no one can see or
overwrite anyone else's maps.

The flip side: there is no server-side backup and no cross-device sync. To back up or
move work, use **Export → JSON**; clearing your browser data (or incognito) removes
local maps.

## Deployment & CI

- **GitHub Actions** ([`.github/workflows/docker-publish.yml`](.github/workflows/docker-publish.yml))
  builds and publishes the image to `ghcr.io/phdwight/routemaker` on every merge.
- Images are **multi-arch** (`linux/amd64` + `linux/arm64`), lean (the Dockerfile
  copies only the app files), and **secret-scanned** in CI.
- The build runs **only when image-affecting files change** (`app.js`, `index.html`,
  `style.css`, `nginx.conf`, `Dockerfile`, `.dockerignore`, or the workflow itself) —
  a docs-only change like editing this README does not rebuild or republish the image.
- `:latest` tracks the `main` branch; `develop` publishes a `:develop` tag.

## Files

- `index.html` — layout and SVG canvas
- `style.css` — dark editor UI
- `app.js` — state, rendering, tools, export
- `Dockerfile` — nginx image that serves the app
- `nginx.conf` — static-file server config (gzip, caching)
- `docker-compose.yml` — standalone, pulls the published image
