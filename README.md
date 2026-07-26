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

One GitHub Actions workflow
([`.github/workflows/docker-publish.yml`](.github/workflows/docker-publish.yml))
keeps the **app version, git tag, and container image tag in lockstep**, updated
automatically on every merge to `main`. It runs three jobs:

1. **test** — lint/validate (`node --check app.js`, manifest JSON, semver `VERSION`).
2. **bump** (main only) — version sync is **tag-driven**: the next version is
   `max(latest tag's patch + 1, committed VERSION floor)`, seeded from `VERSION` for
   the first release (`1.0.0`). It pushes the annotated tag `vX.Y.Z` onto the merge
   commit. Only a **tag** is pushed — no commit to protected `main`.
3. **build & publish** — checks out the bump's commit, **bakes the resolved version
   into the image's `VERSION`**, and publishes multi-arch (`amd64` + `arm64`) images
   tagged `:X.Y.Z` **and** `:latest`. It then verifies the `VERSION` inside the image
   matches the tag exactly, and secret-scans the image.

Because the app fetches `/VERSION` at runtime, the running app always reports the same
version as its image tag and git tag. `develop` publishes a `:develop` tag (no bump).
The build runs only when image-affecting files change (docs-only edits don't republish).

**Versioning knobs**

- **Patch** bumps happen automatically on each merge to `main`.
- For a **minor/major** release, raise the floor by editing `VERSION` (e.g. `1.1.0`)
  on `develop` before merging — the next release uses it.
- **Cut a GitHub release** on an existing tag (the merge already created it):
  `gh release create vX.Y.Z --notes "…"` — never let it create a new tag.
- The in-app version is shown in **Help → About RouteMaker**.

## Files

- `index.html` — layout and SVG canvas
- `style.css` — dark editor UI
- `app.js` — state, rendering, tools, export
- `VERSION` — semver seed/floor; the authoritative version is the latest git tag,
  baked into the image and shown in Help → About
- `Dockerfile` — nginx image that serves the app
- `nginx.conf` — static-file server config (gzip, caching)
- `docker-compose.yml` — standalone, pulls the published image
