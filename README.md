[Shifting Tiles]
=============

Shifting Tiles is a gallery that looks like the OS X Mountain Lion's Shifting Tiles screensaver. This amazing screensaver is just so nice, it needs a web-implementation.

## Architecture

This application has been rewritten to run as a standalone **Node.js** server inside a **Docker** container. It automatically discovers any image files placed in the `public/images` directory and serves them to the frontend gallery. 

The frontend will auto-refresh its image list dynamically based on a configurable interval (defaulting to 5 minutes) without requiring a server restart.

## Running Locally

To run the application locally without Docker:

```bash
npm install
npm start
```
The server will start on port `3000`.

## Running with Docker

To build and run the Docker container:

```bash
docker build -t shiftingtiles .
docker run -p 3000:3000 shiftingtiles
```
The application will be accessible at `http://localhost:3000`.

## Adding Images

To add new images, simply drop them into the `public/images` folder. The application will automatically pick them up on its next refresh cycle.
