import { promises as fs } from "fs";
import path from "path";
// Optional sharp import (guard against local install issues)
let _sharp = null;
async function getSharp() {
  if (_sharp !== null) return _sharp;
  try {
    const m = await import('sharp');
    _sharp = m?.default || m;
  } catch {
    _sharp = null;
  }
  return _sharp;
}

const PROJECT_ROOT = process.cwd();
const EXPERIENCES_DIR = path.resolve(PROJECT_ROOT, "public", "experiences");
const MANIFEST_PATH = path.join(EXPERIENCES_DIR, "manifest.json");

const toTitle = (slug = "") =>
  slug
    .split(/[-_\s]+/)
    .filter(Boolean)
    .map((part) => part.charAt(0).toUpperCase() + part.slice(1))
    .join(" ") || slug;

async function readExperienceMeta(dir) {
  const metaFile = path.join(dir, "meta.json");
  try {
    const content = await fs.readFile(metaFile, "utf8");
    const json = JSON.parse(content);
    return {
      label: typeof json.label === "string" ? json.label.trim() : undefined,
      order: Number.isFinite(json.order) ? json.order : undefined,
      // Important: only set when explicitly provided; avoid defaulting to false
      stereo: (typeof json.stereo === "boolean") ? json.stereo : undefined,
    };
  } catch {
    return {};
  }
}

// Heuristics: if any pano file suggests stereo or image aspect ~1:1, mark stereo
async function detectStereoFromPanorama(expDir) {
  const panosDir = path.join(expDir, "panos");
  try {
    const files = await fs.readdir(panosDir);
    const imageFiles = files.filter((f) => /\.(?:jpe?g|png|webp|avif)$/i.test(f));
    if (!imageFiles.length) return false;

    // Filename hints first
    const hintsStereo = /(stereo|topbottom|tb|over[-_ ]?under|ou)/i;
    const hintsMono = /(mono)/i;
    const hinted = imageFiles.find((f) => hintsStereo.test(f) || hintsMono.test(f));
    if (hinted) return hintsStereo.test(hinted) && !hintsMono.test(hinted);

    // Fallback to quick metadata probe on the first image
    const probe = path.join(panosDir, imageFiles[0]);
    try {
      const sharp = await getSharp();
      if (!sharp) return false; // if sharp failed to load, skip probe gracefully
      const meta = await sharp(probe).metadata();
      const w = Number(meta.width) || 0;
      const h = Number(meta.height) || 0;
      if (w && h) {
        const ratio = w / h;
        // Mono equirect ~2:1; TB stereo commonly ~1:1
        if (ratio < 1.3) return true;  // close to square => likely TB stereo
        return false;
      }
    } catch {}
  } catch {}
  return false;
}

async function generateManifest() {
  let entries;
  try {
    entries = await fs.readdir(EXPERIENCES_DIR, { withFileTypes: true });
  } catch (error) {
    if (error.code === "ENOENT") {
      await fs.mkdir(EXPERIENCES_DIR, { recursive: true });
      entries = [];
    } else {
      throw error;
    }
  }

  const experiences = [];
  for (const entry of entries) {
    if (!entry.isDirectory()) continue;
    const id = entry.name;
    const expDir = path.join(EXPERIENCES_DIR, id);
    const meta = await readExperienceMeta(expDir);
    // Stereo precedence: explicit meta.json > auto-detect > default false
    const stereo = (typeof meta.stereo === "boolean") ? meta.stereo : (await detectStereoFromPanorama(expDir));
    experiences.push({
      id,
      label: meta.label || toTitle(id),
      order: meta.order,
      stereo,
    });
  }

  experiences.sort((a, b) => {
    const orderA = Number.isFinite(a.order) ? a.order : Number.POSITIVE_INFINITY;
    const orderB = Number.isFinite(b.order) ? b.order : Number.POSITIVE_INFINITY;
    if (orderA !== orderB) return orderA - orderB;
    return a.label.localeCompare(b.label);
  });

  const payload = { experiences };
  await fs.writeFile(MANIFEST_PATH, `${JSON.stringify(payload, null, 2)}\n`, "utf8");
  console.log(`[manifest] wrote ${experiences.length} experience(s) to ${path.relative(PROJECT_ROOT, MANIFEST_PATH)}`);
}

generateManifest().catch((err) => {
  console.error("Failed to generate experience manifest", err);
  process.exitCode = 1;
});
