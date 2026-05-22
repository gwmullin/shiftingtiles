const fs = require('fs');
const fsp = require('fs/promises');
const path = require('path');
const sharp = require('sharp');
const faceapi = require('@vladmandic/face-api/dist/face-api.node-wasm.js');
const { setWasmPaths } = require('@tensorflow/tfjs-backend-wasm');
const canvas = require('canvas');

const { Canvas, Image, ImageData } = canvas;
faceapi.env.monkeyPatch({ Canvas, Image, ImageData });

const IMAGE_EXTS = ['.jpg', '.jpeg', '.png', '.gif', '.webp'];
const RESIZE_WIDTH = 1920;
const RESIZE_HEIGHT = 1080;
const DETECTION_SCORE_THRESHOLD = 0.5;

let modelsLoaded = false;

async function loadModels() {
  if (modelsLoaded) return;
  const wasmDir = path.join(__dirname, 'node_modules', '@tensorflow', 'tfjs-backend-wasm', 'dist');
  setWasmPaths(wasmDir + path.sep);
  await faceapi.tf.setBackend('wasm');
  await faceapi.tf.ready();
  const modelPath = path.join(__dirname, 'node_modules', '@vladmandic', 'face-api', 'model');
  await faceapi.nets.ssdMobilenetv1.loadFromDisk(modelPath);
  modelsLoaded = true;
}

function isImageFile(filename) {
  return IMAGE_EXTS.includes(path.extname(filename).toLowerCase());
}

function metadataPath(cacheDir, filename) {
  return path.join(cacheDir, filename + '.json');
}

function resizedPath(cacheDir, filename) {
  return path.join(cacheDir, filename);
}

function computeFocal(faces, imgWidth, imgHeight) {
  if (faces.length === 0) {
    return { x: 0.5, y: 0.5 };
  }
  let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
  for (const f of faces) {
    minX = Math.min(minX, f.box.x);
    minY = Math.min(minY, f.box.y);
    maxX = Math.max(maxX, f.box.x + f.box.width);
    maxY = Math.max(maxY, f.box.y + f.box.height);
  }
  const cx = (minX + maxX) / 2;
  const cy = (minY + maxY) / 2;
  return { x: cx / imgWidth, y: cy / imgHeight };
}

async function processImage(filename, imagesDir, cacheDir) {
  if (VERBOSE) console.log(`[VERBOSE] processImage started for ${filename}`);
  const sourcePath = path.join(imagesDir, filename);
  const stat = await fsp.stat(sourcePath);

  const img = await canvas.loadImage(sourcePath);
  const imgWidth = img.width;
  const imgHeight = img.height;

  const options = new faceapi.SsdMobilenetv1Options({ minConfidence: DETECTION_SCORE_THRESHOLD });
  const detections = await faceapi.detectAllFaces(img, options);

  const faces = detections.map(d => ({
    x: d.box.x / imgWidth,
    y: d.box.y / imgHeight,
    w: d.box.width / imgWidth,
    h: d.box.height / imgHeight,
    score: d.score,
  }));
  const focal = computeFocal(detections, imgWidth, imgHeight);
  if (VERBOSE) console.log(`[VERBOSE] Face detection completed for ${filename}, found ${faces.length} faces`);

  await sharp(sourcePath)
    .resize({ width: RESIZE_WIDTH, height: RESIZE_HEIGHT, fit: 'inside', withoutEnlargement: true })
    .withMetadata()
    .toFile(resizedPath(cacheDir, filename));
  if (VERBOSE) console.log(`[VERBOSE] Image resizing and writing to cache completed for ${filename}`);

  const metadata = {
    filename,
    mtime: stat.mtimeMs,
    srcWidth: imgWidth,
    srcHeight: imgHeight,
    aspect: imgWidth / imgHeight,
    faces,
    focal,
  };

  await fsp.writeFile(metadataPath(cacheDir, filename), JSON.stringify(metadata, null, 2));
  if (VERBOSE) console.log(`[VERBOSE] Metadata saved for ${filename}`);
  return metadata;
}

async function loadMetadata(cacheDir, filename) {
  try {
    if (VERBOSE) console.log(`[VERBOSE] Loading metadata for ${filename}`);
    const data = await fsp.readFile(metadataPath(cacheDir, filename), 'utf8');
    return JSON.parse(data);
  } catch {
    return null;
  }
}

async function removeCacheEntry(cacheDir, filename) {
  await Promise.allSettled([
    fsp.unlink(resizedPath(cacheDir, filename)),
    fsp.unlink(metadataPath(cacheDir, filename)),
  ]);
}

async function wipeCache(cacheDir) {
  await fsp.rm(cacheDir, { recursive: true, force: true });
  await fsp.mkdir(cacheDir, { recursive: true });
}

async function processAll(imagesDir, cacheDir, concurrency = 2) {
  const entries = await fsp.readdir(imagesDir);
  const files = entries.filter(isImageFile);

  let inFlight = 0;
  let idx = 0;
  let done = 0;
  const results = {};
  const errors = [];

  return new Promise((resolve) => {
    const launchNext = () => {
      while (inFlight < concurrency && idx < files.length) {
        const file = files[idx++];
        inFlight++;
        processImage(file, imagesDir, cacheDir)
          .then(meta => {
            results[file] = meta;
          })
          .catch(err => {
            errors.push({ file, err });
            console.error(`  ✗ ${file}: ${err.message}`);
          })
          .finally(() => {
            inFlight--;
            done++;
            if (done % 5 === 0 || done === files.length) {
              console.log(`  processed ${done}/${files.length}`);
            }
            if (done === files.length) {
              resolve({ results, errors });
            } else {
              launchNext();
            }
          });
      }
    };

    if (files.length === 0) {
      resolve({ results, errors });
    } else {
      launchNext();
    }
  });
}

module.exports = {
  loadModels,
  isImageFile,
  processImage,
  loadMetadata,
  removeCacheEntry,
  wipeCache,
  processAll,
  metadataPath,
  resizedPath,
  IMAGE_EXTS,
};
