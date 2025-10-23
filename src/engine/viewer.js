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
const chooseFile = (f) => SUPPORTS_WEBP ? f : f.replace(/\.webp$/i, '.jpg');

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
  const panoUrl = (f) => `${BASE}/${PANOS_DIR}/${chooseFile(f)}`.replace(/\/{2,}/g, "/");
  // UA flags (used for iOS memory-safe behavior)
  const UA = (navigator.userAgent || "").toLowerCase();
  const IS_IOS = /iphone|ipad|ipod|ios/.test(UA);
  /* Engine / Scene */
  const canvas = document.getElementById("renderCanvas");
  const engine = new Engine(canvas, true);
  try {
    // Force HQ on request; otherwise cap to 2x for perf
    function determineDpr(){
      const qs = new URLSearchParams(location.search);
      const forceHQ = (qs.get('hq') === '1') || (String(import.meta?.env?.VITE_FORCE_HQ||'')==='1') || ((qs.get('q')||'').toLowerCase()==='high');
      const dpr = Math.max(1, window.devicePixelRatio || 1);
      const cap = forceHQ ? 3 : 2;
      // iOS tends to crash with high DPR + huge textures; keep DPR conservative
      const target = Math.min(cap, dpr);
      return IS_IOS ? Math.min(1.2, target) : target;
    }
    engine.setHardwareScalingLevel(1 / determineDpr());
  } catch {}

  function getQuality() {
    try {
      // Safer defaults for iPhones (lower memory pressure)
      if (IS_IOS) return { mips: false, sampling: Texture.BILINEAR_SAMPLINGMODE, aniso: 1 };
      const qs = new URLSearchParams(location.search);
      const override = (qs.get('q') || import.meta?.env?.VITE_QUALITY || 'auto').toLowerCase();
      if (override === 'high') return { mips: true, sampling: Texture.TRILINEAR_SAMPLINGMODE, aniso: 8 };
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
  try{ window.dispatchEvent(new CustomEvent('loading:show', { detail:{ label: 'Loading tour…' } })); }catch{}
  ({ data, nodesById, startNodeId } = await loadWalkthrough(`${BASE}/walkthrough.json`));
  try{ window.dispatchEvent(new CustomEvent('loading:hide')); }catch{}
  let currentNodeId = startNodeId;

  // If on iOS or small GPUs, try a mobile-optimized folder (panos-mobile) if present
  async function maybeUseMobilePanos() {
    try {
      const maxTex = engine.getCaps()?.maxTextureSize || 4096;
      const shouldPrefer = IS_IOS || maxTex < 8192;
      if (!shouldPrefer) return;
      const startFile = (nodesById?.get?.(currentNodeId)?.file) || '';
      if (!startFile) { PANOS_DIR = 'panos'; return; }
      const probe = `${BASE}/panos-mobile/${chooseFile(startFile)}`.replace(/\/{2,}/g, '/');
      const r = await fetch(probe, { method: 'HEAD', cache: 'no-cache' });
      if (r.ok) { PANOS_DIR = 'panos-mobile'; }
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

  const domeMat = new StandardMaterial("panoMat", scene);
  domeMat.disableLighting = true;
  domeMat.backFaceCulling = false;
  domeMat.transparencyMode = Material.MATERIAL_ALPHABLEND;
  dome.material = domeMat;

  // Drag-to-rotate + pinch/wheel zoom for Viewer (2D) — immediate (no drift)
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
  const dome2 = MeshBuilder.CreateSphere("dome2", { diameter: DOME_DIAMETER, segments: 64, sideOrientation: Mesh.BACKSIDE }, scene);
  dome2.parent = worldRoot; if (FLIP_X) dome2.rotation.x = Math.PI;
  const domeMat2 = new StandardMaterial("panoMatB", scene);
  domeMat2.disableLighting = true; domeMat2.backFaceCulling = false; domeMat2.transparencyMode = Material.MATERIAL_ALPHABLEND;
  domeMat.alpha = 1.0; domeMat2.alpha = 0.0; dome2.material = domeMat2;
  let activeMat = 0; const mats=[domeMat,domeMat2]; const domes=[dome,dome2];
  async function crossfadeToTexture(tex, durMs=200){
    mapFor2D(tex, isStereo());
    const from=mats[activeMat]; const to=mats[1-activeMat];
    to.emissiveTexture = tex; to.alpha = 0.0; domes[0].setEnabled(true); domes[1].setEnabled(true);
    let t0=performance.now();
    await new Promise(res=>{ const obs=scene.onBeforeRenderObservable.add(()=>{ const t=Math.min(1,(performance.now()-t0)/durMs); to.alpha=t; from.alpha=1-t; if(t>=1){ scene.onBeforeRenderObservable.remove(obs); res(); }}); });
    activeMat = 1-activeMat;
  }

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
  async function getTexture(file) {
    const key = `${BASE}|${file}`;
    if (texCache.has(key)) { touchLRU(key); return texCache.get(key); }
    if (inFlight.has(key)) return inFlight.get(key);
    const q = getQuality();
    const tex = new Texture(panoUrl(file), scene, !q.mips, false, q.sampling);
    try { tex.anisotropicFilteringLevel = q.aniso; } catch {}
    const p = new Promise(res => { tex.isReady() ? res(tex) : tex.onLoadObservable.addOnce(()=>res(tex)); }).then((t)=>{ texCache.set(key,t); evictIfNeeded(key); return t; });
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
      setTimeout(()=>{ if(!done){ console.warn('[VIEWER] Texture load timeout:', url); cleanup(); resolve(); } }, 3000);
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
    const curDome = vrDomes[activeVr];
    if (curDome) curDome.mesh.isVisible = false;
    activeVr = next;
    try{ retainSW([url]); }catch{}
  }
  let lastLoadedFile = null; // Track last loaded file to prevent unnecessary reloads
  let loadInProgress = false; // Prevent concurrent loads
  let targetNodeId = null; // Track latest target for sync during rapid navigation
  async function refreshDomeForCurrentNode() {
    const node = nodesById.get(currentNodeId);
    if (!node) return;
    // Track the target we're loading for sync check
    const loadTarget = currentNodeId;
    targetNodeId = loadTarget;

    // CRITICAL FIX: Don't reload if same file (prevents VR blinking)
    if (node.file === lastLoadedFile && loadTarget === targetNodeId) return;

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
          console.warn('[VIEWER] Target changed during load, skipping apply:', loadTarget, '→', targetNodeId);
          return; // Don't apply outdated panorama
        }
        dome.setEnabled(false);
        lastLoadedFile = node.file; // Mark as loaded only if we applied it
      } else {
        try{ vrDomes.forEach(d=>{ if(d) d.mesh.isVisible=false; }); }catch{}
        // DON'T show loading overlay - causes black screens
        const tex = await getTexture(node.file);
        // CHECK: Are we still trying to load this node?
        if (loadTarget !== targetNodeId) {
          console.warn('[VIEWER] Target changed during load, skipping apply:', loadTarget, '→', targetNodeId);
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
        // Improve clarity in XR: disable downscaling while in VR
        prevHSL = engine.getHardwareScalingLevel?.() ?? null;
        engine.setHardwareScalingLevel(1.0);
      } else if (prevHSL != null) {
        engine.setHardwareScalingLevel(prevHSL);
      }
    } catch {}
    // Only refresh if we're transitioning modes (2D->VR or VR->2D), not on repeated state changes
    if (wasInXR !== inXR) {
      refreshDomeForCurrentNode();
    }
  });
  // In XR mode, worldRoot should remain static (no updates from WebSocket)
  // The PhotoDomes are parented to worldRoot and will follow XR camera automatically
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
        currentNodeId = msg.nodeId; const node = nodesById.get(currentNodeId);
        // Apply position always (used by non‑XR to keep world in sync)
        if (!inXR) worldRoot.position.copyFrom(nodeWorldPos(node));
        // Do not apply guide yaw; mirror shows viewer's camera
        if (!IGNORE_GUIDE_YAW && !inXR && typeof msg.panoYaw === "number") worldRoot.rotation.y = msg.panoYaw;
        await refreshDomeForCurrentNode();
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
        pose.yaw   = q(pose.yaw,   0.005); // ~0.29°
        pose.pitch = q(pose.pitch, 0.005);
        // Send only if meaningful change or periodic keepalive
        const MIN_DELTA = 0.0087; // ~0.5°
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

  engine.runRenderLoop(() => scene.render());
  addEventListener("resize", () => engine.resize());
  return {};
}




























