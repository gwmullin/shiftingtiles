const express = require('express');
const fs = require('fs');
const fsp = require('fs/promises');
const path = require('path');
const chokidar = require('chokidar');
const {
  loadModels,
  isImageFile,
  processImage,
  removeCacheEntry,
  metadataPath,
  resizedPath,
} = require('./imageProcessor');

const app = express();
const PORT = process.env.PORT || 3000;
const REFRESH_INTERVAL = process.env.REFRESH_INTERVAL || 300000;
const VERBOSE = process.env.VERBOSE === 'true';

const imagesDir = process.env.IMAGES_DIR || path.join(__dirname, 'public', 'images');
const cacheDir = process.env.CACHE_DIR || path.join(__dirname, 'public', 'cache');

const metadataIndex = new Map();
const inFlight = new Map();

function forceProcess(filename) {
  if (inFlight.has(filename)) return inFlight.get(filename);
  const promise = processImage(filename, imagesDir, cacheDir)
    .then(meta => {
      metadataIndex.set(filename, meta);
      return meta;
    })
    .finally(() => {
      inFlight.delete(filename);
    });
  inFlight.set(filename, promise);
  return promise;
}

function ensureProcessed(filename) {
  if (metadataIndex.has(filename)) {
    return Promise.resolve(metadataIndex.get(filename));
  }
  return forceProcess(filename);
}

app.get('/images/:filename', async (req, res, next) => {
  const filename = req.params.filename;
  if (!isImageFile(filename)) return next();

  const sourcePath = path.join(imagesDir, filename);
  const cachedPath = resizedPath(cacheDir, filename);

  try {
    if (fs.existsSync(cachedPath)) {
      if (VERBOSE) console.log(`[VERBOSE] Serving cached image directly: ${filename}`);
      return res.sendFile(cachedPath);
    }
    if (fs.existsSync(sourcePath)) {
      if (VERBOSE) console.log(`[VERBOSE] Cached image not found, processing on-demand: ${filename}`);
      await ensureProcessed(filename);
      return res.sendFile(cachedPath);
    }
    if (VERBOSE) console.log(`[VERBOSE] Source image not found: ${filename}`);
    next();
  } catch (error) {
    console.error('Error processing image:', error);
    next();
  }
});

app.use(express.static('public'));

app.get('/api/images', (req, res) => {
  const items = [];
  for (const [filename, meta] of metadataIndex) {
    items.push({
      src: 'images/' + filename,
      focal: meta.focal,
      aspect: meta.aspect,
      faceCount: meta.faces.length,
    });
  }
  res.json(items);
});

app.get('/api/config', (req, res) => {
  res.json({ refreshInterval: parseInt(REFRESH_INTERVAL, 10) });
});

async function loadExistingMetadata() {
  let entries;
  try {
    entries = await fsp.readdir(cacheDir);
  } catch {
    return 0;
  }
  let loaded = 0;
  for (const file of entries) {
    if (!file.endsWith('.json')) continue;
    try {
      const data = await fsp.readFile(path.join(cacheDir, file), 'utf8');
      const meta = JSON.parse(data);
      if (meta && meta.filename) {
        metadataIndex.set(meta.filename, meta);
        loaded++;
      }
    } catch {
      // skip corrupt entries; will be regenerated
    }
  }
  return loaded;
}

function setupWatcher() {
  const watcher = chokidar.watch(imagesDir, {
    ignored: /(^|[\/\\])\../,
    ignoreInitial: true,
    awaitWriteFinish: { stabilityThreshold: 1000, pollInterval: 200 },
  });

  watcher.on('add', async (filePath) => {
    const filename = path.basename(filePath);
    if (!isImageFile(filename)) return;
    console.log(`New image detected: ${filename}`);
    try {
      await ensureProcessed(filename);
      console.log(`  ✓ ${filename}`);
    } catch (err) {
      console.error(`  ✗ ${filename}: ${err.message}`);
    }
  });

  watcher.on('change', async (filePath) => {
    const filename = path.basename(filePath);
    if (!isImageFile(filename)) return;
    console.log(`Image changed: ${filename}`);
    try {
      await forceProcess(filename);
      console.log(`  ✓ ${filename}`);
    } catch (err) {
      console.error(`  ✗ ${filename}: ${err.message}`);
    }
  });

  watcher.on('unlink', async (filePath) => {
    const filename = path.basename(filePath);
    if (!isImageFile(filename)) return;
    console.log(`Image removed: ${filename}`);
    metadataIndex.delete(filename);
    await removeCacheEntry(cacheDir, filename);
  });
}

async function regenerateAll() {
  console.log('Loading face detection models (background)...');
  await loadModels();
  console.log('Models loaded.');

  if (VERBOSE) console.log('[VERBOSE] Starting background regeneration of all images...');
  let entries;
  try {
    entries = await fsp.readdir(imagesDir);
  } catch {
    entries = [];
  }
  const files = entries.filter(isImageFile);
  const sourceSet = new Set(files);

  for (const filename of [...metadataIndex.keys()]) {
    if (!sourceSet.has(filename)) {
      console.log(`Removing orphan cache entry: ${filename}`);
      metadataIndex.delete(filename);
      await removeCacheEntry(cacheDir, filename);
    }
  }

  console.log(`Regenerating ${files.length} images in background...`);
  const t0 = Date.now();
  let done = 0;
  let errors = 0;
  for (const file of files) {
    if (VERBOSE) console.log(`[VERBOSE] Background regenerating: ${file}`);
    try {
      await forceProcess(file);
    } catch (err) {
      errors++;
      console.error(`  ✗ ${file}: ${err.message}`);
    }
    done++;
    if (done % 10 === 0 || done === files.length) {
      console.log(`  regenerated ${done}/${files.length}`);
    }
  }
  const elapsed = ((Date.now() - t0) / 1000).toFixed(1);
  console.log(`Regenerated ${done} images in ${elapsed}s (${errors} errors)`);
}

async function startup() {
  await fsp.mkdir(cacheDir, { recursive: true });
  const loaded = await loadExistingMetadata();
  console.log(`Loaded ${loaded} cached metadata entries.`);

  setupWatcher();

  regenerateAll().catch(err => {
    console.error('Background regeneration failed:', err);
  });
}

app.listen(PORT, () => {
  console.log(`Server is running on port ${PORT}`);
  startup().catch(err => {
    console.error('Startup failed:', err);
    process.exit(1);
  });
});

