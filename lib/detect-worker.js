// Worker thread that runs coco-ssd object detection on raw RGB pixel buffers.
// Runs on the tfjs WASM backend (plain CPU, portable across architectures),
// falling back to the pure-JS CPU backend if WASM is unavailable.
import { parentPort, workerData } from 'node:worker_threads';
import { createHash } from 'node:crypto';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const { cacheDir, backend } = workerData;
const modelDir = path.join(cacheDir, 'models');
const realFetch = globalThis.fetch;

function respond(buf, url) {
  const type = url.endsWith('.wasm') ? 'application/wasm'
    : url.endsWith('.json') ? 'application/json'
    : 'application/octet-stream';
  return new Response(buf, { status: 200, headers: { 'Content-Type': type } });
}

// tfjs loads model weights and wasm binaries via fetch. Serve local files from
// disk and cache remote model files under CACHE_DIR/models so the model only
// has to be downloaded once.
globalThis.fetch = async (resource, init) => {
  const url = String(resource instanceof Request ? resource.url : resource);
  if (/^https?:/i.test(url)) {
    const file = path.join(modelDir, createHash('sha1').update(url).digest('hex'));
    try {
      return respond(await readFile(file), url);
    } catch {
      // not cached yet
    }
    const res = await realFetch(resource, init);
    if (!res.ok) return res;
    const buf = Buffer.from(await res.arrayBuffer());
    await mkdir(modelDir, { recursive: true });
    await writeFile(file, buf);
    return respond(buf, url);
  }
  const p = url.startsWith('file:') ? fileURLToPath(url) : url;
  return respond(await readFile(p), url);
};

let ready = null;

async function getModel() {
  ready ??= (async () => {
    const tf = await import('@tensorflow/tfjs');
    let active = 'cpu';
    if (backend !== 'cpu') {
      try {
        const wasm = await import('@tensorflow/tfjs-backend-wasm');
        const require = createRequire(import.meta.url);
        const dist = path.dirname(require.resolve('@tensorflow/tfjs-backend-wasm'));
        wasm.setWasmPaths(dist + path.sep);
        if (await tf.setBackend('wasm')) active = 'wasm';
      } catch (err) {
        parentPort.postMessage({ type: 'state', state: 'loading', error: `wasm backend unavailable, using cpu: ${err.message}` });
      }
    }
    if (active === 'cpu') await tf.setBackend('cpu');
    await tf.ready();
    const cocoSsd = await import('@tensorflow-models/coco-ssd');
    const model = await cocoSsd.load({ base: 'lite_mobilenet_v2' });
    parentPort.postMessage({ type: 'state', state: 'ready', backend: active });
    return { tf, model };
  })();
  return ready;
}

parentPort.postMessage({ type: 'state', state: 'loading' });

parentPort.on('message', async (msg) => {
  if (msg.type !== 'detect') return;
  try {
    const { tf, model } = await getModel();
    const input = tf.tensor3d(new Uint8Array(msg.buffer), [msg.height, msg.width, 3], 'int32');
    try {
      const predictions = await model.detect(input, 20, 0.35);
      parentPort.postMessage({ type: 'result', id: msg.id, ok: true, predictions });
    } finally {
      input.dispose();
    }
  } catch (err) {
    parentPort.postMessage({ type: 'result', id: msg.id, ok: false, error: err.message });
  }
});
