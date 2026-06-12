// Photo library: discovers images in PHOTOS_DIR, keeps processed copies and
// metadata sidecars in CACHE_DIR, and reprocesses when sources change.
// Discovery happens at startup, on filesystem events, and on a periodic
// rescan, so new photos dropped into the folder show up automatically.
import { createHash } from 'node:crypto';
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import { META_VERSION, processImage } from './processor.js';

const IMAGE_EXT = /\.(jpe?g|png|webp|gif|avif|tiff?|bmp)$/i;
const WATCH_DEBOUNCE_MS = 1500;

const idFor = (rel) => createHash('sha1').update(rel).digest('hex');

export class Library {
  #index = new Map(); // id -> metadata (ok: true once processed)
  #pending = new Map(); // rel -> stat, waiting to be processed
  #processing = false;
  #scanning = false;
  #scanQueued = false;
  #watchTimer = null;

  constructor({ photosDir, cacheDir, detector, opts, log = console }) {
    this.photosDir = photosDir;
    this.cacheDir = cacheDir;
    this.imgDir = path.join(cacheDir, 'img');
    this.metaDir = path.join(cacheDir, 'meta');
    this.detector = detector;
    this.opts = opts;
    this.log = log;
  }

  async init() {
    await fsp.mkdir(this.imgDir, { recursive: true });
    await fsp.mkdir(this.metaDir, { recursive: true });
    await this.#loadSidecars();
    this.#watch();
    const timer = setInterval(() => this.scan('periodic'), this.opts.rescanIntervalMs);
    timer.unref();
    await this.scan('startup');
  }

  /** Processed images, ready to serve. */
  list() {
    return [...this.#index.values()].filter((m) => m.ok);
  }

  imagePath(id) {
    return path.join(this.imgDir, `${id}.webp`);
  }

  stats() {
    let processed = 0;
    let failed = 0;
    for (const m of this.#index.values()) m.ok ? processed++ : failed++;
    const pending = this.#pending.size + (this.#processing ? 1 : 0);
    return { total: processed + failed + pending, processed, pending, failed };
  }

  async #loadSidecars() {
    let files = [];
    try {
      files = await fsp.readdir(this.metaDir);
    } catch {
      return;
    }
    for (const f of files) {
      if (!f.endsWith('.json')) continue;
      try {
        const meta = JSON.parse(await fsp.readFile(path.join(this.metaDir, f), 'utf8'));
        if (meta?.id && meta.v === META_VERSION) {
          meta.ok = true;
          this.#index.set(meta.id, meta);
        }
      } catch {
        // corrupt sidecar; the next scan reprocesses the source
      }
    }
    this.log.info(`library: loaded ${this.#index.size} cached image records`);
  }

  async scan(reason) {
    if (this.#scanning) {
      this.#scanQueued = true;
      return;
    }
    this.#scanning = true;
    try {
      const found = new Map(); // rel -> stat
      await this.#walk(this.photosDir, found);

      let queued = 0;
      for (const [rel, stat] of found) {
        const existing = this.#index.get(idFor(rel));
        const current = existing && existing.mtimeMs === stat.mtimeMs && existing.size === stat.size;
        if (!current && !this.#pending.has(rel)) {
          this.#pending.set(rel, stat);
          queued++;
        }
      }

      // Drop records whose source image is gone.
      for (const [id, meta] of this.#index) {
        if (found.has(meta.src)) continue;
        this.#index.delete(id);
        await fsp.rm(this.imagePath(id), { force: true }).catch(() => {});
        await fsp.rm(path.join(this.metaDir, `${id}.json`), { force: true }).catch(() => {});
        this.log.info(`library: removed ${meta.src}`);
      }

      if (queued) this.log.info(`library: scan (${reason}) found ${found.size} images, ${queued} to process`);
      this.#pump();
    } catch (err) {
      this.log.warn(`library: scan failed: ${err.message}`);
    } finally {
      this.#scanning = false;
      if (this.#scanQueued) {
        this.#scanQueued = false;
        this.scan('queued');
      }
    }
  }

  async #walk(dir, found) {
    let entries;
    try {
      entries = await fsp.readdir(dir, { withFileTypes: true });
    } catch (err) {
      this.log.warn(`library: cannot read ${dir}: ${err.message}`);
      return;
    }
    for (const entry of entries) {
      if (entry.name.startsWith('.') || entry.name === 'node_modules') continue;
      const abs = path.join(dir, entry.name);
      if (abs === this.cacheDir) continue;
      if (entry.isDirectory()) {
        await this.#walk(abs, found);
      } else if (entry.isFile() && IMAGE_EXT.test(entry.name)) {
        try {
          const stat = await fsp.stat(abs);
          found.set(path.relative(this.photosDir, abs), stat);
        } catch {
          // disappeared mid-scan
        }
      }
    }
  }

  async #pump() {
    if (this.#processing) return;
    this.#processing = true;
    try {
      while (this.#pending.size) {
        const [rel, stat] = this.#pending.entries().next().value;
        this.#pending.delete(rel);
        const id = idFor(rel);
        try {
          const started = Date.now();
          const meta = await processImage({
            absPath: path.join(this.photosDir, rel),
            rel,
            id,
            stat,
            cacheDir: this.cacheDir,
            detector: this.detector,
            opts: this.opts,
            log: this.log,
          });
          meta.ok = true;
          this.#index.set(id, meta);
          await fsp.writeFile(path.join(this.metaDir, `${id}.json`), JSON.stringify(meta, null, 1));
          const what = meta.subjects.length
            ? meta.subjects.map((s) => s.class).join(', ')
            : meta.focusSource;
          this.log.info(`library: processed ${rel} ${meta.width}x${meta.height}${meta.panorama ? ' pano' : ''} focus=${meta.focusX}%,${meta.focusY}% (${what}) in ${Date.now() - started}ms`);
        } catch (err) {
          // Remember the failure (keyed to mtime/size) so rescans don't retry
          // a broken file forever; it retries if the file changes.
          this.#index.set(id, { v: META_VERSION, id, src: rel, mtimeMs: stat.mtimeMs, size: stat.size, ok: false });
          this.log.warn(`library: failed to process ${rel}: ${err.message}`);
        }
      }
    } finally {
      this.#processing = false;
    }
  }

  #watch() {
    try {
      const watcher = fs.watch(this.photosDir, { recursive: true }, () => {
        clearTimeout(this.#watchTimer);
        this.#watchTimer = setTimeout(() => this.scan('watch'), WATCH_DEBOUNCE_MS);
      });
      watcher.unref();
      watcher.on('error', (err) => this.log.warn(`library: watcher error: ${err.message}`));
      this.log.info(`library: watching ${this.photosDir} for changes`);
    } catch (err) {
      this.log.warn(`library: fs.watch unavailable (${err.message}); relying on periodic rescan`);
    }
  }
}
