// Shifting Tiles server: serves the screensaver frontend, a read-only JSON
// API, and processed images. Built on node:http only — no web framework.
//
// Configuration (environment variables):
//   PHOTOS_DIR          folder scanned (recursively) for source images   [/photos]
//   CACHE_DIR           folder for resized images + metadata + models    [/data]
//   PORT                listen port                                      [8080]
//   RESCAN_INTERVAL_SEC periodic rescan of PHOTOS_DIR                    [300]
//   MAX_TILE_HEIGHT     resize cap: tallest displayed tile (px)          [1080]
//   MAX_TILE_WIDTH      resize cap for regular images (px)               [1920]
//   PANO_MAX_WIDTH      resize cap for panoramas (px)                    [5120]
//   PANO_ASPECT         aspect ratio at which an image counts as a pano  [2]
//   WEBP_QUALITY        output quality                                   [80]
//   DETECTOR            set to "off" to disable face/pet detection
//   TFJS_BACKEND        "wasm" (default) or "cpu"
import http from 'node:http';
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { Library } from './lib/library.js';
import { createDetector } from './lib/detector.js';

const log = {
  info: (msg) => console.log(`[${new Date().toISOString()}] ${msg}`),
  warn: (msg) => console.warn(`[${new Date().toISOString()}] WARN ${msg}`),
};

const num = (v, fallback) => (Number.isFinite(Number(v)) && v !== '' && v != null ? Number(v) : fallback);

const PHOTOS_DIR = path.resolve(process.env.PHOTOS_DIR || '/photos');
const CACHE_DIR = path.resolve(process.env.CACHE_DIR || '/data');
const PORT = num(process.env.PORT, 8080);
const PUBLIC_DIR = path.join(path.dirname(fileURLToPath(import.meta.url)), 'public');

const opts = {
  maxHeight: num(process.env.MAX_TILE_HEIGHT, 1080),
  maxWidth: num(process.env.MAX_TILE_WIDTH, 1920),
  panoMaxWidth: num(process.env.PANO_MAX_WIDTH, 5120),
  panoAspect: num(process.env.PANO_ASPECT, 2),
  webpQuality: num(process.env.WEBP_QUALITY, 80),
  rescanIntervalMs: num(process.env.RESCAN_INTERVAL_SEC, 300) * 1000,
};

const detector = createDetector({
  cacheDir: CACHE_DIR,
  enabled: process.env.DETECTOR !== 'off',
  log,
});
const library = new Library({ photosDir: PHOTOS_DIR, cacheDir: CACHE_DIR, detector, opts, log });

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.webp': 'image/webp',
  '.png': 'image/png',
  '.ico': 'image/x-icon',
};

const IMG_ROUTE = /^\/img\/([a-f0-9]{40})\.webp$/;

function sendJson(res, body) {
  const buf = Buffer.from(JSON.stringify(body));
  res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8', 'Content-Length': buf.length, 'Cache-Control': 'no-cache' });
  res.end(buf);
}

function sendError(res, code, message) {
  res.writeHead(code, { 'Content-Type': 'text/plain; charset=utf-8' });
  res.end(message);
}

function sendFile(res, filePath, headers = {}) {
  const stream = fs.createReadStream(filePath);
  stream.on('error', () => sendError(res, 404, 'Not found'));
  stream.once('open', () => {
    res.writeHead(200, { 'Content-Type': MIME[path.extname(filePath).toLowerCase()] || 'application/octet-stream', ...headers });
    stream.pipe(res);
  });
}

function publicMeta(m) {
  return {
    id: m.id,
    url: `/img/${m.id}.webp?v=${m.mtimeMs}`,
    width: m.width,
    height: m.height,
    focusX: m.focusX,
    focusY: m.focusY,
    panorama: m.panorama,
  };
}

const server = http.createServer((req, res) => {
  if (req.method !== 'GET' && req.method !== 'HEAD') {
    res.writeHead(405, { Allow: 'GET, HEAD' });
    return res.end();
  }

  const { pathname } = new URL(req.url, 'http://localhost');

  if (pathname === '/api/images') return sendJson(res, library.list().map(publicMeta));
  if (pathname === '/api/status') return sendJson(res, { ...library.stats(), detector: detector.state });
  if (pathname === '/healthz') return sendError(res, 200, 'ok');

  const img = pathname.match(IMG_ROUTE);
  if (img) {
    return sendFile(res, library.imagePath(img[1]), { 'Cache-Control': 'public, max-age=31536000, immutable' });
  }

  // Static frontend
  const relPath = pathname === '/' ? 'index.html' : pathname.slice(1);
  const filePath = path.normalize(path.join(PUBLIC_DIR, relPath));
  if (!filePath.startsWith(PUBLIC_DIR + path.sep)) return sendError(res, 404, 'Not found');
  return sendFile(res, filePath, { 'Cache-Control': 'no-cache' });
});

await fsp.mkdir(CACHE_DIR, { recursive: true });

server.listen(PORT, () => {
  log.info(`shiftingtiles listening on http://localhost:${PORT}`);
  log.info(`photos: ${PHOTOS_DIR}`);
  log.info(`cache:  ${CACHE_DIR}`);
  library.init().catch((err) => log.warn(`library init failed: ${err.message}`));
});

for (const signal of ['SIGINT', 'SIGTERM']) {
  process.on(signal, async () => {
    log.info(`received ${signal}, shutting down`);
    server.close();
    await detector.dispose();
    process.exit(0);
  });
}
