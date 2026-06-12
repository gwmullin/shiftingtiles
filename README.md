# Shifting Tiles

A web screensaver inspired by OS X Mountain Lion's *Shifting Tiles*, rewritten
as a self-contained service:

- **No web frameworks.** The frontend is plain HTML/CSS/JavaScript; the server
  uses only `node:http`.
- **Persistent backend.** A Node.js server discovers photos in a folder,
  resizes them, finds faces and pets, and serves the screensaver — no separate
  web server needed.
- **Smart cropping.** Each photo is analyzed (TensorFlow.js + COCO-SSD running
  on the portable WASM/CPU backend) to find people and pets; tiles are centered
  on them. When nothing is detected, libvips' attention-based saliency picks
  the focal point.
- **Panoramas pan.** Extra-wide photos slowly pan left↔right, following the
  row's travel direction.
- **Live settings.** Move the mouse and click the gear to adjust animation
  speed, bounce intensity, bounce behavior (natural / gravity / elastic /
  smooth), image size, and number of rows. Settings persist in the browser.
- **Dynamic library.** New photos dropped into the folder are picked up by a
  filesystem watcher plus a periodic rescan, processed in the background, and
  folded into the running screensaver.

## Run with Docker (recommended)

```sh
docker compose up --build
```

Then open <http://localhost:8080>. By default `./photos` is mounted read-only
as the photo source; edit `docker-compose.yml` to point at your own folder.

The image is platform-independent: it builds and runs unmodified on amd64 and
arm64 (Intel/AMD, Apple Silicon, Raspberry Pi, …). Image processing and
detection are pure CPU — no GPU or hardware-specific acceleration.

## Run directly

```sh
npm install
PHOTOS_DIR=./photos CACHE_DIR=./data node server.js
```

## Configuration (environment variables)

| Variable              | Default   | Purpose                                          |
| --------------------- | --------- | ------------------------------------------------ |
| `PHOTOS_DIR`          | `/photos` | Folder scanned (recursively) for source images   |
| `CACHE_DIR`           | `/data`   | Resized images, metadata, cached detection model |
| `PORT`                | `8080`    | HTTP listen port                                 |
| `RESCAN_INTERVAL_SEC` | `300`     | Periodic rescan of `PHOTOS_DIR`                  |
| `MAX_TILE_HEIGHT`     | `1080`    | Resize cap: tallest displayed tile (px)          |
| `MAX_TILE_WIDTH`      | `1920`    | Resize cap for regular images (px)               |
| `PANO_MAX_WIDTH`      | `5120`    | Resize cap for panoramas (px)                    |
| `PANO_ASPECT`         | `2`       | Aspect ratio at which an image counts as a pano  |
| `WEBP_QUALITY`        | `80`      | Output quality                                   |
| `DETECTOR`            | (on)      | Set to `off` to disable face/pet detection       |
| `TFJS_BACKEND`        | `wasm`    | `wasm` or `cpu`                                  |

The first run downloads the COCO-SSD model (~6 MB) and caches it under
`CACHE_DIR/models`, so subsequent runs work offline.

## API (read-only)

- `GET /api/images` — processed photos with dimensions, focal point, panorama flag
- `GET /api/status` — processing progress and detector state
- `GET /img/<id>.webp` — resized photo
- `GET /healthz` — health check

## Keyboard

- **Space** — shift a tile immediately
