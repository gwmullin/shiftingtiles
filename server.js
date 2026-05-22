const express = require('express');
const fs = require('fs');
const path = require('path');
const sharp = require('sharp');

const app = express();
const PORT = process.env.PORT || 3000;
const REFRESH_INTERVAL = process.env.REFRESH_INTERVAL || 300000; // 5 minutes in ms

// Create cache directory if it doesn't exist
const imagesDir = path.join(__dirname, 'public', 'images');
const cacheDir = path.join(__dirname, 'public', 'photos', '.cache');
if (!fs.existsSync(cacheDir)) {
  fs.mkdirSync(cacheDir, { recursive: true });
}

// Intercept image requests to serve resized cached versions
app.get('/images/:filename', async (req, res, next) => {
  const filename = req.params.filename;
  const originalPath = path.join(imagesDir, filename);
  const cachedPath = path.join(cacheDir, filename);

  // Check if it's a valid image file
  const ext = path.extname(filename).toLowerCase();
  if (!['.jpg', '.jpeg', '.png', '.gif', '.webp'].includes(ext)) {
    return next();
  }

  try {
    if (fs.existsSync(cachedPath)) {
      // Serve from cache
      return res.sendFile(cachedPath);
    }

    if (fs.existsSync(originalPath)) {
      // Resize to a maximum convenient size for the largest possible tile.
      // Based on 4K resolution (3840x2160): Max tile width is 40vw (1536px), 
      // max height is 50vh (1080px). We round up to 1920x1080 for graceful scaling.
      await sharp(originalPath)
        .resize({ width: 1920, height: 1080, fit: 'inside', withoutEnlargement: true })
        .toFile(cachedPath);
      
      return res.sendFile(cachedPath);
    }
    
    next();
  } catch (error) {
    console.error('Error processing image:', error);
    next();
  }
});

// Serve static files from the 'public' directory
app.use(express.static('public'));

// Endpoint to provide the list of images
app.get('/api/images', (req, res) => {
  fs.readdir(imagesDir, (err, files) => {
    if (err) {
      console.error('Error reading images directory:', err);
      return res.status(500).json({ error: 'Failed to read images' });
    }

    // Filter for image files, exclude the .cache directory
    const imageFiles = files.filter(file => {
      const ext = path.extname(file).toLowerCase();
      return ['.jpg', '.jpeg', '.png', '.gif'].includes(ext);
    });

    res.json(imageFiles);
  });
});

// Endpoint to provide configuration
app.get('/api/config', (req, res) => {
  res.json({ refreshInterval: parseInt(REFRESH_INTERVAL, 10) });
});

app.listen(PORT, () => {
  console.log(`Server is running on port ${PORT}`);
});
