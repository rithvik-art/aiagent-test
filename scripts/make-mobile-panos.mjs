// Downscale large panos into mobile folders (4K/6K) to avoid iOS GPU crashes.
// Scans public/experiences/*/panos/*.{webp,jpg,png} and writes variants.
import fs from 'fs';
import path from 'path';
import sharp from 'sharp';

const ROOT = process.cwd();
const EXPERIENCES = path.join(ROOT, 'public', 'experiences');
const sizesFromEnv = (process.env.PANO_MOBILE_SIZES || process.argv.find(a=>a.startsWith('--sizes='))?.split('=')[1] || '').trim();
const SIZES = sizesFromEnv
  ? sizesFromEnv.split(',').map(s=>parseInt(s,10)).filter(n=>Number.isFinite(n) && n>0)
  : [4096, 6144]; // default: phone + tablet

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

function dstPathFor(src, size){
  const dirName = size >= 6000 ? 'panos-mobile-6k' : (size >= 4096 ? 'panos-mobile' : `panos-${size}`);
  return src.replace(/[\\/]panos[\\/]/i, path.sep + dirName + path.sep)
            .replace(/\.png$/i, '.jpg');
}

async function ensureMobileFor(src){
  try {
    const meta = await sharp(src).metadata();
    const w = Number(meta.width)||0, h = Number(meta.height)||0;
    let wrote = 0;
    for (const MAX_DIM of SIZES){
      const dst = dstPathFor(src, MAX_DIM);
      await fs.promises.mkdir(path.dirname(dst), { recursive: true });
      // Skip if up-to-date
      try {
        const [sSrc, sDst] = await Promise.all([fs.promises.stat(src), fs.promises.stat(dst)]);
        if (+sDst.mtime >= +sSrc.mtime) continue;
      } catch {}
      const scale = Math.min(1, MAX_DIM / Math.max(w, h));
      const pipe = sharp(src)
        .resize({ width: Math.round(w*scale), height: Math.round(h*scale), fit:'inside', withoutEnlargement: true, kernel: sharp.kernel.lanczos3 })
        .sharpen(0.6);
      if (/\.webp$/i.test(src)){
        const out = dst.replace(/\.jpg$/i, '.webp');
        await pipe.webp({ quality: 90, nearLossless: true, effort: 4, smartSubsample: true }).toFile(out);
      } else {
        await pipe.jpeg({ quality: 92, mozjpeg: true, progressive: true, chromaSubsampling: '4:4:4' }).toFile(dst);
      }
      wrote++;
    }
    return wrote;
  } catch (e) {
    console.error('[make-mobile] failed for', src, e?.message||e);
    return 0;
  }
}

(async()=>{
  let total=0, made=0;
  for await (const f of walk(EXPERIENCES)){
    if (!isPano(f)) continue;
    total++;
    const count = await ensureMobileFor(f);
    if (count>0) { process.stdout.write('.'); made+=count; }
  }
  console.log(`\n[mobile-panos] processed:${total} files, variants written:${made}`);
})().catch((e)=>{ console.error(e); process.exit(1); });
