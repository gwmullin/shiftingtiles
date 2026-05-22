const express = require('express');
const fs = require('fs');
const path = require('path');

const app = express();
const PORT = process.env.PORT || 3000;
const REFRESH_INTERVAL = process.env.REFRESH_INTERVAL || 300000; // 5 minutes in ms

// Serve static files from the 'public' directory
app.use(express.static('public'));

// Endpoint to provide the list of images
app.get('/api/images', (req, res) => {
  const imagesDir = path.join(__dirname, 'public', 'images');
  
  fs.readdir(imagesDir, (err, files) => {
    if (err) {
      console.error('Error reading images directory:', err);
      return res.status(500).json({ error: 'Failed to read images' });
    }

    // Filter for image files
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
