// Per-image processing pipeline: resize to display dimensions, detect faces
// and pets to pick a focal point, and emit a metadata record.
import path from 'node:path';
import sharp from 'sharp';

// Bump to force reprocessing of every image when the pipeline changes.
export const META_VERSION = 1;

const DETECT_SIZE = 512; // longest edge fed to the object detector

// coco-ssd classes treated as subjects worth centering on.
const SUBJECT_KINDS = {
  person: 'face',
  cat: 'pet',
  dog: 'pet',
  bird: 'pet',
  horse: 'pet',
  sheep: 'pet',
  cow: 'pet',
};

const clamp01 = (v) => Math.min(1, Math.max(0, v));
const pct = (v) => Math.round(clamp01(v) * 1000) / 10;

export async function processImage({ absPath, rel, id, stat, cacheDir, detector, opts, log = console }) {
  const img = sharp(absPath, { failOn: 'none' }).rotate(); // honor EXIF orientation
  const meta = await img.metadata();
  if (!meta.width || !meta.height) throw new Error('could not read image dimensions');

  // metadata() reports pre-rotation dimensions; swap for rotated orientations
  let srcWidth = meta.width;
  let srcHeight = meta.height;
  if ((meta.orientation || 1) >= 5) [srcWidth, srcHeight] = [srcHeight, srcWidth];

  const panorama = srcWidth / srcHeight >= opts.panoAspect;
  const maxWidth = panorama ? opts.panoMaxWidth : opts.maxWidth;
  const scale = Math.min(1, opts.maxHeight / srcHeight, maxWidth / srcWidth);
  const width = Math.max(1, Math.round(srcWidth * scale));
  const height = Math.max(1, Math.round(srcHeight * scale));

  await img.clone()
    .resize(width, height)
    .webp({ quality: opts.webpQuality })
    .toFile(path.join(cacheDir, 'img', `${id}.webp`));

  let subjects = [];
  let focus = null;
  let focusSource = 'center';
  try {
    const det = await img.clone()
      .resize({ width: DETECT_SIZE, height: DETECT_SIZE, fit: 'inside', withoutEnlargement: true })
      .removeAlpha()
      .toColourspace('srgb')
      .raw()
      .toBuffer({ resolveWithObject: true });
    const predictions = await detector.detect({ data: det.data, width: det.info.width, height: det.info.height });
    if (predictions) {
      subjects = toSubjects(predictions, det.info.width, det.info.height);
      if (subjects.length) {
        focus = focusFromSubjects(subjects);
        focusSource = 'detection';
      }
    }
  } catch (err) {
    log.warn(`detection skipped for ${rel}: ${err.message}`);
  }

  if (!focus) {
    try {
      focus = await attentionFocus(img, srcWidth, srcHeight);
      focusSource = 'attention';
    } catch {
      focus = { x: 0.5, y: 0.5 };
    }
  }

  return {
    v: META_VERSION,
    id,
    src: rel,
    mtimeMs: stat.mtimeMs,
    size: stat.size,
    srcWidth,
    srcHeight,
    width,
    height,
    panorama,
    focusX: pct(focus.x),
    focusY: pct(focus.y),
    focusSource,
    subjects: subjects.map((s) => ({ kind: s.kind, class: s.class, score: Math.round(s.score * 100) / 100 })),
    processedAt: new Date().toISOString(),
  };
}

// Convert raw coco-ssd predictions into normalized subject centers. For
// people, bias the center toward the top of the bounding box where the face
// is; for animals, use the box center.
function toSubjects(predictions, dw, dh) {
  const subjects = [];
  for (const p of predictions) {
    const kind = SUBJECT_KINDS[p.class];
    if (!kind || p.score < 0.4) continue;
    const [x, y, w, h] = p.bbox;
    subjects.push({
      kind,
      class: p.class,
      score: p.score,
      cx: clamp01((x + w / 2) / dw),
      cy: clamp01((y + (p.class === 'person' ? h * 0.25 : h / 2)) / dh),
      w: w / dw,
      h: h / dh,
    });
  }
  return subjects;
}

function focusFromSubjects(subjects) {
  let sx = 0;
  let sy = 0;
  let total = 0;
  for (const s of subjects) {
    const weight = s.score * Math.sqrt(Math.max(s.w * s.h, 1e-6));
    sx += s.cx * weight;
    sy += s.cy * weight;
    total += weight;
  }
  return total ? { x: sx / total, y: sy / total } : null;
}

// Fallback when nothing is detected: let libvips' attention strategy (edge
// density + skin tones) pick a square crop and use its center as the focus.
async function attentionFocus(img, srcWidth, srcHeight) {
  const size = 256;
  const { info } = await img.clone()
    .resize({ width: size, height: size, fit: 'cover', position: sharp.strategy.attention })
    .toBuffer({ resolveWithObject: true });
  const scale = size / Math.min(srcWidth, srcHeight);
  const scaledW = Math.max(size, Math.round(srcWidth * scale));
  const scaledH = Math.max(size, Math.round(srcHeight * scale));
  if (typeof info.attention?.x === 'number') {
    return { x: clamp01(info.attention.x / scaledW), y: clamp01(info.attention.y / scaledH) };
  }
  const left = Math.abs(info.cropOffsetLeft ?? 0);
  const top = Math.abs(info.cropOffsetTop ?? 0);
  return { x: clamp01((left + size / 2) / scaledW), y: clamp01((top + size / 2) / scaledH) };
}
