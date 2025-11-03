import {
  Engine, Scene, FreeCamera, WebXRState, Vector3, MeshBuilder, Mesh, Color4,
  StandardMaterial, Texture, Material, TransformNode
} from "@babylonjs/core";
// Register glTF/GLB loader (prevents controller/hand model warnings)
import "@babylonjs/loaders";
import { PhotoDome } from "@babylonjs/core/Helpers/photoDome";
import { loadWalkthrough } from "./walkthrough-loader.js";

/* Config */
const FLIP_U = true, FLIP_X = true, DOME_DIAMETER = 2000, FLOOR_HEIGHT_M = 3.0;
const BASE_URL = (import.meta?.env?.BASE_URL ?? "/");
const EXPERIENCE_PREFIX = "experiences/";
const ensureExpPath = (value = "") => {
  const input = String(value || "").trim().replace(/^\/+/, "");
  const slug = input.length ? input : "skywalk";
  return slug.startsWith(EXPERIENCE_PREFIX) ? slug : `${EXPERIENCE_PREFIX}${slug}`.replace(/\/{2,}/g, "/");
};

const createMetaLookup = (list = []) => {
  const map = new Map();
  for (const entry of list) {
    const slug = typeof entry?.id === "string" ? entry.id.trim() : "";
    if (slug) map.set(slug, entry);
  }
  return map;
};

// Detect WebP support (sync)
const SUPPORTS_WEBP = (() => {
  try {
    const c = document.createElement('canvas');
    return c.toDataURL && c.toDataURL('image/webp').indexOf('image/webp') !== -1;
  } catch { return false; }
})();
const chooseFile = (f, preferOriginal = false) => {
  if (!f) return f;
  if (!SUPPORTS_WEBP || preferOriginal) {
    return f.replace(/\.webp$/i, '.jpg');
  }
  return f;
};

export async function initViewer({ roomId = "demo", exp, experienceId, experiencesMeta = [] } = {}) {
  const metaById = createMetaLookup(experiencesMeta);
  const initialTarget = exp ?? experienceId ?? "skywalk";
  let expPath = ensureExpPath(initialTarget);
  let BASE = `${BASE_URL}${expPath}`.replace(/\/{2,}/g, "/");
  const uid = (crypto?.randomUUID?.() || Math.random().toString(36).slice(2));
  const expSlug = () => expPath.split("/").filter(Boolean).pop();
  const currentMeta = () => metaById.get(expSlug()) || {};
  const isStereo = () => Boolean(currentMeta().stereo);
  // Pano directory may switch to a mobile-optimized folder on iOS
  let PANOS_DIR = 'panos';
  const panoUrl = (f) => `${BASE}/${PANOS_DIR}/${chooseFile(f, isStereo())}`.replace(/\/{2,}/g, "/");
  // UA flags (used for iOS memory-safe behavior)
  const UA = (navigator.userAgent || "").toLowerCase();
  const IS_IOS = /iphone|ipad|ipod|ios/.test(UA);
  /* Engine / Scene */
  const canvas = document.getElementById("renderCanvas");
  const engine = new Engine(canvas, true, {
    disableWebGL2Support: IS_IOS,
    powerPreference: IS_IOS ? 'low-power' : 'high-performance',
    premultipliedAlpha: false,
    preserveDrawingBuffer: false,
    stencil: false
  });
  try {
    // Force HQ on request; otherwise cap to 2x for perf
    function determineDpr(){
      const qs = new URLSearchParams(location.search);
      const qOverride = (qs.get('q')||'').toLowerCase();
      const forceHQ = (qs.get('hq') === '1') || (String(import.meta?.env?.VITE_FORCE_HQ||'')==='1') || (qOverride==='high');
      const forceLow = (qOverride==='low');
      const dpr = Math.max(1, window.devicePixelRatio || 1);
      let cap = forceHQ ? 3 : 2;
      if (forceLow) cap = 1; // favor speed on low quality
      const target = Math.min(cap, dpr);
      return IS_IOS ? Math.min(1.2, target) : target;
    }
    engine.setHardwareScalingLevel(1 / determineDpr());
  } catch {}

  function getQuality() {
    try {
      const qs = new URLSearchParams(location.search);
      const override = (qs.get('q') || import.meta?.env?.VITE_QUALITY || 'auto').toLowerCase();
      if (override === 'high' || override === 'auto') return { mips: true, sampling: Texture.TRILINEAR_SAMPLINGMODE, aniso: 8 };
      if (override === 'low')  return { mips: false, sampling: Texture.BILINEAR_SAMPLINGMODE, aniso: 1 };
      const conn = navigator.connection || navigator.webkitConnection || navigator.mozConnection;
      const eff = String(conn?.effectiveType || '').toLowerCase();
      const save = Boolean(conn?.saveData);
      const slow = /^(slow-)?2g|3g$/.test(eff) || save;
      const mem = Number(navigator.deviceMemory || 4);
      if (slow || mem <= 2) return { mips: false, sampling: Texture.BILINEAR_SAMPLINGMODE, aniso: 1 };
      return { mips: true, sampling: Texture.TRILINEAR_SAMPLINGMODE, aniso: 8 };
    } catch { return { mips: true, sampling: Texture.TRILINEAR_SAMPLINGMODE, aniso: 8 }; }
  }
  const scene = new Scene(engine);
  scene.clearColor = new Color4(0, 0, 0, 1);

  const cam = new FreeCamera("cam", new Vector3(0, 0, 0), scene);
  cam.attachControl(canvas, true);
  cam.inputs.clear();
  cam.fov = 1.1;
  cam.minZ = 0.1;
  cam.maxZ = 50000;

  /* Data */
  let data, nodesById, startNodeId;
  try{ window.dispatchEvent(new CustomEvent('loading:show', { detail:{ label: 'Loading tourâ€¦' } })); }catch{}
  ({ data, nodesById, startNodeId } = await loadWalkthrough(`${BASE}/walkthrough.json`));
  try{ window.dispatchEvent(new CustomEvent('loading:hide')); }catch{}
  let currentNodeId = startNodeId;
  // XR travel + drift helpers to improve autoplay experience
  const NAV_DUR_MS = 1000;
  const NAV_PUSH_M = 3.0;
  let worldYaw = 0;
  let navAnimating = false;
  function easeInOutSine(t){ return -(Math.cos(Math.PI*t)-1)/2; }
  function lerp(a,b,t){ return a + (b - a) * Math.max(0, Math.min(1, t)); }
  function lerpAngle(prev, next, alpha){ const TAU=Math.PI*2; let d=(next - prev)%TAU; if(d>Math.PI) d-=TAU; if(d<-Math.PI) d+=TAU; return prev + d * Math.max(0, Math.min(1, alpha)); }
  function cubicBezier(p0,p1,p2,p3,t){ const u=1-t, uu=u*u, tt=t*t; const uuu=uu*u, ttt=tt*t; const out=p0.scale(uuu); out.addInPlace(p1.scale(3*uu*t)); out.addInPlace(p2.scale(3*u*tt)); out.addInPlace(p3.scale(ttt)); return out; }
  function shortestSign(a,b){ const TAU=Math.PI*2; let d=(b-a)%TAU; if(d>Math.PI) d-=TAU; if(d<-Math.PI) d+=TAU; return d>=0?1:-1; }

  // If on iOS or small GPUs, try a mobile-optimized folder (panos-mobile) if present
  async function maybeUseMobilePanos() {
    try {
      const qs = new URLSearchParams(location.search);
      // Only switch to mobile panos when explicitly requested
      const shouldPrefer = qs.get('mobile') === '1';
      if (!shouldPrefer) return;
      const startFile = (nodesById?.get?.(currentNodeId)?.file) || '';
      if (!startFile) { PANOS_DIR = 'panos'; return; }
      // Prefer 6K variant on larger iPads where available
      const preferOriginal = isStereo();
      const probe6k = `${BASE}/panos-mobile-6k/${chooseFile(startFile, preferOriginal)}`.replace(/\/{2,}/g, '/');
      const probe4k = `${BASE}/panos-mobile/${chooseFile(startFile, preferOriginal)}`.replace(/\/{2,}/g, '/');
      {
        const r6 = await fetch(probe6k, { method: 'HEAD', cache: 'no-cache' });
        if (r6.ok) { PANOS_DIR = 'panos-mobile-6k'; return; }
      }
      const r4 = await fetch(probe4k, { method: 'HEAD', cache: 'no-cache' });
      if (r4.ok) { PANOS_DIR = 'panos-mobile'; }
    } catch { /* no-op: keep default */ }
  }
  await maybeUseMobilePanos();

  /* Floors -> world positions */
  const floorIndex = new Map();
  const floorCenters = new Map();
  function rebuildFloorMaps() {
    floorIndex.clear();
    floorCenters.clear();
    data.floors.forEach((f, i) => floorIndex.set(f.id, i));
    for (const f of data.floors) {
      const on = data.nodes.filter((n) => n.floorId === f.id);
      let minX = Infinity, maxX = -Infinity, minY = Infinity, maxY = -Infinity;
      for (const n of on) {
        if (typeof n.x === "number" && typeof n.y === "number") {
          if (n.x < minX) minX = n.x;
          if (n.x > maxX) maxX = n.x;
          if (n.y < minY) minY = n.y;
          if (n.y > maxY) maxY = n.y;
        }
      }
      const ppm = f.pxPerMeter || 100;
      const cx = isFinite(minX) ? (minX + maxX) / 2 : 0;
      const cy = isFinite(minY) ? (minY + maxY) / 2 : 0;
      floorCenters.set(f.id, { cx, cy, ppm });
    }
  }
  rebuildFloorMaps();
  const nodeWorldPos = (n) => {
    const f = floorCenters.get(n.floorId) || { cx: 0, cy: 0, ppm: 100 };
    const idx = floorIndex.get(n.floorId) ?? 0;
    return new Vector3((n.x - f.cx) / f.ppm, idx * FLOOR_HEIGHT_M, (n.y - f.cy) / f.ppm);
  };
  /* Dome */
  const worldRoot = new TransformNode("worldRoot", scene);
  const dome = MeshBuilder.CreateSphere("dome", { diameter: DOME_DIAMETER, segments: 64, sideOrientation: Mesh.BACKSIDE }, scene);
  dome.parent = worldRoot;
  if (FLIP_X) dome.rotation.x = Math.PI;
  // Render 2D dome on aux layer to exclude it from XR camera
  try { dome.layerMask = 0x2; } catch {}

  const domeMat = new StandardMaterial("panoMat", scene);
  domeMat.disableLighting = true;
  domeMat.backFaceCulling = false;
  domeMat.transparencyMode = Material.MATERIAL_ALPHABLEND;
  dome.material = domeMat;

  // Use a PhotoDome for 2D as well to avoid driver/texture edge cases
  const dome2D = new PhotoDome("pd2d", "", { size: DOME_DIAMETER }, scene);
  dome2D.mesh.parent = worldRoot;
  dome2D.mesh.isVisible = true;
  // Keep 2D PhotoDome on aux layer (hidden from XR camera)
  try { dome2D.mesh.layerMask = 0x2; } catch {}
  function set2DStereoMode(){
    try{
      const mode = isStereo() ? PhotoDome.MODE_TOPBOTTOM : PhotoDome.MODE_MONOSCOPIC;
      if ("stereoMode" in dome2D) dome2D.stereoMode = mode; if ("imageMode" in dome2D) dome2D.imageMode = mode;
    }catch{}
  }
  set2DStereoMode();

  // Drag-to-rotate + pinch/wheel zoom for Viewer (2D) â€” immediate (no drift)
  let dragging=false, lastX=0, lastY=0;
  let yawV=0, pitchV=0;
  const yawSpeed=0.005, pitchSpeed=0.003, pitchClamp=Math.PI*0.39;
  function applyCam(){
    const px = Math.max(-pitchClamp, Math.min(pitchClamp, pitchV));
    cam.rotation.y = yawV;
    cam.rotation.x = px;
  }
  const canvas2 = document.getElementById('renderCanvas');
  if (canvas2){
    canvas2.style.cursor='grab';
    const MIN_FOV=0.45, MAX_FOV=1.7; const clampF=(v)=>Math.max(MIN_FOV, Math.min(MAX_FOV, v));
    const touches=new Map(); let pinch=false, pinRef=0, pinBase=cam.fov; const dist=(a,b)=>Math.hypot(a.x-b.x,a.y-b.y)||1;
    canvas2.addEventListener('pointerdown', (e)=>{
      touches.set(e.pointerId, {x:e.clientX, y:e.clientY});
      if (touches.size===2){ const it=[...touches.values()]; pinRef=dist(it[0],it[1]); pinBase=cam.fov; pinch=true; dragging=false; canvas2.style.cursor='grab'; }
      else if (touches.size===1){ dragging=true; lastX=e.clientX; lastY=e.clientY; try{ canvas2.setPointerCapture(e.pointerId); }catch{} canvas2.style.cursor='grabbing'; }
    }, { passive:false });
    canvas2.addEventListener('pointermove', (e)=>{
      const p=touches.get(e.pointerId); if (p){ p.x=e.clientX; p.y=e.clientY; }
      if (pinch && touches.size>=2){ const it=[...touches.values()]; const cur=dist(it[0],it[1]); const scale=Math.max(0.25,Math.min(4,cur/pinRef)); cam.fov = clampF(pinBase*scale); return; }
      if(!dragging) return; const dx=e.clientX-lastX, dy=e.clientY-lastY; lastX=e.clientX; lastY=e.clientY; yawV -= dx*yawSpeed; pitchV -= dy*pitchSpeed; applyCam();
    }, { passive:true });
    function endPtr(){ dragging=false; pinch=false; canvas2.style.cursor='grab'; }
    canvas2.addEventListener('pointerup', (e)=>{ touches.delete(e.pointerId); endPtr(); }, { passive:true });
    canvas2.addEventListener('pointerleave', (e)=>{ touches.delete(e.pointerId); endPtr(); }, { passive:true });
    canvas2.addEventListener('pointercancel', (e)=>{ touches.delete(e.pointerId); endPtr(); }, { passive:true });
    canvas2.addEventListener('wheel', (e)=>{ e.preventDefault(); const step=Math.max(-0.2,Math.min(0.2,(e.deltaY||0)*0.0012)); cam.fov = clampF(cam.fov + step); }, { passive:false });
  }

  // second dome for crossfade in 2D
  // Disable sphere-based crossfade in favor of PhotoDome pipeline (more robust)

  /* Texture cache & mapping */
  // LRU texture cache to prevent unbounded GPU memory growth
  const texCache = new Map();
  const inFlight = new Map();
  const TEX_LIMIT = (()=>{ try{ const ua=(navigator.userAgent||'').toLowerCase(); if(/iphone|ipad|ipod|ios/.test(ua)) return 2; if(/android/.test(ua)) return 8; return 16; }catch{ return 16; } })();
  function touchLRU(key){ if(!texCache.has(key)) return; const v=texCache.get(key); texCache.delete(key); texCache.set(key,v); }
  function evictIfNeeded(curKey){
    try{
      while (texCache.size > TEX_LIMIT){
        const firstKey = texCache.keys().next().value;
        if (!firstKey || firstKey === curKey) break;
        const tex = texCache.get(firstKey);
        try{ tex?.dispose?.(); }catch{}
        texCache.delete(firstKey);
      }
    }catch{}
  }
  function retainOnly(keep){
    try{
      for (const [k, tex] of texCache.entries()){
        if (!keep.has(k)) { try{ tex?.dispose?.(); }catch{} texCache.delete(k); }
      }
    }catch{}
  }
  function retainSW(urls){ try{ navigator.serviceWorker?.controller?.postMessage({ type:'retain', urls }); }catch{} }

  function neighborInfoFor(n, limit = (IS_IOS ? 0 : 2)){
    const out = { files: [], keys: [], urls: [] };
    try{
      const hs = Array.isArray(n?.hotspots) ? n.hotspots : [];
      for (const h of hs){
        if (!h?.to || !nodesById.has(h.to)) continue;
        const f = nodesById.get(h.to).file;
        if (!f || out.files.includes(f)) continue;
        out.files.push(f);
        out.keys.push(`${BASE}|${f}`);
        out.urls.push(panoUrl(f));
        if (out.files.length >= limit) break;
      }
    }catch{}
    return out;
  }
  function retainOnly(keep){
    try{
      for (const [k, tex] of texCache.entries()){
        if (!keep.has(k)) { try{ tex?.dispose?.(); }catch{} texCache.delete(k); }
      }
    }catch{}
  }
  function retainSW(urls){ try{ navigator.serviceWorker?.controller?.postMessage({ type:'retain', urls }); }catch{} }
  function purgeTextures(){
    try{ for (const [k,tex] of texCache.entries()){ try{ tex?.dispose?.(); }catch{} } texCache.clear(); }catch{}
  }
  // Standard texture load: use the file as authored (with simple WebP support toggle from chooseFile)
  async function getTexture(file) {
    const key = `${BASE}|${file}`;
    if (texCache.has(key)) { touchLRU(key); return texCache.get(key); }
    if (inFlight.has(key)) return inFlight.get(key);
    const p = (async()=>{
      const q = getQuality();
      const url = panoUrl(file); // chooseFile already accounts for WebP support
      const tex = new Texture(url, scene, !q.mips, false, q.sampling);
      try { tex.anisotropicFilteringLevel = q.aniso; } catch {}
      return await new Promise(res=>{ tex.isReady()? res(tex) : tex.onLoadObservable.addOnce(()=>res(tex)); })
        .then(t=>{ texCache.set(key,t); evictIfNeeded(key); return t; });
    })();
    inFlight.set(key, p);
    p.finally(()=>inFlight.delete(key));
    return p;
  }
  function mapFor2D(tex, stereo) {
    if (!tex) return;
    // Ensure equirect mapping like Agent (prevents full TB showing)
    try { tex.coordinatesMode = Texture.FIXED_EQUIRECTANGULAR_MODE; } catch {}
    tex.uScale  = FLIP_U ? -1 : 1;
    tex.uOffset = FLIP_U ?  1 : 0;
    tex.vScale  = stereo ? -0.5 : -1.0;
    tex.vOffset = 1.0;
    tex.wrapU = Texture.CLAMP_ADDRESSMODE;
    tex.wrapV = Texture.CLAMP_ADDRESSMODE;
    // aniso set in getTexture()
  }

  // Release GPU memory when tab is hidden/backgrounded (mobile stability)
  try{
    document.addEventListener('visibilitychange', ()=>{ if (document.visibilityState !== 'visible') purgeTextures(); });
    addEventListener('pagehide', ()=>purgeTextures());
  }catch{}

  // Apply initial orientation
  applyCam();

  /* WebXR (optional for viewer) */
  let xr = null; let inXR = false;
  // Double-buffered PhotoDome to avoid black frames in VR
  const vrDomes = [null, null];
  let activeVr = 0;
  let prevHSL = null; // previous hardware scaling level (for clarity in XR)
  try{
    if (navigator?.xr){
      // Allow reference space override via query param: ?xrRef=local | local-floor | bounded-floor
      const qs = new URLSearchParams(location.search);
      const xrRef = (qs.get('xrRef') || 'local-floor');
      xr = await scene.createDefaultXRExperienceAsync({
        uiOptions: { sessionMode: "immersive-vr", referenceSpaceType: xrRef },
        optionalFeatures: true
      });
      // Avoid network hand-mesh fetches and model parser noise
      try{ const fm = xr?.baseExperience?.featuresManager; fm?.enableFeature?.('hand-tracking','latest',{ xrInput: xr?.baseExperience?.input, jointMeshes:false, doNotLoadHandMesh:true }); }catch{}
    }
  }catch{}
  const ensureVrDome = (index) => {
    if (vrDomes[index]) return vrDomes[index];
    const dome = new PhotoDome("pd_"+index, panoUrl(nodesById?.get?.(currentNodeId)?.file || ""), { size: DOME_DIAMETER }, scene);
    dome.mesh.isVisible = false;
    // CRITICAL FIX: Parent to worldRoot to prevent drift in VR
    dome.mesh.parent = worldRoot;
    // Ensure VR domes render only on main layer used by XR camera
    try { dome.mesh.layerMask = 0x1; } catch {}
    // Apply stereo mode immediately based on current experience
    setVrStereoMode(dome);
    // Initial stereo mode will be set on use
    vrDomes[index] = dome;
    return dome;
  };
  const setVrStereoMode = (dome) => {
    const mode = isStereo() ? PhotoDome.MODE_TOPBOTTOM : PhotoDome.MODE_MONOSCOPIC;
    try { if ("stereoMode" in dome) dome.stereoMode = mode; } catch {}
    try { if ("imageMode"  in dome) dome.imageMode  = mode; } catch {}
  };
  async function loadUrlIntoDome(dome, url){
    return new Promise((resolve)=>{
      if (!dome?.photoTexture) { resolve(); return; }
      let done = false;
      const tex = dome.photoTexture;
      const cleanup = () => { if (obs){ try { tex.onLoadObservable.remove(obs); } catch {} } };
      const obs = tex.onLoadObservable.add(()=>{ done = true; cleanup(); resolve(); });
      try { tex.updateURL(url); } catch { cleanup(); resolve(); }
      // Increased timeout for slow connections (was 1200ms, now 3000ms)
      setTimeout(()=>{ if(!done){ console.warn('[VIEWER] Texture load timeout:', url); cleanup(); resolve(); } }, 8000);
    }).then(()=>{
      try { const tex = dome.photoTexture; if (tex) { tex.anisotropicFilteringLevel = 8; } } catch {}
    });
  }
  async function setVrPano(file){
    const url = panoUrl(file);
    const next = 1 - activeVr;
    const nextDome = ensureVrDome(next);
    // DON'T show loading overlay in XR - it causes black screens
    // Load texture in background while keeping current dome visible
    await loadUrlIntoDome(nextDome, url);
    // Re-apply stereo mode after URL update (some engines reset flags on new texture)
    setVrStereoMode(nextDome);
    // Swap visibility AFTER new dome is ready (atomic swap, no black frame)
    nextDome.mesh.isVisible = true;
    try { nextDome.mesh.setEnabled(true); } catch {}
    const curDome = vrDomes[activeVr];
    if (curDome) {
      curDome.mesh.isVisible = false;
      try { curDome.mesh.setEnabled(false); } catch {}
    }
    activeVr = next;
    try{ retainSW([url]); }catch{}
  }

  // Defensive visibility guard to avoid any accidental 2D overlays in XR
  scene.onBeforeRenderObservable.add(()=>{
    try{
      if (inXR){
        // Ensure 2D domes never render in headset
        try { if (dome?.isEnabled?.()) dome.setEnabled(false); } catch {}
        try { if (dome2D?.mesh?.isVisible) dome2D.mesh.isVisible = false; } catch {}
      } else {
        // Outside XR, keep 2D path active
        try { if (dome && !dome.isEnabled()) dome.setEnabled(true); } catch {}
        try { if (dome2D?.mesh && dome2D.mesh.isVisible === false) dome2D.mesh.isVisible = true; } catch {}
      }
    }catch{}
  });
  async function animateTravelXR(prevNode, nextNode){
    try{
      if (!prevNode || !nextNode || !inXR) return;
      navAnimating = true;
      const startPos = worldRoot.position.clone();
      const targetPos = nodeWorldPos(nextNode);
      const delta = targetPos.subtract(startPos);
      const distance = delta.length();
      const forward = distance>1e-4 ? delta.normalize() : new Vector3(0,0,-1);
      const startMag = Math.max(NAV_PUSH_M*0.55, Math.min(distance + NAV_PUSH_M*0.35, NAV_PUSH_M*1.5));
      const endMag   = Math.max(NAV_PUSH_M*0.35, Math.min(distance*0.6, NAV_PUSH_M*1.1));
      const ctrl1 = startPos.add(forward.scale(startMag));
      const ctrl2 = targetPos.subtract(forward.scale(endMag));
      const baseMs = NAV_DUR_MS + 420;
      const travelFactor = Math.max(1, (distance + 0.5) / Math.max(0.4, NAV_PUSH_M*0.5));
      const travelMs = Math.max(900, Math.min(2000, baseMs * travelFactor));
      const startYaw = worldYaw;
      const travelYaw = distance > 1e-4 ? Math.atan2(-delta.x, -delta.z) : startYaw;
      const nodeYaw = Number.isFinite(nextNode?.yaw) ? -((Math.PI/180)*nextNode.yaw) : travelYaw;
      const targetYaw = lerpAngle(travelYaw, nodeYaw, 0.35);
      const t0 = performance.now();
      const obs = scene.onBeforeRenderObservable.add(()=>{
        const t = Math.min(1, (performance.now() - t0) / travelMs);
        const eased = easeInOutSine(t);
        const pos = cubicBezier(startPos, ctrl1, ctrl2, targetPos, eased);
        worldRoot.position.copyFrom(pos);
        const yawNow = lerpAngle(startYaw, targetYaw, eased);
        worldYaw = yawNow; worldRoot.rotation.y = worldYaw;
        if (t >= 1){ try{ scene.onBeforeRenderObservable.remove(obs); }catch{} navAnimating = false; }
      });
      await new Promise(res=>setTimeout(res, Math.ceil(travelMs)));
    }catch{ navAnimating=false; }
  }
  let lastLoadedFile = null; // Track last loaded file to prevent unnecessary reloads
  let lastAppliedNodeId = null; // Track which node we last applied (even if same file)
  let loadInProgress = false; // Prevent concurrent loads
  let targetNodeId = null; // Track latest target for sync during rapid navigation
  async function refreshDomeForCurrentNode() {
    const node = nodesById.get(currentNodeId);
    if (!node) return;
    // Track the target we're loading for sync check
    const loadTarget = currentNodeId;
    targetNodeId = loadTarget;

    // Optimization: avoid redundant reloads
    // If the same node is requested again and the file hasn't changed, skip.
    // But if the node changed (even with the same file), continue so we update state cleanly.
    if (node.file === lastLoadedFile && lastAppliedNodeId === loadTarget) {
      try { dome.setEnabled(true); } catch {}
      return;
    }

    // Prevent concurrent loads (causes stuck black screens)
    if (loadInProgress) {
      console.warn('[VIEWER] Load already in progress, skipping:', node.file);
      return;
    }
    loadInProgress = true;

    // Safety timeout: reset flag after 5 seconds to prevent permanent stuck
    const safetyTimeout = setTimeout(() => {
      console.error('[VIEWER] Load timeout - forcing reset');
      loadInProgress = false;
    }, 5000);
    try {
      if (inXR) {
        await setVrPano(node.file);
        // CHECK: Are we still trying to load this node, or did agent move again?
        if (loadTarget !== targetNodeId) {
          console.warn('[VIEWER] Target changed during load, skipping apply:', loadTarget, 'â†’', targetNodeId);
          return; // Don't apply outdated panorama
        }
        dome.setEnabled(false);
        lastLoadedFile = node.file; // Mark as loaded only if we applied it
        lastAppliedNodeId = loadTarget;
      } else {
        try{ vrDomes.forEach(d=>{ if(d) d.mesh.isVisible=false; }); }catch{}
        // DON'T show loading overlay - causes black screens
        const tex = await getTexture(node.file);
        // CHECK: Are we still trying to load this node?
        if (loadTarget !== targetNodeId) {
          console.warn('[VIEWER] Target changed during load, skipping apply:', loadTarget, 'â†’', targetNodeId);
          return; // Don't apply outdated panorama
        }
        // CORRECT: In 2D, CROP stereo (show bottom half only for mono view)
        // In VR, PhotoDome handles full stereo automatically
        mapFor2D(tex, isStereo());
        domeMat.emissiveTexture = tex;
        dome.setEnabled(true);
        // retention: current + previous + warm next neighbors
        const prevKey = lastLoadedFile && lastLoadedFile!==node.file ? `${BASE}|${lastLoadedFile}` : null;
        const prevFile = lastLoadedFile && lastLoadedFile!==node.file ? lastLoadedFile : null;
        lastLoadedFile = node.file; // Mark as loaded only if we applied it
        lastAppliedNodeId = loadTarget;
        const curKey = `${BASE}|${node.file}`;
        const keep = new Set([curKey]);
        const urls = [panoUrl(node.file)];
        if (prevKey){ keep.add(prevKey); try{ if (prevFile) urls.push(panoUrl(prevFile)); }catch{} }
        // Warm neighbors asynchronously; retain them as well
        const neigh = neighborInfoFor(node, 2);
        neigh.files.forEach(f=>{ try{ getTexture(f).catch(()=>{}); }catch{} });
        neigh.keys.forEach(k=>keep.add(k));
        urls.push(...neigh.urls);
        retainOnly(keep);
        retainSW(urls);
      }
    } catch (error) {
      console.error('[VIEWER] Failed to load panorama:', error);
      lastLoadedFile = null; // Reset so it can retry
    } finally {
      clearTimeout(safetyTimeout);
      loadInProgress = false;
    }
  }
  xr?.baseExperience?.onStateChangedObservable?.add((s)=>{
    const wasInXR = inXR;
    inXR = (s === WebXRState.IN_XR);
    try {
      if (inXR) {
        try { document.body.setAttribute('data-xr','1'); } catch {}
        // Improve clarity in XR: disable downscaling while in VR
        prevHSL = engine.getHardwareScalingLevel?.() ?? null;
        engine.setHardwareScalingLevel(1.0);
        // Ensure XR camera renders only the main layer (hide any auxiliary overlays)
        try { const xrcam = xr?.baseExperience?.camera; if (xrcam) xrcam.layerMask = 0x1; } catch {}
        // Hide 2D domes while in XR to prevent any image sticking to view
        try { dome.setEnabled(false); } catch {}
        try { if (dome2D?.mesh) dome2D.mesh.isVisible = false; } catch {}
        // Show the active VR dome only
        try {
          vrDomes.forEach(d => { if (d?.mesh) { d.mesh.isVisible = false; d.mesh.setEnabled(false); } });
          ensureVrDome(activeVr).mesh.isVisible = true;
          try { ensureVrDome(activeVr).mesh.setEnabled(true); } catch {}
        } catch {}
      } else if (prevHSL != null) {
        try { document.body.removeAttribute('data-xr'); } catch {}
        engine.setHardwareScalingLevel(prevHSL);
        // Restore 2D view, hide VR domes
        try { vrDomes.forEach(d => { if (d?.mesh) { d.mesh.isVisible = false; d.mesh.setEnabled(false); } }); } catch {}
        try { dome.setEnabled(true); } catch {}
        try { if (dome2D?.mesh) dome2D.mesh.isVisible = true; } catch {}
      }
    } catch {}
    // Only refresh if we're transitioning modes (2D->VR or VR->2D), not on repeated state changes
    if (wasInXR !== inXR) {
      refreshDomeForCurrentNode();
    }
  });
  try { addEventListener('ui:exit', async ()=>{ try{ await xr?.baseExperience?.exitXRAsync?.(); }catch{} }); } catch {}
  // In XR mode, we allow smooth travel and optional drift during autoplay.
  function computeViewerPose(){
    if (inXR && xr?.baseExperience?.camera){
      const dir = xr.baseExperience.camera.getForwardRay().direction;
      // FIX: Quest 3 coordinate alignment - use -x to prevent left/right drift
      const yaw = Math.atan2(-dir.x, dir.z);
      const pitch = Math.asin(dir.y);
      return { yaw, pitch, mode: 'xr' };
    }
    return { yaw: cam.rotation.y, pitch: cam.rotation.x, mode: '2d' };
  }

  /* WebSocket: follow Guide (primary + fallback) */
  const IGNORE_GUIDE_YAW = true; // viewer controls their own look; guide yaw only for Agent mirror
  function toWs(url){ try{ if(!url) return null; const s=String(url); return s.replace(/^http(s?):/i, 'ws$1:'); }catch{ return url; } }
  const WS_PRIMARY = toWs(import.meta?.env?.VITE_WS_URL || "wss://vrsync.dev.opensky.co.in/");
  const WS_FALLBACK = toWs(import.meta?.env?.VITE_WS_URL_SECONDARY || import.meta?.env?.VITE_WS_FALLBACK || "https://22abcd9c-f607-41d5-9109-203a6cf0b79e-00-3nw6aihj3adm4.sisko.replit.dev/");
  function expandWs(u){
    if (!u) return [];
    try{
      const url=new URL(u);
      const list=[u];
      const hasPath = url.pathname && url.pathname !== '/' && url.pathname !== '';
      if (!hasPath){ list.push((u.endsWith('/')?u.slice(0,-1):u)+"/ws"); }
      return list;
    }catch{ return [u]; }
  }
  const WS_LIST = Array.from(new Set([ ...expandWs(WS_PRIMARY), ...expandWs(WS_FALLBACK) ].filter(Boolean)));
  let socket = null; let wsOpen=false; let lastPoseT=0; let poseObs=null; let wsIndex=0; let wsLockedIdx=-1;
  // VR drift during autoplay (viewer side)
  const DRIFT_RATE_DPS = Math.max(0, Number(import.meta?.env?.VITE_TOUR_DRIFT_RATE_DPS) || 0.30);
  const DRIFT_RATE_RPS = DRIFT_RATE_DPS * Math.PI / 180;
  const DRIFT_ALLOW_XR_VIEWER = String(import.meta?.env?.VITE_TOUR_DRIFT_XR_VIEWER ?? '1') !== '0';
  let driftEnabled=false, driftAccum=0, driftLastT=0, driftSign=1;
  scene.onBeforeRenderObservable.add(()=>{
    try{
      if (!inXR) return;
      if (!DRIFT_ALLOW_XR_VIEWER) return;
      if (!driftEnabled) return;
      if (navAnimating) return;
      const t = performance.now(); if (!driftLastT) driftLastT = t; const dt = Math.max(0, Math.min(100, t - driftLastT)); driftLastT = t;
      driftAccum += driftSign * DRIFT_RATE_RPS * (dt/1000);
      worldRoot.rotation.y = worldYaw + driftAccum;
    }catch{}
  });
  (function connect(){
    let retryMs=2000;
    const idx = (wsLockedIdx>=0 ? wsLockedIdx : (wsIndex % WS_LIST.length));
    const url = WS_LIST[idx];
    console.log('[VIEWER] Connecting to WebSocket:', url);
    try { socket = new WebSocket(url); } catch(e) { console.warn('[VIEWER] WebSocket create failed:', e); socket = null; if (wsLockedIdx<0) wsIndex=(wsIndex+1)%WS_LIST.length; return setTimeout(connect, retryMs); }
    let opened=false; const OPEN_TIMEOUT_MS=3500; const to=setTimeout(()=>{ if(!opened){ console.warn('[VIEWER] WebSocket timeout'); try{ socket?.close(); }catch{} } }, OPEN_TIMEOUT_MS);
    socket.addEventListener("open", () => { opened=true; clearTimeout(to); wsOpen=true; retryMs=2000; wsLockedIdx = idx; console.log('[VIEWER] WebSocket connected, joining room:', roomId); try { socket?.send(JSON.stringify({ type: "join", room: roomId, role: "viewer", uid })); } catch(e) { console.error('[VIEWER] Join send failed:', e); } });
    function schedule(reason){
      clearTimeout(to);
      wsOpen=false;
      console.warn('[VIEWER] WebSocket disconnected:', reason);
      try{ socket?.close(); }catch{};
      // On failure, rotate to the next endpoint instead of staying locked
      wsLockedIdx = -1;
      wsIndex = (wsIndex+1) % WS_LIST.length;
      setTimeout(connect, retryMs);
      retryMs = Math.min(retryMs*1.7, 15000);
    }
    socket.addEventListener("close", ()=>schedule('close'));
    socket.addEventListener("error", (e)=>{ console.error('[VIEWER] WebSocket error:', e); schedule('error'); });
    socket.addEventListener("message", async (ev) => {
      let msg;
      try { msg = JSON.parse(ev.data); } catch { return; }
      if (msg?.type !== "sync" || msg.room !== roomId) return;
      // Toggle drift based on guide autoplay state if provided
      if (typeof msg.tour === 'boolean') {
        driftEnabled = inXR && msg.tour === true;
        if (!driftEnabled) { driftAccum = 0; driftLastT = 0; worldYaw = worldRoot.rotation.y; }
      }
      const nextExpValue = msg.expPath ?? msg.exp;
      if (nextExpValue) {
        const nextPath = ensureExpPath(nextExpValue);
        if (`${BASE_URL}${nextPath}` !== BASE) {
          expPath = nextPath; BASE = `${BASE_URL}${expPath}`.replace(/\/{2,}/g, "/");
          ({ data, nodesById, startNodeId } = await loadWalkthrough(`${BASE}/walkthrough.json`));
          // Dispose old textures when switching experience
          try{ for (const [k,tex] of texCache.entries()){ try{ tex?.dispose?.(); }catch{} } texCache.clear(); }catch{}
          rebuildFloorMaps();
        }
      }
      if (msg.nodeId && nodesById.has(msg.nodeId)) {
        const prevNode = nodesById.get(currentNodeId);
        currentNodeId = msg.nodeId; const node = nodesById.get(currentNodeId);
        // Apply position always (used by nonâ€‘XR to keep world in sync)
        if (!inXR) worldRoot.position.copyFrom(nodeWorldPos(node));
        // Do not apply guide yaw; mirror shows viewer's camera
        if (!IGNORE_GUIDE_YAW && !inXR && typeof msg.panoYaw === "number") worldRoot.rotation.y = msg.panoYaw;
        if (inXR) {
          await setVrPano(node.file);
          try { const nodeYaw = Number.isFinite(node?.yaw) ? -((Math.PI/180)*node.yaw) : worldYaw; driftSign = shortestSign(worldYaw, nodeYaw); } catch {}
          await animateTravelXR(prevNode, node);
          worldYaw = worldRoot.rotation.y; driftAccum = 0; driftLastT = performance.now();
        } else {
          await refreshDomeForCurrentNode();
        }
      } else {
        // Ignore guide yaw entirely (viewer controls orientation)
        if (!IGNORE_GUIDE_YAW && !inXR && typeof msg.panoYaw === "number") worldRoot.rotation.y = msg.panoYaw;
        if (!inXR && Array.isArray(msg.worldPos) && msg.worldPos.length === 3) {
          worldRoot.position.copyFrom(new Vector3(msg.worldPos[0], msg.worldPos[1], msg.worldPos[2]));
        }
      }
    });
    if (poseObs) { try { scene.onBeforeRenderObservable.remove(poseObs); } catch {} }
    // Helper for angular difference
    const aDelta = (a,b)=>{ const TAU=Math.PI*2; let d=(a-b)%TAU; if(d>Math.PI) d-=TAU; if(d<-Math.PI) d+=TAU; return Math.abs(d); };
    let lastSentYaw=0, lastSentPitch=0, lastSentMs=0;
    poseObs = scene.onBeforeRenderObservable.add(()=>{
      const now = performance.now();
      // OPTIMIZED: 10Hz (~100ms) for low bandwidth
      if (now - lastPoseT <= 100) return;
      const ready = !!(socket && socket.readyState === 1);
      if (!ready) { lastPoseT = now; return; }
      // Stream viewer pose with quantization and change detection
      try {
        const q = (v, step) => Math.round(v / step) * step;
        const pose = computeViewerPose();
        // Quantize to reduce sensor noise jitter
        pose.yaw   = q(pose.yaw,   0.005); // ~0.29Â°
        pose.pitch = q(pose.pitch, 0.005);
        // Send only if meaningful change or periodic keepalive
        const MIN_DELTA = 0.0087; // ~0.5Â°
        const KEEPALIVE_MS = 1000;
        const changed = (aDelta(pose.yaw, lastSentYaw) >= MIN_DELTA) || (aDelta(pose.pitch, lastSentPitch) >= MIN_DELTA);
        const needKeepAlive = (now - lastSentMs) >= KEEPALIVE_MS;
        if (changed || needKeepAlive){
          const payload = { type: "sync", room: roomId, from: "viewer", uid, nodeId: currentNodeId, pose };
          socket.send(JSON.stringify(payload));
          lastSentYaw = pose.yaw; lastSentPitch = pose.pitch; lastSentMs = now;
          if (changed) console.log('[VIEWER] Sent pose update:', { yaw: pose.yaw.toFixed(3), pitch: pose.pitch.toFixed(3), mode: pose.mode });
        }
      } catch {}
      lastPoseT = now;
    });
  })();

  /* Start */
  const start = nodesById.get(startNodeId);
  currentNodeId = start.id;
  worldRoot.position.copyFrom(nodeWorldPos(start));
  worldRoot.rotation.y = -((Math.PI / 180) * (start.yaw || 0));
  await refreshDomeForCurrentNode();

  worldYaw = worldRoot.rotation.y;

  engine.runRenderLoop(() => scene.render());
  addEventListener("resize", () => engine.resize());
  return {};
}

