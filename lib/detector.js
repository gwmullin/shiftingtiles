// Main-thread handle to the detection worker. Detection failures are never
// fatal: detect() resolves to null and the caller falls back to a saliency
// based crop, so the screensaver works even with no model or no network.
import { Worker } from 'node:worker_threads';

const DETECT_TIMEOUT_MS = 180_000; // first call includes model download + warm-up

export function createDetector({ cacheDir, backend = process.env.TFJS_BACKEND || 'wasm', enabled = true, log = console }) {
  if (!enabled) {
    return { get state() { return 'disabled'; }, detect: async () => null, dispose() {} };
  }

  let worker = null;
  let state = 'idle';
  let seq = 0;
  const pending = new Map();

  function fail(reason) {
    state = 'failed';
    log.warn(`detector: ${reason}`);
    for (const p of pending.values()) {
      clearTimeout(p.timer);
      p.resolve(null);
    }
    pending.clear();
    worker = null;
  }

  function ensureWorker() {
    if (worker || state === 'failed') return;
    state = 'loading';
    worker = new Worker(new URL('./detect-worker.js', import.meta.url), {
      workerData: { cacheDir, backend },
    });
    worker.unref();
    worker.on('message', (m) => {
      if (m.type === 'state') {
        state = m.state;
        if (m.error) log.warn(`detector: ${m.error}`);
        if (m.backend) log.info(`detector: model ready (tfjs backend: ${m.backend})`);
        return;
      }
      const p = pending.get(m.id);
      if (!p) return;
      pending.delete(m.id);
      clearTimeout(p.timer);
      if (!m.ok) log.warn(`detector: detection failed: ${m.error}`);
      p.resolve(m.ok ? m.predictions : null);
    });
    worker.on('error', (err) => fail(`worker error: ${err.message}`));
    worker.on('exit', (code) => {
      if (code !== 0 && state !== 'failed') fail(`worker exited with code ${code}`);
    });
  }

  return {
    get state() { return state; },

    // pixels: { data: Uint8Array (RGB), width, height }
    async detect(pixels) {
      if (state === 'failed') return null;
      ensureWorker();
      const id = ++seq;
      const buffer = pixels.data.buffer.slice(
        pixels.data.byteOffset,
        pixels.data.byteOffset + pixels.data.byteLength,
      );
      return new Promise((resolve) => {
        const timer = setTimeout(() => {
          pending.delete(id);
          log.warn('detector: detection timed out');
          resolve(null);
        }, DETECT_TIMEOUT_MS);
        pending.set(id, { resolve, timer });
        worker.postMessage({ type: 'detect', id, width: pixels.width, height: pixels.height, buffer }, [buffer]);
      });
    },

    async dispose() {
      if (worker) await worker.terminate().catch(() => {});
      worker = null;
    },
  };
}
