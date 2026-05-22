const express = require('express');
const fs = require('fs');
const fsp = require('fs/promises');
const path = require('path');
const chokidar = require('chokidar');
const {
  loadModels,
  isImageFile,
  processImage,
  loadMetadata,
  removeCacheEntry,
  wipeCache,
  processAll,
  metadataPath,
  resizedPath,
} = require('./imageProcessor');

const app = express();
const PORT = process.env.PORT || 3000;
const REFRESH_INTERVAL = process.env.REFRESH_INTERVAL || 300000;

const imagesDir = process.env.IMAGES_DIR || path.join(__dirname, 'public', 'images');
const cacheDir = path.join(__dirname, 'public', 'photos', 'cache');

const metadataIndex = new Map();
const inFlight = new Map();

function ensureProcessed(filename) {
  if (metadataIndex.has(filename)) {
    return Promise.resolve(metadataIndex.get(filename));
  }
  if (inFlight.has(filename)) {
    return inFlight.get(filename);
  }
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

app.get('/images/:filename', async (req, res, next) => {
  const filename = req.params.filename;
  if (!isImageFile(filename)) return next();

  const sourcePath = path.join(imagesDir, filename);
  const cachedPath = resizedPath(cacheDir, filename);

  try {
    if (fs.existsSync(cachedPath)) {
      return res.sendFile(cachedPath);
    }
    if (fs.existsSync(sourcePath)) {
      await ensureProcessed(filename);
      return res.sendFile(cachedPath);
    }
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

async function startup() {
  console.log('Loading face detection models...');
  await loadModels();
  console.log('Models loaded.');

  console.log('Wiping cache directory...');
  await wipeCache(cacheDir);

  const entries = await fsp.readdir(imagesDir);
  const files = entries.filter(isImageFile);
  console.log(`Processing ${files.length} images...`);
  const t0 = Date.now();
  const { results, errors } = await processAll(imagesDir, cacheDir, 2);
  for (const [filename, meta] of Object.entries(results)) {
    metadataIndex.set(filename, meta);
  }
  const elapsed = ((Date.now() - t0) / 1000).toFixed(1);
  console.log(`Processed ${Object.keys(results).length} images in ${elapsed}s (${errors.length} errors)`);

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
    metadataIndex.delete(filename);
    await removeCacheEntry(cacheDir, filename);
    try {
      await ensureProcessed(filename);
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

app.listen(PORT, () => {
  console.log(`Server is running on port ${PORT}`);
  startup().catch(err => {
    console.error('Startup failed:', err);
    process.exit(1);
  });
});
