import { Engine, Scene, FreeCamera, Vector3, MeshBuilder, Color3, Texture, StandardMaterial } from "@babylonjs/core";
import { DynamicTexture } from "@babylonjs/core/Materials/Textures/dynamicTexture";
import "@babylonjs/loaders";
import { loadWalkthrough } from "./walkthrough-loader.js";

// Minimal 3D start hub with a teaser and photoreal-ish chips.
// Returns a promise resolving to { action: 'host'|'solo'|'invite'|'skip' }.
export async function runStartHub({ expId = "meta-model", durationMs = 5000 } = {}) {
  const canvas = document.getElementById("renderCanvas");
  const engine = new Engine(canvas, true, { preserveDrawingBuffer: false, stencil: false });
  const scene = new Scene(engine);
  const cam = new FreeCamera("cam", new Vector3(0, 0, 0), scene);
  cam.attachControl(canvas, true);
  cam.inputs.clear();
  cam.fov = 1.1; cam.minZ = 0.1; cam.maxZ = 50000;

  const BASE_URL = (import.meta?.env?.BASE_URL ?? "/");
  const base = `${BASE_URL}experiences/${expId}`.replace(/\/{2,}/g, "/");
  const SUPPORTS_WEBP = (() => { try { const c = document.createElement('canvas'); return c.toDataURL && c.toDataURL('image/webp').indexOf('image/webp') !== -1; } catch { return false; } })();
  const chooseFile = (f) => SUPPORTS_WEBP ? f : f.replace(/\.webp$/i, '.jpg');
  const panoUrl = (file) => `${base}/panos/${chooseFile(file)}`.replace(/\/{2,}/g, "/");
  const { data } = await loadWalkthrough(`${base}/walkthrough.json`);
  const start = data?.nodes?.find(n => n?.file) || data?.nodes?.[0];

  // Background dome
  const dome = MeshBuilder.CreateSphere("dome", { diameter: 2000, segments: 64, sideOrientation: 1 }, scene);
  dome.rotation.x = Math.PI; dome.isPickable = false;
  const mat = new StandardMaterial("pano", scene);
  mat.disableLighting = true; mat.backFaceCulling = false; mat.disableDepthWrite = true;
  mat.emissiveTexture = new Texture(panoUrl(start?.file || ""), scene, false, false, Texture.TRILINEAR_SAMPLINGMODE);
  mat.emissiveTexture.coordinatesMode = Texture.FIXED_EQUIRECTANGULAR_MODE;
  mat.emissiveTexture.uScale = -1; mat.emissiveTexture.uOffset = 1;
  // Dynamic mono crop for TB stereo; auto-detect by aspect, override via env/query
  const QS = new URLSearchParams(location.search);
  const envHalf = (import.meta?.env?.VITE_INTRO_STEREO_HALF || 'bottom').toLowerCase();
  const qsHalf = (QS.get('introHalf')||'').toLowerCase();
  const pickHalf = (qsHalf==='top'||qsHalf==='bottom')? qsHalf : (envHalf==='top'?'top':'bottom');
  function applyCropBottom(){ mat.emissiveTexture.vScale = -0.5; mat.emissiveTexture.vOffset = 1; }
  function applyCropTop(){ mat.emissiveTexture.vScale = -0.5; mat.emissiveTexture.vOffset = 0.5; }
  function applyFull(){ mat.emissiveTexture.vScale = -1; mat.emissiveTexture.vOffset = 1; }
  try {
    mat.emissiveTexture.onLoadObservable.addOnce(()=>{
      // Ensure any app overlay is hidden once the intro pano is ready
      try { dispatchEvent(new CustomEvent('loading:hide')); } catch {}
      try{
        const sz = mat.emissiveTexture.getBaseSize?.() || mat.emissiveTexture.getSize?.();
        const ratio = (Number(sz?.width)||0) / (Number(sz?.height)||1);
        if (ratio && ratio < 1.3) { (pickHalf==='top'? applyCropTop: applyCropBottom)(); } else { applyFull(); }
      }catch{ (pickHalf==='top'? applyCropTop: applyCropBottom)(); }
    });
  }catch{ (pickHalf==='top'? applyCropTop: applyCropBottom)(); }
  dome.material = mat; dome.renderingGroupId = 0;

  // Build photoreal chips (billboarded plaques)
  function makeChip({ id, label, yaw, pitch }) {
    const plane = MeshBuilder.CreatePlane(`chip_${id}`, { width: 2.4, height: 0.78, sideOrientation: 2 }, scene);
    // Anchor chips to the camera so they're always visible dead‑center/left/right
    plane.parent = cam;
    const slot = (id === 'host') ? -1 : (id === 'invite' ? 1 : 0);
    plane.position.set(slot * 2.8, -0.6, -6.0);
    plane.billboardMode = 7;
    const sm = new StandardMaterial(`chipMat_${id}`, scene);
    sm.disableLighting = true;
    sm.specularColor = new Color3(0,0,0);
    // Label texture (high contrast pill)
    const tex = new DynamicTexture(`chipTex_${id}`, { width: 1024, height: 320 }, scene, true);
    const ctx = tex.getContext();
    ctx.clearRect(0,0,1024,320);
    ctx.fillStyle = "rgba(10,14,28,0.85)"; // dark background
    const r = 64; ctx.beginPath(); ctx.moveTo(r,0); ctx.arcTo(1024,0,1024,320,r); ctx.arcTo(1024,320,0,320,r); ctx.arcTo(0,320,0,0,r); ctx.arcTo(0,0,1024,0,r); ctx.closePath(); ctx.fill();
    ctx.strokeStyle = "rgba(243,196,0,0.8)"; ctx.lineWidth = 8; ctx.stroke();
    ctx.font = "700 120px Inter, ui-sans-serif, system-ui, -apple-system, 'Segoe UI', Roboto";
    ctx.fillStyle = "#ffffff"; ctx.textAlign = "center"; ctx.textBaseline = "middle";
    ctx.fillText(label || id, 512, 160);
    tex.update(false);
    sm.diffuseTexture = tex; sm.opacityTexture = tex; sm.emissiveTexture = tex; sm.alpha = 1;
    plane.material = sm; plane.isPickable = true; plane.metadata = { id, label };
    plane.renderingGroupId = 2; // draw above pano
    return plane;
  }

  let introData = { duration: durationMs, keyframes: [], chips: [] };
  try { const r = await fetch(`${base}/intro.json`, { cache: 'no-store' }); if (r.ok) introData = await r.json(); } catch {}
  let chipData = Array.isArray(introData.chips) ? introData.chips.slice() : [];
  if (!chipData.length) {
    chipData = [
      { id: 'host',   label: 'Host Live Tour', yaw: -0.30, pitch: -0.05 },
      { id: 'solo',   label: 'Explore Solo',   yaw:  0.00, pitch:  0.00 },
      { id: 'invite', label: 'Invite Guests',  yaw:  0.30, pitch: -0.04 },
    ];
  }
  const chips = chipData.map(makeChip);

  // Teaser tween
  const startTime = performance.now();
  function teaserTick() {
    const t = performance.now() - startTime;
    const d = introData.duration || durationMs;
    const k0 = { t: 0, yaw: 0, pitch: 0, fov: 1.1 };
    const k1 = (introData.keyframes || []).slice(-1)[0] || { t: d, yaw: 0.08, pitch: -0.02, fov: 1.05 };
    const a = Math.max(0, Math.min(1, t / Math.max(1, k1.t || d)));
    try { cam.rotation.y = k0.yaw + (k1.yaw - k0.yaw) * a; cam.rotation.x = k0.pitch + (k1.pitch - k0.pitch) * a; cam.fov = k0.fov + (k1.fov - k0.fov) * a; } catch { }
    if (t < d && running) requestAnimationFrame(teaserTick);
  }

  let resolveAction; let running = true;
  const outcome = new Promise(res => resolveAction = res);
  scene.onPointerObservable.add((poi) => {
    if (!running || poi?.pickInfo?.hit !== true) return;
    const id = poi.pickInfo.pickedMesh?.metadata?.id;
    if (id) { running = false; resolveAction({ action: id }); }
  });
  // Allow explicit skip with Escape only
  window.addEventListener('keydown', (e) => { if (e.key === 'Escape' && running) { running = false; resolveAction({ action: 'skip' }); } }, { once: true });

  engine.runRenderLoop(() => scene.render());
  requestAnimationFrame(teaserTick);

  const result = await outcome;
  try { engine.stopRenderLoop(); scene.dispose(); engine.dispose(); } catch { }
  return result;
}
