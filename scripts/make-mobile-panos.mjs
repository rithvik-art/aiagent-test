#!/usr/bin/env node
/**
 * Downscale large panos into a mobile folder to avoid iOS GPU crashes.
 * - Scans public/experiences/*/panos/*.{webp,jpg,png}
 * - Writes to public/experiences/*/panos-mobile/ with max dimension 4096 px
 * - Keeps format (webp->webp, jpg/png->jpg)
 */
import fs from 'fs';
import path from 'path';
import sharp from 'sharp';

const ROOT = process.cwd();
const EXPERIENCES = path.join(ROOT, 'public', 'experiences');
const MAX_DIM = 4096;

async function* walk(dir){
  const ents = await fs.promises.readdir(dir, { withFileTypes: true });
  for (const e of ents){
    const p = path.join(dir, e.name);
    if (e.isDirectory()) yield* walk(p);
    else yield p;
  }
}

function isPano(file){
  return /[\\/]panos[\\/].+\.(?:webp|jpg|jpeg|png)$/i.test(file);
}

function dstPathFor(src){
  return src.replace(/[\\/]panos[\\/]/i, path.sep + 'panos-mobile' + path.sep)
            .replace(/\.png$/i, '.jpg');
}

async function ensureMobileFor(src){
  const dst = dstPathFor(src);
  await fs.promises.mkdir(path.dirname(dst), { recursive: true });
  try {
    const meta = await sharp(src).metadata();
    const w = Number(meta.width)||0, h = Number(meta.height)||0;
    const scale = Math.min(1, MAX_DIM / Math.max(w, h));
    const pipe = sharp(src).resize({ width: Math.round(w*scale), height: Math.round(h*scale), fit:'inside', withoutEnlargement: true });
    if (/\.webp$/i.test(src)){
      await pipe.webp({ quality: 80 }).toFile(dst.replace(/\.jpg$/i, '.webp'));
      return { dst: dst.replace(/\.jpg$/i, '.webp') };
    }
    await pipe.jpeg({ quality: 85, progressive: true, mozjpeg: true }).toFile(dst);
    return { dst };
  } catch (e) {
    console.error('[make-mobile] failed for', src, e?.message||e);
  }
}

(async()=>{
  let total=0, made=0;
  for await (const f of walk(EXPERIENCES)){
    if (!isPano(f)) continue;
    total++;
    const out = await ensureMobileFor(f);
    if (out) { process.stdout.write('.'); made++; }
  }
  console.log(`\n[mobile-panos] processed:${total} wrote:${made}`);
})().catch((e)=>{ console.error(e); process.exit(1); });

