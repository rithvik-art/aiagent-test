#!/usr/bin/env node
/**
 * Generate JPEG fallbacks for all WebP panos so that older Safari/iOS loads.
 * - Scans public/experiences/(*)/panos/(*) .webp
 * - Writes JPG alongside if missing or older than source
 */
import fs from 'fs';
import path from 'path';
import sharp from 'sharp';

const ROOT = process.cwd();
const GLOB_ROOT = path.join(ROOT, 'public', 'experiences');

async function* walk(dir){
  const ents = await fs.promises.readdir(dir, { withFileTypes: true });
  for (const e of ents){
    const p = path.join(dir, e.name);
    if (e.isDirectory()) yield* walk(p);
    else yield p;
  }
}

function isWebpPano(p){
  return /[\\/]panos[\\/].+\.webp$/i.test(p);
}

async function ensureJpegFor(webpPath){
  const jpgPath = webpPath.replace(/\.webp$/i, '.jpg');
  try{
    const [srcStat, dstStat] = await Promise.allSettled([
      fs.promises.stat(webpPath),
      fs.promises.stat(jpgPath),
    ]);
    if (dstStat.status === 'fulfilled'){
      if (srcStat.status === 'fulfilled' && +srcStat.value.mtime <= +dstStat.value.mtime){
        return { skipped:true, jpgPath };
      }
    }
  }catch{}

  await fs.promises.mkdir(path.dirname(jpgPath), { recursive: true });
  await sharp(webpPath)
    .jpeg({ quality: 88, progressive: true, mozjpeg: true })
    .toFile(jpgPath);
  return { created:true, jpgPath };
}

(async () => {
  let total=0, created=0, skipped=0;
  for await (const file of walk(GLOB_ROOT)){
    if (!isWebpPano(file)) continue;
    total++;
    try{
      const res = await ensureJpegFor(file);
      if (res.created) created++; else skipped++;
      process.stdout.write('.');
    }catch(err){
      console.error('\n[make-jpeg-fallbacks] failed for', file, err.message);
    }
  }
  console.log(`\n[jpeg-fallbacks] total:${total} created:${created} skipped:${skipped}`);
})().catch((e)=>{ console.error(e); process.exit(1); });
