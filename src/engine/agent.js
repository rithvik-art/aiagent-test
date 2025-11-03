// 2D stays mono (cropped if the source is TB). XR uses true TB stereo via PhotoDome.

import {
  Engine, Scene, FreeCamera, WebXRState, Vector3, MeshBuilder, Mesh, Color4,
  StandardMaterial, Texture, Material, TransformNode, Color3, PointerEventTypes, Viewport, Ray
} from "@babylonjs/core";
import { DynamicTexture } from "@babylonjs/core/Materials/Textures/dynamicTexture";
import "@babylonjs/loaders";
import { PhotoDome } from "@babylonjs/core/Helpers/photoDome";
import { loadWalkthrough, buildMinimapDOM } from "./walkthrough-loader.js";

/* logs */
function LOG(){ try{ console.log.apply(console, arguments); }catch{} }
function stamp(){ return new Date().toISOString().split("T")[1].slice(0,12); }
function A(tag, obj){ LOG("[AGENT]", stamp(), tag, obj||""); }

/* constants */
const DEFAULT_FLIP_U = true;
const DEFAULT_FLIP_X = true;
const DOME_DIAMETER = 2000, FLOOR_HEIGHT_M = 3.0;
// Slower, more cinematic nav base (especially for VR)
const NAV_DUR_MS = 900, NAV_PUSH_M = 3.0;
let MIRROR_YAW_SIGN = 1;
let MIRROR_PITCH_SIGN = 1; // 1 for same direction, -1 to invert if needed
const XR_DEBUG_PARAM = (()=>{ try{ return new URLSearchParams(location.search).has('xrdebug'); }catch{ return false; } })();
const XRDebugLog = (...args)=>{ if (XR_DEBUG_PARAM){ try{ console.log("[XRDEBUG]", ...args); }catch{} } };
// Simple local TTS helper (used for hotspot hover cues)
function speak(text){
  try{
    const s = String(text||"").trim(); if(!s) return;
    if (!('speechSynthesis' in window)) return;
    const u = new SpeechSynthesisUtterance(s); u.rate=1; u.pitch=1; u.lang=(navigator.language||'en-US');
    try{ window.speechSynthesis.cancel(); }catch{}
    window.speechSynthesis.speak(u);
  }catch{}
}
// Unlock audio on platforms that require user interaction
let _ac = null; let _audioUnlocked = false;
async function unlockAudio(){
  try{
    if (_audioUnlocked) return true;
    const AC = window.AudioContext || window.webkitAudioContext; if (!AC) { _audioUnlocked = true; return true; }
    if (!_ac) _ac = new AC();
    if (_ac.state === 'suspended') { try { await _ac.resume(); } catch {} }
    const o = _ac.createOscillator(); const g = _ac.createGain(); g.gain.value = 0.00001; o.connect(g).connect(_ac.destination); o.start(); o.stop(_ac.currentTime + 0.02);
    _audioUnlocked = true; return true;
  }catch{ _audioUnlocked = false; return false; }
}

/* env */
let BASE_URL = (import.meta?.env?.BASE_URL ?? "/");
function toWs(url){ try{ if(!url) return null; const s=String(url); return s.replace(/^http(s?):/i, 'ws$1:'); }catch{ return url; } }
const WS_PRIMARY = toWs(import.meta?.env?.VITE_WS_URL || "wss://vrsync.dev.opensky.co.in/");
const WS_FALLBACK = toWs(import.meta?.env?.VITE_WS_URL_SECONDARY || import.meta?.env?.VITE_WS_FALLBACK || "https://22abcd9c-f607-41d5-9109-203a6cf0b79e-00-3nw6aihj3adm4.sisko.replit.dev/");
function expandWs(u){ if(!u) return []; try{ const url=new URL(u); const list=[u]; const hasPath=url.pathname && url.pathname!=='/' && url.pathname!==''; if(!hasPath){ list.push((u.endsWith('/')?u.slice(0,-1):u)+"/ws"); } return list; }catch{ return [u]; } }

// WebP support
const SUPPORTS_WEBP = (() => { try { const c = document.createElement('canvas'); return c.toDataURL && c.toDataURL('image/webp').indexOf('image/webp') !== -1; } catch { return false; } })();
const chooseFile = (f, preferOriginal = false) => {
  if (!f) return f;
  if (!SUPPORTS_WEBP || preferOriginal) {
    return f.replace(/\.webp$/i, '.jpg');
  }
  return f;
};

const rad = d => d*Math.PI/180;
const v3arr = v => [v.x,v.y,v.z];
const expNameFrom = base => { const p=base.split("/").filter(Boolean); return p[p.length-1]||"amenities"; };
const UA = (navigator.userAgent || "").toLowerCase();
const IS_IOS = /iphone|ipad|ipod|ios/.test(UA);
const IS_ANDROID = /android/.test(UA);
const IS_MOBILE = IS_IOS || IS_ANDROID || /mobile/.test(UA);
const CROSSFADE_MODE = (import.meta?.env?.VITE_CROSSFADE || 'auto').toLowerCase();
function wantsCrossfade(){ if (CROSSFADE_MODE==='on') return true; if (CROSSFADE_MODE==='off') return false; return !IS_IOS; }

  // Autoplay cinematic drift (now supported in XR as well)
  // New behaviour: steady rotation in one direction (no oscillation)
  const DRIFT_DEG = Math.max(0, Number(import.meta?.env?.VITE_TOUR_DRIFT_DEG) || 1.2);
  const DRIFT_RAD = DRIFT_DEG * Math.PI / 180; // kept for backward compat (not used for rate)
  const DRIFT_PERIOD_S = Math.max(6, Number(import.meta?.env?.VITE_TOUR_DRIFT_PERIOD_S) || 14);
  // Slightly faster by default for a more cinematic feel
  const DRIFT_RATE_DPS = Math.max(0, Number(import.meta?.env?.VITE_TOUR_DRIFT_RATE_DPS) || 0.30); // deg/sec
  const DRIFT_IDLE_RATE_DPS = Math.max(0, Number(import.meta?.env?.VITE_TOUR_IDLE_RATE_DPS) || 0.24); // idle (pre-tour)
  const DRIFT_RATE_RPS = DRIFT_RATE_DPS * Math.PI / 180; // rad/sec
  const DRIFT_IDLE_RATE_RPS = DRIFT_IDLE_RATE_DPS * Math.PI / 180;
  const DRIFT_DIR = String(import.meta?.env?.VITE_TOUR_DRIFT_DIR || 'cw').toLowerCase();
  const DEFAULT_DRIFT_SIGN = (DRIFT_DIR === 'ccw' || DRIFT_DIR === 'left' || DRIFT_DIR === '-1') ? -1 : 1;
  const DRIFT_ACTIVE = (import.meta?.env?.VITE_TOUR_DRIFT || '1') !== '0' && DRIFT_RATE_RPS > 0.00002;
  // Allow cinematic drift during XR sessions (immersive-vr). Defaults to enabled.
  const DRIFT_ALLOW_XR = String(import.meta?.env?.VITE_TOUR_DRIFT_XR ?? '1') !== '0';

/* 2D texture mapping (mono crop for TB stereo) */
function mapFor2D(tex, stereo, flipU){
  if (!tex) return;
  tex.coordinatesMode = Texture.FIXED_EQUIRECTANGULAR_MODE;
  tex.uScale  = flipU ? -1 : 1;
  tex.uOffset = flipU ?  1 : 0;
  tex.vScale  = stereo ? -0.5 : -1.0; // bottom half = right eye (adjust if top)
  tex.vOffset = 1.0;
  tex.wrapU = Texture.CLAMP_ADDRESSMODE;
  tex.wrapV = Texture.CLAMP_ADDRESSMODE;
  // aniso set when texture is created based on quality profile
}

function createMetaLookup(list = []){
  const map = new Map();
  for (const entry of list){
    const id = typeof entry?.id === 'string' ? entry.id.trim() : '';
    if (id) map.set(id, entry);
  }
  return map;
}

export async function initAgent(opts = {}){
  const roomId = (opts.roomId && String(opts.roomId).trim()) || "demo";
  const exp    = (opts.exp    && String(opts.exp).trim()) || "amenities";
  const experiencesMeta = Array.isArray(opts.experiencesMeta) ? opts.experiencesMeta : [];
  const metaById = createMetaLookup(experiencesMeta);
  const resolveFlipConfig = (expId) => {
    const meta = metaById.get(String(expId || "").trim());
    return {
      flipU: typeof meta?.flipU === "boolean" ? meta.flipU : DEFAULT_FLIP_U,
      flipX: typeof meta?.flipX === "boolean" ? meta.flipX : DEFAULT_FLIP_X,
    };
  };
  let { flipU, flipX } = resolveFlipConfig(exp);

  let BASE = (BASE_URL + "experiences/" + exp).replace(/\/{2,}/g,"/");
  let PANOS_DIR = "panos";
  const expName  = () => expNameFrom(BASE);
  const isStereo = () => Boolean(metaById.get(expName())?.stereo);
  const panoPath = (dir, file) => (BASE + "/" + dir + "/" + chooseFile(file, isStereo())).replace(/\/{2,}/g,"/");
  const panoUrl  = file => panoPath(PANOS_DIR, file);
  const WS_LIST = Array.from(new Set([ ...expandWs(WS_PRIMARY), ...expandWs(WS_FALLBACK) ].filter(Boolean)));
  A("init", { roomId, exp:expName(), BASE, ws: WS_LIST });

  

  /* engine/scene */
  const canvas = document.getElementById("renderCanvas");
  const engine = new Engine(canvas, true, {
    disableWebGL2Support: IS_IOS,
    powerPreference: IS_IOS ? "low-power" : "high-performance",
    premultipliedAlpha: false,
    preserveDrawingBuffer: false,
    stencil: false
  });
  try{
    // Force HQ on request; allow low quality to cap DPR at 1 for speed
    function determineDpr(){
      const qs = new URLSearchParams(location.search);
      const qOverride = (qs.get('q')||'').toLowerCase();
      const forceHQ = (qs.get('hq') === '1') || (String(import.meta?.env?.VITE_FORCE_HQ||'')==='1') || (qOverride==='high');
      const forceLow = (qOverride==='low');
      const dpr = Math.max(1, window.devicePixelRatio || 1);
      let cap = forceHQ ? 3 : 2;
      if (forceLow) cap = 1;
      const target = Math.min(cap, dpr);
      return IS_IOS ? Math.min(1.2, target) : target;
    }
    engine.setHardwareScalingLevel(1 / determineDpr());
  }catch{}

  function getQuality(){
    try{
      const qs = new URLSearchParams(location.search);
      const override = (qs.get('q') || import.meta?.env?.VITE_QUALITY || 'auto').toLowerCase();
      if (override==='high' || override==='auto') return { mips:true, sampling:Texture.TRILINEAR_SAMPLINGMODE, aniso:8 };
      if (override==='low')  return { mips:false, sampling:Texture.BILINEAR_SAMPLINGMODE, aniso:1 };
      const conn = navigator.connection || navigator.webkitConnection || navigator.mozConnection;
      const eff = String(conn?.effectiveType||'').toLowerCase();
      const save = Boolean(conn?.saveData);
      const slow = /^(slow-)?2g|3g$/.test(eff) || save;
      const mem = Number(navigator.deviceMemory || 4);
      if (slow || mem <= 2) return { mips:false, sampling:Texture.BILINEAR_SAMPLINGMODE, aniso:1 };
      return { mips:true, sampling:Texture.TRILINEAR_SAMPLINGMODE, aniso:8 };
    }catch{ return { mips:true, sampling:Texture.TRILINEAR_SAMPLINGMODE, aniso:8 }; }
  }
  const scene  = new Scene(engine);
  scene.clearColor = new Color4(0,0,0,1);
  try { window.scene = scene; } catch {}

  const cam = new FreeCamera("cam", new Vector3(0,0,0), scene);
  cam.attachControl(canvas, true);
  cam.inputs.clear();
  // Render both layers in 2D (main + guide). XR camera will be forced to 0x1.
  cam.fov=1.1; cam.minZ=0.1; cam.maxZ=50000; cam.layerMask=0x3;
  scene.activeCamera = cam;

  /* data */
  try{ window.dispatchEvent(new CustomEvent('loading:show', { detail:{ label: 'Loading tourÃ¢â‚¬Â¦' } })); }catch{}
  let { data, nodesById, startNodeId } = await loadWalkthrough((BASE + "/walkthrough.json").replace(/\/{2,}/g,"/"));
  try{ window.dispatchEvent(new CustomEvent('loading:hide')); }catch{}
  let currentNodeId = startNodeId;
  const experienceDataCache = new Map();

  function cloneHotspots(list){
    if (!Array.isArray(list)) return [];
    return list.map(h => ({
      to: h?.to,
      type: h?.type || "walk",
      yaw: typeof h?.yaw === 'number' ? h.yaw : 0,
      pitch: typeof h?.pitch === 'number' ? h.pitch : 0,
      dir: Array.isArray(h?.dir) ? h.dir.slice(0, 3) : undefined,
      uv: Array.isArray(h?.uv) ? h.uv.slice(0, 2) : undefined,
    }));
  }
  function cloneNodeDeep(node){
    if (!node) return null;
    return {
      id: node.id,
      file: node.file,
      floorId: node.floorId,
      x: node.x,
      y: node.y,
      z: node.z,
      yaw: node.yaw,
      zoneId: node.zoneId,
      hotspots: cloneHotspots(node.hotspots),
    };
  }
  function cloneZoneDeep(zone){
    if (!zone) return null;
    return {
      id: zone.id,
      name: zone.name,
      floorId: zone.floorId,
      repNodeId: zone.repNodeId,
      points: Array.isArray(zone.points) ? zone.points.map(p => ({ x: p.x, y: p.y })) : [],
    };
  }
  function cloneExperienceData(payload){
    if (!payload) return null;
    const src = payload.data || {};
    return {
      expId: payload.expId || expName(),
      startNodeId: src.startNodeId ?? payload.startNodeId ?? null,
      floors: Array.isArray(src.floors) ? src.floors.map(f => ({ ...f })) : [],
      nodes: Array.isArray(src.nodes) ? src.nodes.map(cloneNodeDeep) : [],
      zones: Array.isArray(src.zones) ? src.zones.map(cloneZoneDeep) : [],
    };
  }
  function rememberExperience(expId, pack){
    if (!expId || !pack) return;
    experienceDataCache.set(expId, {
      expId,
      base: pack.base ?? (BASE_URL + "experiences/" + expId).replace(/\/{2,}/g,"/"),
      data: pack.data,
      nodesById: pack.nodesById,
      startNodeId: pack.startNodeId ?? pack.data?.startNodeId ?? null,
    });
  }
  rememberExperience(expName(), { base: BASE, data, nodesById, startNodeId });

  async function loadExperiencePackage(expId){
    const key = String(expId || "").trim();
    if (!key) return null;
    if (experienceDataCache.has(key)) return experienceDataCache.get(key);
    const base = (BASE_URL + "experiences/" + key).replace(/\/{2,}/g,"/");
    try{
      const pack = await loadWalkthrough((base + "/walkthrough.json").replace(/\/{2,}/g,"/"));
      const entry = { expId: key, base, ...pack };
      rememberExperience(key, entry);
      return experienceDataCache.get(key);
    }catch{
      experienceDataCache.set(key, null);
      return null;
    }
  }

  async function maybeSelectMobilePanoDir(){
    const node = nodesById.get(startNodeId) || (nodesById.size ? nodesById.values().next().value : null);
    const file = node?.file;
    if (!file) return;
    const qs = new URLSearchParams(location.search);
    const needsMobile = qs.get('mobile') === '1'; // only when explicitly requested
    if (!needsMobile) return;
    const candidates = [];
    candidates.push("panos-mobile-6k");
    candidates.push("panos-mobile");
    for (const dir of candidates){
      const url = panoPath(dir, file);
      try{
        let res = await fetch(url, { method: "HEAD", cache: "no-store" });
        if (!res?.ok && res?.status === 405){
          res = await fetch(url, { method: "GET", cache: "no-store" });
        }
        if (res?.ok){
          PANOS_DIR = dir;
          console.info("[AGENT] Using mobile panorama folder:", dir);
          return;
        }
      }catch{}
    }
  }
  await maybeSelectMobilePanoDir();

  /* floors */
  const floorIndex=new Map(), floorCenter=new Map();
  function rebuildFloorMaps(){
    floorIndex.clear(); floorCenter.clear();
    data.floors.forEach((f,i)=>floorIndex.set(f.id,i));
    for (const f of data.floors){
      const on=data.nodes.filter(n=>n.floorId===f.id);
      let minX=Infinity,maxX=-Infinity,minY=Infinity,maxY=-Infinity;
      for (const n of on){ if(typeof n.x==="number"&&typeof n.y==="number"){ if(n.x<minX)minX=n.x; if(n.x>maxX)maxX=n.x; if(n.y<minY)minY=n.y; if(n.y>maxY)maxY=n.y; } }
      const ppm=f.pxPerMeter||100; const cx=isFinite(minX)?(minX+maxX)/2:0; const cy=isFinite(minY)?(minY+maxY)/2:0;
      floorCenter.set(f.id,{cx,cy,ppm});
    }
  }
  rebuildFloorMaps();
  const nodeWorldPos = (n)=>{ const f=floorCenter.get(n.floorId)||{cx:0,cy:0,ppm:100}; const idx=floorIndex.get(n.floorId)??0; return new Vector3((n.x-f.cx)/f.ppm, idx*FLOOR_HEIGHT_M, (n.y-f.cy)/f.ppm); };

  /* main dome */
  const worldRoot = new TransformNode("worldRoot", scene);
  const dome = MeshBuilder.CreateSphere("dome",{diameter:DOME_DIAMETER,segments:64,sideOrientation:Mesh.BACKSIDE},scene);
  dome.parent=worldRoot; if(flipX) dome.rotation.x=Math.PI; dome.layerMask=0x2; dome.isPickable=false;
  const domeMat=new StandardMaterial("panoMat",scene);
  domeMat.disableLighting=true; domeMat.backFaceCulling=false;
  domeMat.transparencyMode=Material.MATERIAL_ALPHABLEND; domeMat.disableDepthWrite=true;
  dome.material=domeMat; dome.renderingGroupId=0;

  // Secondary dome for optional crossfade
  const crossDome = MeshBuilder.CreateSphere("domeX",{diameter:DOME_DIAMETER,segments:64,sideOrientation:Mesh.BACKSIDE},scene);
  crossDome.parent=worldRoot; if(flipX) crossDome.rotation.x=Math.PI; crossDome.layerMask=0x2; crossDome.isPickable=false; crossDome.isVisible=false; crossDome.setEnabled(false);
  const crossMat=new StandardMaterial("panoMatX",scene);
  crossMat.disableLighting=true; crossMat.backFaceCulling=false; crossMat.alpha=0;
  crossMat.transparencyMode=Material.MATERIAL_ALPHABLEND; crossMat.disableDepthWrite=true;
  crossDome.material=crossMat; crossDome.renderingGroupId=1;
  let worldYaw = 0;
  let driftPhase0 = (performance && performance.now) ? performance.now() : Date.now(); // legacy
  let driftAccum = 0;      // accumulated yaw offset in radians
  let driftLastT = 0;      // last timestamp for dt calc
  let driftSign = DEFAULT_DRIFT_SIGN; // runtime-controlled direction towards next pano
  let driftPlanTouch = 0;  // throttle plan reads

  function shortestSign(from, to){
    try{
      let d = to - from;
      while (d > Math.PI) d -= 2*Math.PI;
      while (d < -Math.PI) d += 2*Math.PI;
      const s = Math.sign(d);
      return s === 0 ? 1 : s;
    }catch{ return 1; }
  }

  /* textures */
  // LRU texture cache to prevent unbounded GPU memory growth on mobile
  const texCache=new Map(), inFlight=new Map();
  const TEX_LIMIT = IS_IOS ? 6 : (IS_ANDROID ? 10 : 16); // fewer on constrained GPUs
  const PREFETCH_LIMIT = IS_IOS ? 1 : 2;
  function touchLRU(key){
    if (!texCache.has(key)) return;
    const val = texCache.get(key);
    texCache.delete(key);
    texCache.set(key, val);
  }
  function evictIfNeeded(currentKey){
    try{
      while (texCache.size > TEX_LIMIT){
        const firstKey = texCache.keys().next().value;
        if (!firstKey || firstKey === currentKey) break;
        const tex = texCache.get(firstKey);
        try{ tex?.dispose?.(); }catch{}
        texCache.delete(firstKey);
      }
    }catch{}
  }
  function purgeTextures(){
    try{
      for (const [k,tex] of texCache.entries()){ try{ tex?.dispose?.(); }catch{} }
      texCache.clear();
    }catch{}
  }
  function retainOnly(keep){
    try{
      for (const [k, tex] of texCache.entries()){
        if (!keep.has(k)) { try{ tex?.dispose?.(); }catch{} texCache.delete(k); }
      }
    }catch{}
  }
  function retainSW(urls){ try{ const abs=(urls||[]).map(u=>{ try{ return new URL(u, location.origin).href; }catch{ return u; } }); navigator.serviceWorker?.controller?.postMessage({ type:'retain', urls: abs }); }catch{} }
  function neighborInfoFor(n, limit=2){
    const out={ files:[], keys:[], urls:[] };
    try{
      const hs=Array.isArray(n?.hotspots)? n.hotspots : [];
      for (const h of hs){
        if (!h?.to || !nodesById.has(h.to)) continue;
        const f = nodesById.get(h.to).file; if(!f || out.files.includes(f)) continue;
        out.files.push(f); out.keys.push(BASE+"|"+f); out.urls.push(panoUrl(f));
        if (out.files.length>=limit) break;
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
  // Standard texture load: use the file as authored (with basic WebP support toggle)
  function getTexture(file){
    const key=BASE+"|"+file;
    if (texCache.has(key)) { touchLRU(key); return Promise.resolve(texCache.get(key)); }
    if (inFlight.has(key)) return inFlight.get(key);
    const p=(async()=>{
      const q=getQuality();
      const url = panoUrl(file);
      const tex = new Texture(url, scene, !q.mips, false, q.sampling);
      try{ tex.anisotropicFilteringLevel=q.aniso; }catch{}
      return await new Promise(res=>{ if (tex.isReady()) res(tex); else tex.onLoadObservable.addOnce(()=>res(tex)); })
        .then(t=>{ texCache.set(key,t); evictIfNeeded(key); return t; });
    })();
    inFlight.set(key,p); p.finally(()=>inFlight.delete(key));
    return p;
  }
  let lastMainFile = null;
  function applyMainTexture(file, tex){
    try{ console.info('[AGENT] apply pano', file); }catch{}
    // CORRECT: In 2D, CROP stereo (bottom half only for mono view)
    mapFor2D(tex, /*stereo*/ isStereo(), flipU);
    domeMat.emissiveTexture = tex;
    try{ dome.setEnabled(true); dome.isVisible = true; }catch{}
    try{ if (crossDome?.isEnabled()) { crossDome.isVisible = false; crossDome.setEnabled(false); } }catch{}
    try{
      const currentMainKey = BASE + "|" + file;
      const keep = new Set([currentMainKey]);
      const urls = [panoUrl(file)];
      // retain previous pano
      try{
        if (typeof lastMainFile === 'string' && lastMainFile && lastMainFile !== file){
          keep.add(BASE + "|" + lastMainFile);
          urls.push(panoUrl(lastMainFile));
        }
      }catch{}
      if (typeof mirrorTexKey === 'string' && mirrorTexKey) keep.add(mirrorTexKey);
      const curNode = nodesById.get(currentNodeId);
      const neigh = neighborInfoFor(curNode, PREFETCH_LIMIT);
      neigh.files.forEach(f=>{ try{ getTexture(f).catch(()=>{}); }catch{} });
      neigh.keys.forEach(k=>keep.add(k));
      urls.push(...neigh.urls);
      retainOnly(keep);
      retainSW(urls);
      try{ lastMainFile = file; }catch{}
    }catch{}
  }
  async function showFile(file){
    // In XR, route to VR PhotoDome loader to avoid double domes and wrong mapping
    if (inXR === true){ try { await setVrPano(file); } catch {} return; }
    // 2D path: standard texture with equirect mapping (mono crop if stereo)
    const tex = await getTexture(file);
    applyMainTexture(file, tex);
  }
  function runCrossFade(file, tex, fadeMs, delayMs = 0){
    if (!tex) return showFile(file);
    if (!(fadeMs > 0)) { applyMainTexture(file, tex); return Promise.resolve(); }
    mapFor2D(tex, /*stereo*/ isStereo(), flipU);
    return new Promise((resolve) => {
      const startFade = () => {
        try{
          crossMat.emissiveTexture = tex;
          crossMat.emissiveTexture.coordinatesMode = Texture.FIXED_EQUIRECTANGULAR_MODE;
          crossMat.emissiveTexture.uScale = flipU ? -1 : 1;
          crossMat.emissiveTexture.uOffset = flipU ? 1 : 0;
          crossMat.emissiveTexture.vScale = isStereo() ? -0.5 : -1;
          crossMat.emissiveTexture.vOffset = 1;
          crossMat.alpha = 0;
          crossDome.setEnabled(true);
          crossDome.isVisible = true;
        }catch{}
        const started = performance.now();
        const observer = scene.onBeforeRenderObservable.add(() => {
          const elapsed = performance.now() - started;
          const t = Math.min(1, elapsed / Math.max(1, fadeMs));
          crossMat.alpha = t;
          if (t >= 1) {
            scene.onBeforeRenderObservable.remove(observer);
            try{
              crossMat.emissiveTexture = null;
              crossDome.isVisible = false;
              crossDome.setEnabled(false);
              crossMat.alpha = 0;
            }catch{}
            applyMainTexture(file, tex);
            resolve();
          }
        });
      };
      if (delayMs > 0) setTimeout(startFade, delayMs);
      else startFade();
    });
  }

  // Release GPU memory when tab is hidden/backgrounded (mobile stability)
  try{
    document.addEventListener('visibilitychange', ()=>{ if (document.visibilityState !== 'visible') purgeTextures(); });
    addEventListener('pagehide', ()=>purgeTextures());
  }catch{}

  try{
    engine.onContextLostObservable.add(()=>{
      console.warn("[AGENT] WebGL context lost - purging texture cache");
      purgeTextures();
    });
    engine.onContextRestoredObservable.add(()=>{
      console.info("[AGENT] WebGL context restored");
      try{
        const cur = nodesById.get(currentNodeId);
        if (cur?.file) { getTexture(cur.file).catch(()=>{}); }
      }catch{}
    });
  }catch{}

  /* hotspots */
  const hotspotRoot = new TransformNode("hotspots", scene); hotspotRoot.parent=dome; hotspotRoot.layerMask=0x2;
  const hotspotRootXR = new TransformNode("hotspotsXR", scene); hotspotRootXR.layerMask=0x1;
  function vecFromYawPitch(yawDeg,pitchDeg,R,flipY=false){ const y=rad(yawDeg), p=rad(pitchDeg||0), cp=Math.cos(p), sp=Math.sin(p); const ySign = flipY ? -1 : 1; return new Vector3(R*Math.cos(y)*cp, ySign*R*sp, -R*Math.sin(y)*cp); }
  function clearHotspots(){ try{ hotspotRoot.getChildren().forEach(n=>n.dispose()); }catch{} try{ hotspotRootXR.getChildren().forEach(n=>n.dispose()); }catch{} }
  function buildHotspotsInRoot(node, parentRoot, flipXLocal=false, isXR=false){
    if (!node?.hotspots) return;
    const R = (DOME_DIAMETER/2) * 0.98;
    const ringRadius = isXR ? 42 : 34;
    const pickDiameter = isXR ? 360 : 240;
    const hoverScaleFactor = isXR ? 1.22 : 1.10;
    for (const h of node.hotspots){
      const toId = h?.to; if (!toId || !nodesById.has(toId)) continue;
      const layer = parentRoot === hotspotRoot ? 0x2 : 0x1;
      const root=new TransformNode("hs-"+(toId||""),scene); root.parent=parentRoot||hotspotRoot; root.layerMask=layer;
      // Hollow ring sprite on a billboarded plane (always faces camera)
      const ring=MeshBuilder.CreatePlane("hsRing",{ size: ringRadius*2 },scene);
      const dt = new DynamicTexture("ringDT", { width: 256, height: 256 }, scene, false);
      try{ const ctx = dt.getContext(); ctx.clearRect(0,0,256,256); ctx.strokeStyle = "#FFFFFF"; const lw = Math.max(6, Math.floor(256*(isXR?0.09:0.08))); ctx.lineWidth = lw; ctx.beginPath(); ctx.arc(128,128, 128 - lw/2, 0, Math.PI*2); ctx.stroke(); dt.hasAlpha = true; dt.update(); }catch{}
      const rm=new StandardMaterial("hsRingMat",scene); rm.disableLighting=true; rm.backFaceCulling=false; rm.disableDepthWrite=true; rm.zOffset=1; rm.emissiveTexture = dt; rm.opacityTexture = dt;
      ring.material=rm; ring.parent=root; ring.layerMask = layer; ring.billboardMode=Mesh.BILLBOARDMODE_ALL; ring.isPickable=true; ring.renderingGroupId=2;
      
      const pick=MeshBuilder.CreateSphere("hsPick",{diameter:pickDiameter,segments:12},scene);
      const pm=new StandardMaterial("hsPickMat",scene); pm.alpha=0.001; pm.disableLighting=true; pm.backFaceCulling=false;
      pick.material=pm; pick.parent=root; pick.isPickable=true; pick.layerMask = layer;
      const baseScale = (root.scaling && typeof root.scaling.x === 'number') ? root.scaling.x : 1;
      const meta = {
        hotspot:true,
        to:toId,
        ring,
        root,
        preview:null,
        baseScale,
        hoverScale: hoverScaleFactor * baseScale
      };
      root.metadata = meta;
      ring.metadata = meta;
      pick.metadata = meta;
      // FIX: When dome is flipped vertically, invert Y coordinate for hotspots
      const v = vecFromYawPitch(h.yaw||0, h.pitch||0, R, flipXLocal);
      root.position.copyFrom(v);
      try{ root.lookAt(Vector3.Zero()); }catch{}
    }
  }
  function buildHotspotsFor(node, forXR=false){
    try{
      XRDebugLog("buildHotspots", {
        nodeId: node?.id,
        forXR,
        count: Array.isArray(node?.hotspots) ? node.hotspots.length : 0,
        hasRoot: !!(forXR ? hotspotRootXR : hotspotRoot)
      });
    }catch{}
    clearHotspots();
    if (forXR){
      buildHotspotsInRoot(node, hotspotRootXR, /*flipXLocal*/ flipX, /*isXR*/ true);
      try{ hotspotRoot.setEnabled(false); hotspotRootXR.setEnabled(true); }catch{}
    } else {
      buildHotspotsInRoot(node, hotspotRoot,   /*flipXLocal*/ flipX, /*isXR*/ false);
      try{ hotspotRoot.setEnabled(true); hotspotRootXR.setEnabled(false); }catch{}
    }
  }

  let hoveredHotspot = null; const _lastSpoken=new Map();
  async function ensurePreview(meta){
    try{
      if (!meta || meta.preview) return;
      const next = nodesById.get(meta.to); if (!next || !next.file) return;
      // Size preview to sit inside the ring (leave a small gutter)
      const ringSize = (meta?.ring?.getBoundingInfo?.()?.boundingBox?.extendSize?.x || 32) * 2;
      const size = Math.max(64, Math.min(280, ringSize * 0.86));

      const plane = MeshBuilder.CreatePlane("hsPrev", { size }, scene);
      const mat = new StandardMaterial("hsPrevMat", scene);
      mat.disableLighting = true;
      mat.backFaceCulling = false;
      mat.disableDepthWrite = true;
      mat.zOffset = 1;

      // Load the next node texture and map like main pano (mono crop for TB stereo)
      const tex = await getTexture(next.file);
      mat.emissiveTexture = tex;
      try { mapFor2D(tex, /*stereo*/ isStereo(), flipU); } catch {}

      // Circular opacity mask so the preview is perfectly round inside the ring
      try{
        const maskSize = 512;
        const dt = new DynamicTexture("hsPrevMask", { width: maskSize, height: maskSize }, scene, false);
        const ctx = dt.getContext();
        ctx.clearRect(0,0,maskSize,maskSize);
        ctx.fillStyle = "#ffffff";
        ctx.beginPath();
        ctx.arc(maskSize/2, maskSize/2, (maskSize/2) * 0.98, 0, Math.PI * 2);
        ctx.closePath();
        ctx.fill();
        dt.hasAlpha = true; dt.update();
        mat.opacityTexture = dt; // use as alpha mask
      }catch{}

      plane.material = mat;
      plane.parent = meta.root;
      plane.billboardMode = Mesh.BILLBOARDMODE_ALL;
      plane.layerMask = meta.root.layerMask;
      plane.isPickable = false;
      plane.renderingGroupId = 2;
      // Slightly in front so it feels inside the ring
      plane.position.z += 0.5;
      // Start slightly smaller; we animate to full on hover for an expanding reveal
      plane.scaling.set(0.85, 0.85, 0.85);
      meta.preview = plane;
    }catch{}
  }
  function removePreview(meta){ try{ meta?.preview?.dispose?.(); meta.preview=null; }catch{} }
  function setHotspotHover(meta, active){
    if (!meta) return;
    try{
      const ringMat = meta.ring?.material;
      if (ringMat?.emissiveColor) ringMat.emissiveColor.set(1,1,1);
      // Ring scale animation
      if (meta.root?.scaling){
        const base = meta.baseScale || 1;
        const target = active ? (meta.hoverScale || base * 1.1) : base;
        meta.root.scaling.set(target, target, target);
      }
      // Preview: ensure exists and ease its scale for a subtle reveal
      if (active){
        ensurePreview(meta).then(()=>{
          try{
            const p = meta.preview; if (!p) return;
            const start = performance.now();
            const from = Math.min(1, Math.max(0.7, p.scaling.x));
            const to = 1.0;
            const dur = 160;
            const obs = scene.onBeforeRenderObservable.add(()=>{
              const t = Math.min(1, (performance.now()-start)/dur);
              const s = from + (to-from)*t;
              p.scaling.set(s,s,s);
              if(t>=1) try{ scene.onBeforeRenderObservable.remove(obs); }catch{}
            });
          }catch{}
        });
      } else {
        removePreview(meta);
      }
    }catch{}
  }
  function updateHotspotHover(meta){
    if (hoveredHotspot === meta) return;
    if (hoveredHotspot) setHotspotHover(hoveredHotspot, false);
    hoveredHotspot = meta || null;
    if (hoveredHotspot){ setHotspotHover(hoveredHotspot, true); ensurePreview(hoveredHotspot);
      try{ const toId=hoveredHotspot.to; const last=_lastSpoken.get(toId)||0; const now=Date.now(); if(now-last>1500){ _lastSpoken.set(toId, now); const n=nodesById.get(toId); const label=(typeof n?.label==='string'&&n.label.trim())?n.label.trim(): (typeof n?.name==='string'?n.name:toId); speak(`Next: ${label}`); } }catch{}
    }
  }

  // 2D pick + hover highlight
  scene.onPointerObservable.add(poi=>{
    if (poi.type===PointerEventTypes.POINTERMOVE || poi.type===PointerEventTypes.POINTERDOWN){
      const hit=scene.pick(scene.pointerX,scene.pointerY,m=>m?.metadata?.hotspot===true,false,cam);
      const meta = hit?.pickedMesh?.metadata?.hotspot ? hit.pickedMesh.metadata : null;
      updateHotspotHover(meta);
    }
    if (poi.type===PointerEventTypes.POINTERUP){
      const pick=scene.pick(scene.pointerX,scene.pointerY,m=>m?.metadata?.hotspot===true,false,cam);
      const toId=pick?.pickedMesh?.metadata?.to;
      if (toId && nodesById.has(toId)) goTo(toId, { source: 'user', broadcast: true });
      updateHotspotHover(null);
    }
  });
  canvas.addEventListener("pointerleave", ()=>updateHotspotHover(null), { passive:true });
  canvas.addEventListener("pointercancel", ()=>updateHotspotHover(null), { passive:true });

  /* minimap */
  let mini = null;
  let minimapMode = "nodes";
  const minimapPointsByFloor = new Map();
  const minimapZonesByFloor = new Map();
  const zoneRepById = new Map();

  function getActiveMinimapId(){
    if (minimapMode !== "zones") return currentNodeId;
    const cur = nodesById.get(currentNodeId);
    if (cur?.zoneId) return cur.zoneId;
    for (const [zoneId, nodeId] of zoneRepById.entries()){
      if (nodeId === currentNodeId) return zoneId;
    }
    return null;
  }

  function rebuildMinimap(){
    document.querySelectorAll(".mini-wrap").forEach(el=>el.remove());
    minimapMode = "nodes";
    minimapPointsByFloor.clear();
    minimapZonesByFloor.clear();
    zoneRepById.clear();

    const padByFloor = new Map(data.floors.map(f=>[f.id,{x:0,y:0}]));
    const floorMetaById = new Map(data.floors.map(f=>[f.id, f]));
    // Coordinate reference per floor: auto-detect from zones (preferred) or nodes
    const coordByFloor = new Map(); // fid -> { w, h }
    const originByFloor = new Map(); // fid -> { x, y }
    const extentsByFloor = new Map(); // fid -> { minX, minY, maxX, maxY }
    const widenExtent = (fid, x, y)=>{
      if (!fid) return;
      const px = Number(x);
      const py = Number(y);
      if (!Number.isFinite(px) || !Number.isFinite(py)) return;
      const cur = extentsByFloor.get(fid) || { minX: Infinity, minY: Infinity, maxX: -Infinity, maxY: -Infinity };
      if (px < cur.minX) cur.minX = px;
      if (px > cur.maxX) cur.maxX = px;
      if (py < cur.minY) cur.minY = py;
      if (py > cur.maxY) cur.maxY = py;
      extentsByFloor.set(fid, cur);
    };

    const fallbackFloorId = data?.floors?.[0]?.id || null;
    const nodeList = Array.isArray(data?.nodes) ? data.nodes : [];
    const hasZones = Array.isArray(data?.zones) && data.zones.length > 0;
    if (hasZones){
      minimapMode = "zones";
      const centroid = (pts)=>{
        if (!Array.isArray(pts) || pts.length === 0) return { x: 0, y: 0 };
        let sx=0, sy=0;
        for (const p of pts){
          sx += Number(p?.x) || 0;
          sy += Number(p?.y) || 0;
        }
        return { x: sx/pts.length, y: sy/pts.length };
      };
      for (const z of (data.zones || [])){
        const floorId = z?.floorId || fallbackFloorId;
        if (!floorId) continue;
        const points = Array.isArray(z.points) ? z.points : [];
        for (const p of points){
          widenExtent(floorId, p?.x, p?.y);
        }
        let repId = (typeof z.repNodeId === "string" && nodesById.has(z.repNodeId)) ? z.repNodeId : null;
        if (!repId){
          const found = nodeList.find(n => n?.zoneId === z.id);
          repId = found?.id || null;
        }
        if (!repId){
          repId = startNodeId || (nodesById.size ? nodesById.values().next().value?.id : null);
        }
        if (repId) zoneRepById.set(z.id, repId);
        // Dot position = explicit repPoint if provided, else polygon centroid
        let px = 0, py = 0;
        if (z && typeof z === 'object' && z.repPoint && Number.isFinite(Number(z.repPoint.x)) && Number.isFinite(Number(z.repPoint.y))){
          px = Number(z.repPoint.x) || 0;
          py = Number(z.repPoint.y) || 0;
        } else {
          const c = centroid(points);
          px = Number(c.x) || 0;
          py = Number(c.y) || 0;
        }
        if (!minimapPointsByFloor.has(floorId)) minimapPointsByFloor.set(floorId, []);
        minimapPointsByFloor.get(floorId).push({
          id: z.id,
          x: px,
          y: py,
          label: (typeof z.name === "string" ? z.name.trim() || z.id : z.id)
        });
        if (!minimapZonesByFloor.has(floorId)) minimapZonesByFloor.set(floorId, []);
        minimapZonesByFloor.get(floorId).push({ id: z.id, points: (z.points||[]).map(p=>({x:p.x,y:p.y})), label: (typeof z.name==='string'? z.name : z.id) });
      }
    } else {
      minimapMode = "nodes";
      for (const n of nodeList){
        if (!n) continue;
        const floorId = n.floorId || fallbackFloorId;
        if (!floorId) continue;
        const px = Number(n.x);
        const py = Number(n.y);
        if (!minimapPointsByFloor.has(floorId)) minimapPointsByFloor.set(floorId, []);
        minimapPointsByFloor.get(floorId).push({
          id: n.id,
          x: Number.isFinite(px) ? px : 0,
          y: Number.isFinite(py) ? py : 0,
          label: (typeof n.label === "string" ? n.label : undefined),
          name: (typeof n.name === "string" ? n.name : undefined)
        });
      }
    }
    for (const n of nodeList){
      if (!n) continue;
      widenExtent(n.floorId, n.x, n.y);
    }
    for (const f of data.floors){
      const meta = floorMetaById.get(f.id) || f || {};
      const explicitW = Number(meta?.width ?? meta?.w ?? meta?.imageWidth ?? 0) || 0;
      const explicitH = Number(meta?.height ?? meta?.h ?? meta?.imageHeight ?? 0) || 0;
      const hasExplicitSize = explicitW > 0 && explicitH > 0;

      const explicitOriginXRaw = meta?.originX;
      const explicitOriginYRaw = meta?.originY;
      const hasExplicitOrigin = Number.isFinite(Number(explicitOriginXRaw)) && Number.isFinite(Number(explicitOriginYRaw));
      const explicitOriginX = hasExplicitOrigin ? Number(explicitOriginXRaw) : 0;
      const explicitOriginY = hasExplicitOrigin ? Number(explicitOriginYRaw) : 0;

      const e = extentsByFloor.get(f.id);
      const spanX = e && Number.isFinite(e.maxX) && Number.isFinite(e.minX) ? (e.maxX - e.minX) : 0;
      const spanY = e && Number.isFinite(e.maxY) && Number.isFinite(e.minY) ? (e.maxY - e.minY) : 0;

      

      if (hasExplicitSize){
        let originX = hasExplicitOrigin ? explicitOriginX : 0;
        let originY = hasExplicitOrigin ? explicitOriginY : 0;
        let refW = explicitW;
        let refH = explicitH;
        if (e){
          if (Number.isFinite(e.minX) && e.minX < originX) originX = e.minX;
          if (Number.isFinite(e.minY) && e.minY < originY) originY = e.minY;
          if (Number.isFinite(e.maxX)) refW = Math.max(refW, e.maxX - originX);
          if (Number.isFinite(e.maxY)) refH = Math.max(refH, e.maxY - originY);
        }
        originByFloor.set(f.id, { x: originX, y: originY });
        if (refW > 0 && refH > 0) coordByFloor.set(f.id, { w: refW, h: refH });
        continue;
      }

      // If no explicit size/origin, rely on image natural size with origin (0,0) in minimap DOM.
    }
    const coordsModePref = "auto";

    mini = buildMinimapDOM({
      floors:data.floors, basePath:BASE, padByFloor, coordsMode: "auto", ui:"dropdown",
      mappingMode: "editor",
      panelWidth:"clamp(220px, min(52vw, 48vh), 420px)", position:"top-right", paddingPx:16,
      coordByFloor,
      originByFloor,
      zonesByFloor: minimapZonesByFloor,
      onSelectNode:id=>{
        if (!id) return;
        if (minimapMode === "zones"){
          const targetId = zoneRepById.get(id) || nodeList.find(n=>n?.zoneId === id)?.id || startNodeId || null;
          if (targetId) goTo(targetId, { source: 'user', broadcast: true });
          return;
        }
        goTo(id, { source: 'user', broadcast: true });
      },
      onFloorChange:fid=>{
        mini.renderZones(minimapZonesByFloor.get(fid) || [], (nodesById.get(currentNodeId)||{}).zoneId || null);
        const list = minimapPointsByFloor.get(fid) || [];
        const active = (nodesById.get(currentNodeId)||{}).zoneId || null;
        mini.renderPoints(list, active);
        updateMinimapTorch();
      }
    });
    const cur = nodesById.get(currentNodeId) || nodesById.get(startNodeId) || (nodesById.size?nodesById.values().next().value:null);
    if (cur){
      mini.setActiveFloor(cur.floorId,true,true);
      mini.renderZones(minimapZonesByFloor.get(cur.floorId) || [], (nodesById.get(currentNodeId)||{}).zoneId || null);
      const list = minimapPointsByFloor.get(cur.floorId) || [];
      const active = (nodesById.get(currentNodeId)||{}).zoneId || null;
      mini.renderPoints(list, active);
      updateMinimapTorch();
    }
  }
  rebuildMinimap();

  // Torch (orientation wedge) on minimap
  function getActiveZoneFirstPoint(){
    try{
      const cur = nodesById.get(currentNodeId);
      if (!cur) return null;
      const fid = cur.floorId;
      const zid = cur.zoneId;
      const zones = minimapZonesByFloor.get(fid) || [];
      const z = zones.find(s=>s.id===zid);
      if (!z || !Array.isArray(z.points) || !z.points.length) return null;
      if (z.repPoint && Number.isFinite(Number(z.repPoint.x)) && Number.isFinite(Number(z.repPoint.y))){
        return { floorId: fid, x: Number(z.repPoint.x)||0, y: Number(z.repPoint.y)||0 };
      }
      let sx=0, sy=0; for (const p of z.points){ sx+=Number(p?.x)||0; sy+=Number(p?.y)||0; }
      const cx=sx/z.points.length, cy=sy/z.points.length;
      return { floorId: fid, x: cx||0, y: cy||0 };
    }catch{ return null; }
  }
  function computeHeadingForMap(){
    try{
      const cur = nodesById.get(currentNodeId);
      if (!cur) return 0;
      const meta = (data?.floors||[]).find(f=>f.id===cur.floorId) || {};
      const DEFAULT_MAP_YAW_OFFSET_DEG = (Number(import.meta?.env?.VITE_MAP_YAW_OFFSET) || -90);
      const offsetDeg = Number(meta?.mapYawOffset ?? meta?.northDeg ?? meta?.rotationDeg ?? DEFAULT_MAP_YAW_OFFSET_DEG) || 0;
      const offset = rad(offsetDeg);
      // Camera heading relative to world + optional floor offset
      return (worldYaw + cam.rotation.y + offset);
    }catch{ return 0; }
  }
  function updateMinimapTorch(){
    try{
      if (!mini) return;
      const pp = getActiveZoneFirstPoint();
      if (!pp) { mini.setTorchPose({ visible:false }); return; }
      mini.setTorchPose({ floorId: pp.floorId, x: pp.x, y: pp.y, yawRad: computeHeadingForMap(), visible:true });
    }catch{}
  }

  /* move then swap */
  function easeInOutSine(t){ return -(Math.cos(Math.PI*t)-1)/2; }
  function cubicBezier(p0, p1, p2, p3, t){
    const u = 1 - t;
    const uu = u * u;
    const tt = t * t;
    const uuu = uu * u;
    const ttt = tt * t;
    const out = p0.scale(uuu);
    out.addInPlace(p1.scale(3 * uu * t));
    out.addInPlace(p2.scale(3 * u * tt));
    out.addInPlace(p3.scale(ttt));
    return out;
  }
  function forwardPushThenSwap(nextNode, prevNode = null, options = {}){
    const duration = Number.isFinite(options?.duration) ? options.duration : NAV_DUR_MS;
    const basePush = Number.isFinite(options?.push) ? options.push : NAV_PUSH_M;
    const source = typeof options?.source === 'string' ? options.source.toLowerCase() : 'program';
    const inXRMode = inXR === true;
    const push = inXRMode ? basePush * 0.55 : basePush;
    const lerp = (a,b,t)=>a + (b - a) * Math.max(0, Math.min(1, t));
    const startPos = worldRoot.position.clone();
    const targetPos = nodeWorldPos(nextNode);
    let forward = new Vector3(-Math.sin(worldYaw), 0, -Math.cos(worldYaw));
    if (forward.lengthSquared() < 1e-6) forward = new Vector3(0, 0, -1);
    forward.normalize();
    const delta = targetPos.subtract(startPos);
    const distance = delta.length();
    const travelDir = distance > 1e-4 ? delta.normalize() : forward.clone();
    const startMag = Math.max(push * 0.65, Math.min(distance + push * 0.35, push * 1.8));
    const endMag = Math.max(push * 0.4, Math.min(distance * 0.6, push * 1.2));
    const ctrl1 = startPos.add(forward.scale(startMag));
    const ctrl2 = targetPos.subtract(travelDir.scale(endMag));
    const liftScale = inXRMode ? 0.45 : 1;
    const lift = Math.min(1.2, Math.max(0.2, startMag * 0.1 * liftScale));
    ctrl1.y += lift;
    ctrl2.y += lift * 0.5;
    const baseMs = duration + 480;
    const travelFactor = Math.max(1, (distance + 0.5) / Math.max(0.4, push * 0.5));
    let travelMs = Math.max(900, Math.min(2400, baseMs * travelFactor));
    if (inXRMode) {
      // Slower, smoother travel in immersive mode
      travelMs = Math.max(1400, Math.min(3200, travelMs * 1.6));
    }
    const useCross = (!inXRMode) && wantsCrossfade();
    const startYaw = worldYaw;
    const travelYaw = distance > 1e-4 ? Math.atan2(-delta.x, -delta.z) : startYaw;
    const nodeYaw = Number.isFinite(nextNode?.yaw) ? -rad(nextNode.yaw) : travelYaw;
    const targetYaw = lerpAngle(travelYaw, nodeYaw, 0.35);
    const camYawStart = cam.rotation.y;
    const camPitchStart = cam.rotation.x;
    const camYawTarget = (source === 'tour' || inXRMode) ? camYawStart : 0;
    const camPitchTarget = (source === 'tour' || inXRMode) ? camPitchStart : 0;
    const reCenterStrength = (source === 'tour')
      ? (inXRMode ? 0 : 0.35)
      : 0;
    const startFov = cam.fov;
    const midFov = Math.max(0.70, Math.min(startFov - (inXRMode ? 0.03 : 0.12), 1.05));
    const destFov = startFov;
    // Align drift direction to the direction we will rotate for this transition
    try { driftSign = shortestSign(startYaw, targetYaw); } catch {}

    const travelPromise = new Promise((resolve) => {
      const startTime = performance.now();
      const observer = scene.onBeforeRenderObservable.add(() => {
        const elapsed = performance.now() - startTime;
        const t = Math.min(1, elapsed / travelMs);
        const eased = easeInOutSine(t);
        const pos = cubicBezier(startPos, ctrl1, ctrl2, targetPos, eased);
        worldRoot.position.copyFrom(pos);
        const yawNow = lerpAngle(startYaw, targetYaw, eased);
        worldRoot.rotation.y = yawNow;
        if (reCenterStrength > 0){
          const camBlend = Math.min(1, eased * reCenterStrength);
          cam.rotation.y = lerpAngle(camYawStart, camYawTarget, camBlend);
          const pitchValue = camPitchStart + (camPitchTarget - camPitchStart) * camBlend;
          setCamPitch(pitchValue);
        }
        const focus = Math.sin(Math.min(Math.PI, eased * Math.PI));
        cam.fov = startFov - (startFov - midFov) * focus;
        if (t >= 1) {
          scene.onBeforeRenderObservable.remove(observer);
          worldRoot.rotation.y = targetYaw;
          if (reCenterStrength > 0){
            cam.rotation.y = camYawTarget;
            setCamPitch(camPitchTarget);
          }
          cam.fov = destFov;
          resolve();
        }
      });
    });
    const texturePromise = useCross ? getTexture(nextNode.file).catch(()=>null) : Promise.resolve(null);
    return texturePromise.then((tex)=>{
      const fadeDelay = Math.round(travelMs * 0.25);
      const fadeMs = Math.max(420, Math.min(1400, travelMs * 0.7));
      const transitionPromise = (useCross && tex)
        ? runCrossFade(nextNode.file, tex, fadeMs, fadeDelay)
        : showFile(nextNode.file);
      return Promise.all([travelPromise, transitionPromise]);
    }).catch(()=>Promise.all([travelPromise, showFile(nextNode.file)])).then(()=>{
      worldRoot.position.copyFrom(targetPos);
      worldYaw = targetYaw;
      buildHotspotsFor(nextNode, /*forXR*/ inXR === true);
    });
  }
  let navLock=false;
  function goTo(targetId, opts = {}){
    if (navLock) return Promise.resolve();
    if (!(targetId && targetId!==currentNodeId)) return Promise.resolve();
    const node=nodesById.get(targetId); if(!node) return Promise.resolve();
    const prevNode = nodesById.get(currentNodeId) || null;
    navLock=true; currentNodeId=node.id;
    try{ console.info('[AGENT] goTo', node.id, node.file); }catch{}
    const source = String(opts?.source || 'program').toLowerCase();
    const shouldBroadcast = opts?.broadcast !== undefined ? Boolean(opts.broadcast) : (source !== 'program');
    const shouldSync = opts?.sync !== undefined ? Boolean(opts.sync) : shouldBroadcast;
    try { dispatchEvent(new CustomEvent('agent:navigate', { detail: { nodeId: currentNodeId, source } })); } catch {}
    const fid=node.floorId; mini?.setActiveFloor(fid,true,true);
    mini?.renderZones(minimapZonesByFloor.get(fid) || [], node.zoneId || null);
    const list = minimapPointsByFloor.get(fid) || [];
    mini?.renderPoints(list, node.zoneId || null);
    updateMinimapTorch();
    return forwardPushThenSwap(node, prevNode, { duration: opts?.duration, push: opts?.push, source }).then(()=>{ if (shouldSync) sendSync(currentNodeId); }).finally(()=>{ navLock=false; });
  }

  /* ===== Mirror grid (multi-UID) ===== */
  // Mirror viewport panel anchored to bottom-right
  const PANEL = { x: 1 - 0.20 - 0.02, y: 1 - 0.26 - 0.02, w: 0.20, h: 0.26 };
  const viewers = new Map(); // uid -> {cam, root, nodeId, last, yaw?, pitch?}
  let _mirrorCams = [];
  let mirrorVisible = true;
  let mirrorPrimary = false;        // when true -> mirror grid is large and main cam small

  const hud = document.getElementById("mirrorHud");
  const uidNum = new Map(); const getUidNum = uid => { if (!uidNum.has(uid)) uidNum.set(uid, uidNum.size + 1); return uidNum.get(uid); };
  function ensureBadge(uid){ if (!hud) return null; let el = hud.querySelector(`[data-uid="${uid}"]`); if (!el){ el = document.createElement("div"); el.dataset.uid = uid; el.className = "mirror-badge"; el.textContent = getUidNum(uid); hud.appendChild(el); } return el; }

  function updateMirrorLayout(){
    // In XR, never override activeCameras; keep XR camera active.
    if (inXR === true){
      try{ scene.activeCameras = [ (xr?.baseExperience?.camera || scene.activeCamera) ]; }catch{}
      if (hud) hud.innerHTML='';
      _mirrorCams = [];
      return;
    }
    const cams=[], list=[...viewers.values()], n=list.length;
    if (!mirrorVisible || !n){ _mirrorCams=[]; cam.viewport=new Viewport(0,0,1,1); scene.activeCameras=[cam]; if(hud) hud.innerHTML=''; return; }
    const cols=Math.ceil(Math.sqrt(n)), rows=Math.ceil(n/cols), tileW=PANEL.w/cols, tileH=PANEL.h/rows;
    const PANEL_RECT = { x: PANEL.x, y: 1-(PANEL.y+PANEL.h), w: PANEL.w, h: PANEL.h };
    cam.viewport = mirrorPrimary ? new Viewport(PANEL_RECT.x, PANEL_RECT.y, PANEL_RECT.w, PANEL_RECT.h) : new Viewport(0,0,1,1);
    for (let i=0;i<n;i++){
      const v=list[i]; const col=i%cols, row=(i/cols)|0;
      const vx=PANEL.x+col*tileW, vy=PANEL.y+row*tileH, vw=tileW, vh=tileH;
      v.cam.viewport = mirrorPrimary ? new Viewport(0,0,1,1) : new Viewport(vx, 1-(vy+vh), vw, vh);
      cams.push(v.cam);
      const el=ensureBadge([...viewers.keys()][i]); if(el){ const pad=6, size=22; el.style.left=`calc(${vx*100}% + ${vw*100}% - ${pad + size}px)`; el.style.top =`calc(${(1-(vy+vh))*100}% + ${vh*100}% - ${pad + size}px)`; el.textContent=getUidNum([...viewers.keys()][i]); }
    }
    _mirrorCams = cams;
    scene.activeCameras = mirrorPrimary ? [..._mirrorCams, cam] : [cam, ..._mirrorCams];
  }

  const mirrorDome = MeshBuilder.CreateSphere("mirrorDome",{diameter:DOME_DIAMETER,segments:48,sideOrientation:Mesh.BACKSIDE},scene);
  if(flipX) mirrorDome.rotation.x=Math.PI;
  // Isolate mirror content on its own layer so main camera doesn't render it
  mirrorDome.layerMask=0x4; mirrorDome.isPickable=false;
  const mirrorMat = new StandardMaterial("mirrorMat",scene);
  mirrorMat.disableLighting=true; mirrorMat.backFaceCulling=false;
  mirrorMat.transparencyMode=Material.MATERIAL_ALPHABLEND; mirrorMat.disableDepthWrite=true;
  mirrorDome.material = mirrorMat;

  let mirrorNodeId=null, mirrorTexKey=null;
  async function setMirrorNode(id){ if (!id || id===mirrorNodeId || !nodesById.has(id)) return; const file = nodesById.get(id).file, key = BASE + "|" + file; if (mirrorTexKey === key) { mirrorNodeId = id; return; } const tex = await getTexture(file); mirrorMat.emissiveTexture = tex; mapFor2D(tex, /*stereo*/ isStereo(), flipU); mirrorTexKey = key; mirrorNodeId = id; try{ const keep = new Set([key]); retainOnly(keep); retainSW([panoUrl(file)]); }catch{} }

  /* WebSocket (guide + viewers) */
  let socket=null; let wsIndex=0; let wsLockedIdx=-1;
  function safeSend(o){ if (socket && socket.readyState===1){ try{ socket.send(JSON.stringify(o)); }catch{} } }
  function sendSync(nodeId){
    if (!nodeId) return;
    const expPath = `experiences/${expName()}`;
    // Include autoplay state so viewers in XR can enable drift/animation cues
    let tour = false; try { tour = Boolean(window?.__tour?.isPlaying?.()); } catch {}
    safeSend({ type: "sync", room: roomId, nodeId, exp: expName(), expPath, worldPos: v3arr(worldRoot.position), tour });
  }
  // Smooth angle interpolation (handles wrap-around at +-PI)
  function lerpAngle(prev, next, alpha){
    const TAU = Math.PI * 2;
    let d = (next - prev) % TAU;
    if (d > Math.PI) d -= TAU;
    if (d < -Math.PI) d += TAU;
    return prev + d * Math.max(0, Math.min(1, alpha));
  }
  (function connect(){
    let retryMs=2000;
    const idx = (wsLockedIdx>=0 ? wsLockedIdx : (wsIndex % WS_LIST.length));
    const url = WS_LIST[idx];
    A("ws try", { url, idx, locked: wsLockedIdx });
    try{ socket=new WebSocket(url); }catch{ socket=null; if (wsLockedIdx<0) wsIndex=(wsIndex+1)%WS_LIST.length; return setTimeout(connect, retryMs); }
    let opened=false; const OPEN_TIMEOUT_MS=2500; const to=setTimeout(()=>{ if(!opened){ A("ws timeout",{url}); try{ socket?.close(); }catch{} } }, OPEN_TIMEOUT_MS);
    socket.addEventListener("open", ()=>{ opened=true; clearTimeout(to); retryMs=2000; wsLockedIdx = idx; A("ws open",{url,room:roomId, locked:true}); safeSend({type:"join", room:roomId, role:"guide"}); if(currentNodeId) sendSync(currentNodeId); });
    function schedule(reason){ clearTimeout(to); try{ socket?.close(); }catch{}; wsLockedIdx = -1; wsIndex = (wsIndex+1) % WS_LIST.length; A("ws retry", { reason, next: WS_LIST[wsIndex] }); setTimeout(connect, retryMs); retryMs = Math.min(retryMs*1.7, 15000); }
    socket.addEventListener("close", ()=>{ socket=null; if(!opened) schedule("close-before-open"); else schedule("closed"); });
    socket.addEventListener("error", ()=>{ schedule("error"); });
    socket.addEventListener("message", (ev)=>{
      let msg; try{ msg=JSON.parse(ev.data); }catch{ return; }
      if (!(msg && msg.room===roomId)) return;
      // From viewers: { type:"sync", from:"viewer", uid, pose:{yaw,pitch,mode}, nodeId? }
      const isViewer = msg.type==="sync" && msg.from==="viewer" && typeof msg.uid==="string";
      if (isViewer){
        A("viewer msg", { uid: msg.uid, pose: msg.pose, nodeId: msg.nodeId });
        if (!viewers.has(msg.uid)){
          const mCam = new FreeCamera("mcam_"+msg.uid, new Vector3(0,0,0), scene);
          const root = new TransformNode("mCamRoot_"+msg.uid, scene);
          mCam.parent = root; mCam.position.set(0,1.6,0);
          mCam.fov=1.0; mCam.minZ=0.1; mCam.maxZ=50000; mCam.layerMask=0x4; // mirror-only layer
          viewers.set(msg.uid, { cam:mCam, root, nodeId:null, last: performance.now() });
          updateMirrorLayout();
        }
        const v = viewers.get(msg.uid); v.last = performance.now();
        if (msg.pose){
          const mode = (msg.pose && (msg.pose.mode||'')).toLowerCase();
          const xrFixPitch = (mode === 'xr') ? -1 : 1; // XR pitch sign may differ; flip so up = up
          const xrFixYaw   = (mode === 'xr' && flipU) ? -1 : 1; // When texture is flipped, yaw sign differs
          const targetYaw   = (MIRROR_YAW_SIGN * xrFixYaw) * (typeof msg.pose.yaw==='number'? msg.pose.yaw : 0);
          const targetPitch = (MIRROR_PITCH_SIGN * xrFixPitch) * (typeof msg.pose.pitch==='number'? msg.pose.pitch : 0);
          // OPTIMIZED: Smooth interpolation to reduce jitter from network latency
          const alpha = 0.3; // 30% blend for smooth tracking
          v.root.rotation.y = lerpAngle(v.root.rotation.y, targetYaw, alpha);
          v.root.rotation.x = lerpAngle(v.root.rotation.x, targetPitch, alpha);
        }
        if (msg.nodeId) { v.nodeId = msg.nodeId; setMirrorNode(msg.nodeId); }
      }
    });
  })();

  // Periodically remove stale viewer mirrors (no updates for 30s)
  setInterval(()=>{
    const now = performance.now();
    let changed = false;
    for (const [uid, v] of viewers.entries()){
      if ((now - (v.last||0)) > 30000){ try{ v.cam?.dispose?.(); }catch{} try{ v.root?.dispose?.(); }catch{} viewers.delete(uid); changed = true; }
    }
    if (changed) updateMirrorLayout();
  }, 10000);

  // Ensure mirror texture follows the most recent viewer continuously (guards against missed messages)
  let lastMirrorUpdate = 0;
  scene.onBeforeRenderObservable.add(()=>{
    const now = performance.now();
    if (now - lastMirrorUpdate < 800) return; // throttle ~1.25Hz
    lastMirrorUpdate = now;
    try{
      let newest = null, newestT = -Infinity;
      for (const v of viewers.values()){ if (v?.nodeId && (v.last||0) > newestT){ newest = v; newestT = v.last; } }
      if (newest && newest.nodeId && newest.nodeId !== mirrorNodeId){ setMirrorNode(newest.nodeId); }
    }catch{}
  });

  // Update minimap torch heading at ~10Hz
  let _miniTorchTick = 0;
  scene.onBeforeRenderObservable.add(()=>{
    const t = performance.now();
    if (t - _miniTorchTick < 100) return; // 10Hz
    _miniTorchTick = t;
    updateMinimapTorch();
  });

  // Cinematic drift during autoplay (Agent 2D and XR)
  function isTourPlaying(){ try{ return Boolean(window?.__tour?.isPlaying?.()); }catch{ return false; } }
  scene.onBeforeRenderObservable.add(()=>{
    try{
      if (!DRIFT_ACTIVE) return;
      if (inXR === true && !DRIFT_ALLOW_XR) return;  // configurable XR gate
      if (navLock) return;        // skip during travel
      const playing = isTourPlaying();
      // Stop any idle/initial drift in normal Agent-led mode.
      // Only apply drift while autoplay tour is actively playing.
      if (!playing) return;
      const t2 = (performance && performance.now ? performance.now() : Date.now());

      // Periodically align drift sign to the direction of the next tour step, if available
      if (t2 - driftPlanTouch > 800){
        try{
          const tour = (window && window.__tour) ? window.__tour : null;
          if (tour && typeof tour.getSteps === 'function'){
            const idx = Number(tour.getIndex?.() ?? -1);
            const steps = tour.getSteps?.() || [];
            const next = steps[idx + 1];
            const targetId = next?.nodeId;
            if (targetId && nodesById?.has?.(targetId)){
              const n = nodesById.get(targetId);
              const ty = Number.isFinite(n?.yaw) ? -rad(n.yaw) : worldYaw;
              driftSign = shortestSign(worldYaw, ty);
            }
          }
        }catch{}
        driftPlanTouch = t2;
      }

      // Apply continuous rotation during autoplay
      if (!driftLastT) driftLastT = t2;
      const dtMs = Math.max(0, Math.min(100, t2 - driftLastT)); // clamp to avoid jumps
      driftLastT = t2;
      const rate = DRIFT_RATE_RPS;
      driftAccum += driftSign * rate * (dtMs / 1000);
      worldRoot.rotation.y = worldYaw + driftAccum;
    }catch{}
  });

  /* camera drag */
  let dragging=false,lastX=0,lastY=0,cPitch=0;
  const yawSpeed=0.005, pitchSpeed=0.003, pitchClamp=rad(70);
  function setCamPitch(p){ cPitch=Math.max(-pitchClamp,Math.min(pitchClamp,p)); cam.rotation.x=cPitch; }
  canvas.style.cursor="grab"; try{ canvas.addEventListener("pointerdown", ()=>{ unlockAudio(); }, { passive:true }); }catch{}
  canvas.addEventListener("pointerdown",e=>{ dragging=true; lastX=e.clientX; lastY=e.clientY; try{canvas.setPointerCapture(e.pointerId);}catch{} canvas.style.cursor="grabbing"; },{passive:false});
  canvas.addEventListener("pointermove",e=>{ if(!dragging) return; const dx=e.clientX-lastX, dy=e.clientY-lastY; lastX=e.clientX; lastY=e.clientY; cam.rotation.y -= dx*yawSpeed; setCamPitch(cPitch - dy*pitchSpeed); sendSync(currentNodeId); },{passive:true});
  canvas.addEventListener("pointerup",()=>{ dragging=false; canvas.style.cursor="grab"; try{ canvas.addEventListener("pointerdown", ()=>{ unlockAudio(); }, { passive:true }); }catch{} },{passive:true});
  // Zoom and pinch
  const MIN_FOV = 0.45, MAX_FOV = 1.7; function clampFov(v){ return Math.max(MIN_FOV, Math.min(MAX_FOV, v)); }
  const fingers = new Map(); let pinchOn=false, pinchRef=0, pinchBase=cam.fov;
  function pDist(a,b){ const dx=a.x-b.x, dy=a.y-b.y; return Math.hypot(dx,dy) || 1; }
  canvas.addEventListener("pointerdown", (e)=>{ fingers.set(e.pointerId, { x:e.clientX, y:e.clientY }); if (fingers.size === 2){ const arr=[...fingers.values()]; pinchRef = pDist(arr[0], arr[1]); pinchBase = cam.fov; pinchOn = true; dragging = false; canvas.style.cursor='grab'; } }, { passive:false });
  canvas.addEventListener("pointermove", (e)=>{ const p=fingers.get(e.pointerId); if (p){ p.x=e.clientX; p.y=e.clientY; } if (pinchOn && fingers.size>=2){ const arr=[...fingers.values()]; const cur = pDist(arr[0], arr[1]); const scale = Math.max(0.25, Math.min(4, cur / (pinchRef || 1))); cam.fov = clampFov(pinchBase * scale); } }, { passive:true });
  function endPinch(e){ fingers.delete(e.pointerId); if (fingers.size < 2) pinchOn = false; }
  canvas.addEventListener("pointerup", endPinch, { passive:true });
  canvas.addEventListener("pointercancel", endPinch, { passive:true });
  canvas.addEventListener("pointerleave", endPinch, { passive:true });
  canvas.addEventListener("wheel", (e)=>{ e.preventDefault(); const step = Math.max(-0.2, Math.min(0.2, (e.deltaY||0)*0.0012)); cam.fov = clampFov(cam.fov + step); }, { passive:false });

  // No extra smoothing to avoid drift; rely on direct mapping above

  /* XR (optional) */
  let xr=null; let inXR=false; const vrDomes=[null,null]; let activeVr=0; let prevHSL=null;
  function setVrStereoMode(d){
    const mode = isStereo()? PhotoDome.MODE_TOPBOTTOM : PhotoDome.MODE_MONOSCOPIC;
    try{ if ("stereoMode" in d) d.stereoMode = mode; }catch{}
    try{ if ("imageMode" in d) d.imageMode = mode; }catch{}
    try{ if (d?.photoTexture) d.photoTexture.isBlocking = false; }catch{}
  }
  function ensureVrDome(index){
    if (vrDomes[index]) return vrDomes[index];
    const domeVR = new PhotoDome("pd_"+index, panoUrl(nodesById?.get?.(currentNodeId)?.file || ""), { size: DOME_DIAMETER }, scene);
    domeVR.mesh.isVisible = false;
    domeVR.mesh.isPickable = false;
    try{ domeVR.mesh.layerMask = 0x1; }catch{}
    domeVR.mesh.parent = worldRoot; // follow world transforms without drift
    // Apply correct stereo mode up-front based on current experience
    setVrStereoMode(domeVR);
    vrDomes[index] = domeVR;
    return domeVR;
  }
  const loadUrlIntoDome = async (dome, url)=>{
    return new Promise((resolve)=>{
      if (!dome?.photoTexture){ resolve(); return; }
      const tex = dome.photoTexture;
      let done = false;
      const cleanup = ()=>{ if (obs){ try{ tex.onLoadObservable.remove(obs); }catch{} } };
      const obs = tex.onLoadObservable.add(()=>{ done = true; cleanup(); resolve(); });
      try{ tex.updateURL(url); }catch{ cleanup(); resolve(); }
      setTimeout(()=>{ if(!done){ console.warn('[AGENT] Texture load timeout:', url); cleanup(); resolve(); } }, 8000);
    }).then(()=>{
      try{ const tex = dome?.photoTexture; if (tex){ tex.anisotropicFilteringLevel = 8; } }catch{}
    });
  };
  function attachXRHotspotsToCurrentDome(){
    try{
      const mesh = (vrDomes[activeVr]||vrDomes[0]||vrDomes[1])?.mesh || ensureVrDome(activeVr)?.mesh;
      // Fallback to worldRoot so hotspots still exist in XR even if the VR dome isn't ready yet
      hotspotRootXR.parent = mesh || worldRoot;
    }catch{}
  }
  const tmpPointerRay = new Ray(new Vector3(), new Vector3(0,0,1), DOME_DIAMETER);

  // Build a picking ray from an XR controller/pointer combo; prefer Babylon's world pointer ray
  function makeHotspotRayFromPointer(ptr, controller){
    try{
      if (!ptr && !controller) return { ray: null, hit: null };
      const pred = (m)=>m?.metadata?.hotspot===true;
      const candidates = [];
      const pushRay = (originVec, directionVec)=>{
        if (!originVec || !directionVec) return;
        const dir = directionVec.clone ? directionVec.clone() : directionVec;
        if (typeof dir.lengthSquared === "function" && dir.lengthSquared() === 0) return;
        if (dir.normalize) dir.normalize();
        const origin = originVec.clone ? originVec.clone() : originVec;
        candidates.push(new Ray(origin, dir, DOME_DIAMETER));
      };
      try{
        if (controller?.getWorldPointerRayToRef){
          controller.getWorldPointerRayToRef(tmpPointerRay);
          tmpPointerRay.length = DOME_DIAMETER;
          if (tmpPointerRay.origin && tmpPointerRay.direction){
            pushRay(tmpPointerRay.origin, tmpPointerRay.direction);
            const reverseDir = tmpPointerRay.direction.clone ? tmpPointerRay.direction.clone().scaleInPlace(-1) : null;
            if (reverseDir) pushRay(tmpPointerRay.origin, reverseDir);
          }
        } else if (controller?.getWorldPointerRay){
          const ray = controller.getWorldPointerRay();
          if (ray?.origin && ray?.direction){
            pushRay(ray.origin, ray.direction);
            const reverseDir = ray.direction.clone ? ray.direction.clone().scaleInPlace(-1) : null;
            if (reverseDir) pushRay(ray.origin, reverseDir);
          }
        }
      }catch{}
      try{
        const forwardRay = ptr?.getForwardRay?.(DOME_DIAMETER);
        if (forwardRay?.origin && forwardRay?.direction){
          pushRay(forwardRay.origin, forwardRay.direction);
          const reverseDir = forwardRay.direction.clone ? forwardRay.direction.clone().scaleInPlace(-1) : null;
          if (reverseDir) pushRay(forwardRay.origin, reverseDir);
        }
      }catch{}
      if (!candidates.length && ptr){
        const origin = ptr.getAbsolutePosition?.() || ptr.absolutePosition || ptr.position || Vector3.Zero();
        const world = ptr.getWorldMatrix?.();
        if (world){
          const fwd = Vector3.TransformNormal(new Vector3(0,0, 1), world);
          const back = Vector3.TransformNormal(new Vector3(0,0,-1), world);
          pushRay(origin, fwd);
          pushRay(origin, back);
        } else if (ptr.getDirection){
          const fwd = ptr.getDirection(new Vector3(0,0,1), scene);
          const back = ptr.getDirection(new Vector3(0,0,-1), scene);
          pushRay(origin, fwd);
          pushRay(origin, back);
        }
      }
      let bestRay = candidates[0] || null;
      let bestHit = null;
      let bestDist = Infinity;
      for (const ray of candidates){
        if (!ray) continue;
        const hit = scene.pickWithRay(ray, pred, false, null, xr?.baseExperience?.camera || scene.activeCamera);
        if (hit?.hit && hit.distance <= bestDist){
          bestDist = hit.distance;
          bestRay = ray;
          bestHit = hit;
        }
      }
      return { ray: bestRay, hit: bestHit };
    }catch{ return { ray: null, hit: null }; }
  }
  async function setVrPano(file){
    const url = panoUrl(file);
    const next = 1 - activeVr;
    const nextDome = ensureVrDome(next);
    setVrStereoMode(nextDome);
    await loadUrlIntoDome(nextDome, url);
    try{ nextDome.mesh.setEnabled(true); }catch{}
    nextDome.mesh.isVisible = true;
    const cur = vrDomes[activeVr];
    if (cur){ try{ cur.mesh.isVisible = false; cur.mesh.setEnabled(false); }catch{} }
    activeVr = next;
    attachXRHotspotsToCurrentDome();
    try{ hotspotRoot.setEnabled(false); hotspotRootXR.setEnabled(true); }catch{}
    try{ const curNode = nodesById?.get?.(currentNodeId); if (curNode) buildHotspotsFor(curNode, /*forXR*/ true); }catch{}
    try{ retainSW([url]); }catch{}
  }
  try{
    if (navigator?.xr){
      const qs = new URLSearchParams(location.search);
      const xrRef = (qs.get('xrRef') || 'local-floor');
      const XR_DEBUG = qs.has('xrdebug');
      let xrDebugLabel = null;
      let lastXRDebugText = null;
      const ensureXRDebugLabel = ()=>{
        if (!XR_DEBUG || xrDebugLabel) return;
        try{
          xrDebugLabel = document.createElement('div');
          xrDebugLabel.style.position = 'fixed';
          xrDebugLabel.style.left = '12px';
          xrDebugLabel.style.bottom = '12px';
          xrDebugLabel.style.maxWidth = '50vw';
          xrDebugLabel.style.fontSize = '12px';
          xrDebugLabel.style.fontFamily = 'monospace';
          xrDebugLabel.style.background = 'rgba(0,0,0,0.65)';
          xrDebugLabel.style.color = '#9cf';
          xrDebugLabel.style.padding = '6px 8px';
          xrDebugLabel.style.borderRadius = '6px';
          xrDebugLabel.style.pointerEvents = 'none';
          xrDebugLabel.style.whiteSpace = 'pre';
          xrDebugLabel.style.zIndex = '10000';
          document.body.appendChild(xrDebugLabel);
        }catch{}
      };
      const updateXRDebug = (msg)=>{
        if (!XR_DEBUG) return;
        try{
          ensureXRDebugLabel();
          const text = msg || '';
          if (xrDebugLabel) xrDebugLabel.textContent = text;
          if (text !== lastXRDebugText){
            lastXRDebugText = text;
            XRDebugLog(text);
          }
        }catch{}
      };
      xr = await scene.createDefaultXRExperienceAsync({ uiOptions:{sessionMode:"immersive-vr", referenceSpaceType:xrRef }, optionalFeatures:true });
      // Avoid remote hand mesh fetches in constrained networks, and ensure pointer selection exists
      try{
        const fm = xr?.baseExperience?.featuresManager;
        // Hands without meshes
        fm?.enableFeature?.('hand-tracking','latest',{ xrInput: xr?.baseExperience?.input, jointMeshes:false, doNotLoadHandMesh:true });
        // Ensure pointer selection is present so controller rays generate scene picks reliably
        fm?.enableFeature?.('pointer-selection','latest',{
          xrInput: xr?.baseExperience?.input,
          enablePointerSelectionOnAllControllers: true,
          forceControllerProfile: undefined,
          maxPointerDistance: DOME_DIAMETER,
        });
      }catch{}
      // Fallback: manual ray from controllers + trigger
      try{
        const input = xr?.baseExperience?.input;
        const lasers = new Map();
        let lastGazeHover = null; let gazeSince = 0; const GAZE_DWELL_MS = 1100;
        input?.onControllerAddedObservable?.add((source)=>{
          try{
            const ptr = source?.pointer; if (!ptr) return;
            const len = DOME_DIAMETER*0.9;
            const laser = MeshBuilder.CreateBox("laser_"+(lasers.size+1), { height:0.01, width:0.01, depth: len }, scene);
            const lm = new StandardMaterial("laserMat", scene); lm.disableLighting=true; lm.emissiveColor=new Color3(0.95,0.8,0.2); lm.backFaceCulling=false;
            laser.material=lm; laser.isPickable=false; laser.parent=ptr; laser.position.z = len/2; laser.layerMask = 0x1;
            lasers.set(source, { laser, pointer: ptr, hit: null, distance: null });
            source.onMotionControllerInitObservable.add((mc)=>{
              try{
                const attachComponent = (comp)=>{
                  try{
                    comp?.onButtonStateChangedObservable?.add((c)=>{
                      if (c.pressed){
                        try{
                          const res = makeHotspotRayFromPointer(ptr, source);
                          const toId = res?.hit?.pickedMesh?.metadata?.to;
                          if (toId && nodesById.has(toId)) goTo(toId, { source: 'user', broadcast: true });
                          if (XR_DEBUG){
                            updateXRDebug(`[select] ${source.uniqueId} -> ${toId || 'none'}`);
                          }
                        }catch{}
                      }
                    });
                  }catch{}
                };
                const main = mc?.getMainComponent?.();
                if (main) attachComponent(main);
                const componentIds = ['xr-standard-trigger','trigger','xr-standard-select','primary-button','a-button','xr-standard-squeeze','xr-standard-thumbstick'];
                for (const id of componentIds){
                  const comp = mc?.getComponent?.(id);
                  if (comp && comp !== main){
                    attachComponent(comp);
                    break;
                  }
                }
              }catch{}
            });
          }catch{}
        });
        input?.onControllerRemovedObservable?.add((source)=>{
          try{
            const info = lasers.get(source);
            info?.laser?.dispose?.();
            lasers.delete(source);
          }catch{}
        });
        // XR hover highlighting using controller pointer; also provide gaze fallback when no controllers are present
        scene.onBeforeRenderObservable.add(()=>{
          try{
            let hoverMeta = null;
            let debugLines = [];

            if (inXR && lasers.size){
              let closest = Infinity;
              for (const [controller, info] of lasers.entries()){
                const res = makeHotspotRayFromPointer(info?.pointer, controller);
                const hit = res?.hit;
                info.hit = hit;
                info.distance = hit?.distance ?? null;
                if (hit?.hit && hit.distance < closest){
                  closest = hit.distance;
                  hoverMeta = hit.pickedMesh?.metadata?.hotspot ? hit.pickedMesh.metadata : null;
                }
                if (XR_DEBUG){
                  const label = controller?.inputSource?.handedness || controller?.uniqueId || `controller${debugLines.length+1}`;
                  if (hit?.hit){
                    const meta = hit.pickedMesh?.metadata;
                    debugLines.push(`${label}: hit d=${hit.distance.toFixed(1)} to=${meta?.to || 'n/a'}`);
                  } else {
                    debugLines.push(`${label}: no hit`);
                  }
                }
              }
            } else if (inXR) {
              // No controllers detected: treat XR camera forward as a gaze ray
              const xrcam = xr?.baseExperience?.camera;
              const pred = (m)=>m?.metadata?.hotspot===true;
              if (xrcam && typeof xrcam.getForwardRay === 'function'){
                const ray = xrcam.getForwardRay(DOME_DIAMETER);
                const hit = scene.pickWithRay(ray, pred, false, null, xrcam);
                if (hit?.hit){ hoverMeta = hit.pickedMesh?.metadata?.hotspot ? hit.pickedMesh.metadata : null; }
                if (XR_DEBUG){ debugLines.push('gaze: ' + (hoverMeta ? `hit -> ${hoverMeta.to}` : 'no hit')); }
              }
            } else {
              if (XR_DEBUG) updateXRDebug('not in XR');
            }

            // Apply hover (used by both controller and gaze)
            updateHotspotHover(hoverMeta);

            // Gaze dwell-to-select fallback
            if (inXR && !lasers.size){
              const now = performance.now();
              if (hoverMeta && hoverMeta === lastGazeHover){
                if (!gazeSince) gazeSince = now;
                const elapsed = now - gazeSince;
                if (elapsed > GAZE_DWELL_MS){
                  try{ const toId = hoverMeta.to; if (toId && nodesById.has(toId)) goTo(toId, { source: 'user', broadcast: true }); }catch{}
                  gazeSince = 0; lastGazeHover = null;
                }
                if (XR_DEBUG){ debugLines.push(`gaze dwell: ${Math.round(Math.min(elapsed,GAZE_DWELL_MS))}/${GAZE_DWELL_MS}ms`); }
              } else {
                // reset timer when gaze target changes
                lastGazeHover = hoverMeta || null; gazeSince = hoverMeta ? performance.now() : 0;
              }
            }

            if (XR_DEBUG && debugLines.length){
              updateXRDebug(debugLines.join("\n"));
            }
          }catch{}
        });
      }catch{}
      xr?.baseExperience?.onStateChangedObservable?.add(s=>{
        inXR = (s === WebXRState.IN_XR);
        try{
          if (inXR){
            try{ document.body.setAttribute('data-xr','1'); }catch{}
            prevHSL = engine.getHardwareScalingLevel?.() ?? null;
            engine.setHardwareScalingLevel(1.0);
            try{ unlockAudio(); }catch{}
            // Ensure XR camera renders only main layer (exclude mirror layer 0x2)
            try{ const xrcam = xr?.baseExperience?.camera; if (xrcam) xrcam.layerMask = 0x1; }catch{}
            // Disable mirror grid cameras to avoid any overlay conflicts inside XR
            mirrorVisible = false; updateMirrorLayout();
            // Hide 2D domes and mirror while in XR
            try{ dome.setEnabled(false); dome.isVisible = false; }catch{}
            try{ crossDome.setEnabled(false); crossDome.isVisible = false; }catch{}
            try{ mirrorDome.setEnabled(false); mirrorDome.isVisible = false; }catch{}
            // Load current pano into VR PhotoDome and attach XR hotspots
            const cur = nodesById?.get?.(currentNodeId);
            if (cur && cur.file){
              setVrPano(cur.file).catch(()=>{});
              attachXRHotspotsToCurrentDome();
              buildHotspotsFor(cur, /*forXR*/ true);
            }
          } else {
            try{ document.body.removeAttribute('data-xr'); }catch{}
            if (prevHSL != null){ engine.setHardwareScalingLevel(prevHSL); }
            // Restore 2D domes and mirror; hide VR domes
            try{ dome.setEnabled(true); dome.isVisible = true; }catch{}
            try{ crossDome.setEnabled(false); crossDome.isVisible = false; }catch{}
            try{ mirrorDome.setEnabled(true); mirrorDome.isVisible = true; }catch{}
            try{ vrDomes.forEach(d=>{ if (d?.mesh){ d.mesh.isVisible = false; d.mesh.setEnabled(false); } }); }catch{}
            // Re-enable mirror grid if it was visible before
            mirrorVisible = true; updateMirrorLayout();
            const cur = nodesById?.get?.(currentNodeId);
            if (cur && cur.file){
              showFile(cur.file).catch?.(()=>{});
              buildHotspotsFor(cur, /*forXR*/ false);
            }
          }
        }catch{}
      });
      try { addEventListener('ui:exit', async ()=>{ try{ await xr?.baseExperience?.exitXRAsync?.(); }catch{} }); } catch {}
      // Also respond to XR pointer selection events (in case controller trigger observable is unavailable)
      try{
        const ps = xr?.pointerSelection;
        if (ps){
          // Restrict built-in XR selection to our hotspots only
          try { ps.raySelectionPredicate = (m)=>!!(m?.metadata?.hotspot===true); } catch {}
          ps.onSelectionObservable?.add((evt)=>{
            try{
              const picked = evt?.pickInfo;
              const toId = picked?.pickedMesh?.metadata?.to;
              if (toId && nodesById.has(toId)) goTo(toId, { source: 'user', broadcast: true });
            }catch{}
          });
        }
        // Fallback: session 'select' events (covers emulators / limited runtimes)
        try{
          const session = xr?.baseExperience?.sessionManager?.session;
          if (session && !session.__agentSelectHooked){
            session.__agentSelectHooked = true;
            const handler = ()=>{
              try{
                const xrcam = xr?.baseExperience?.camera;
                const pred = (m)=>m?.metadata?.hotspot===true;
                const ray = xrcam?.getForwardRay ? xrcam.getForwardRay(DOME_DIAMETER) : null;
                const hit = ray ? scene.pickWithRay(ray, pred, false, null, xrcam) : null;
                const toId = hit?.pickedMesh?.metadata?.to;
                if (toId && nodesById.has(toId)) goTo(toId, { source: 'user', broadcast: true });
              }catch{}
            };
            session.addEventListener('select', handler);
          }
        }catch{}
      }catch{}
    }
  }catch{}

  // Defensive guard: keep 2D domes disabled while in XR sessions
  scene.onBeforeRenderObservable.add(()=>{
    try{
      if (!inXR) return;
      if (dome?.isEnabled()) dome.setEnabled(false);
      if (crossDome?.isEnabled()) crossDome.setEnabled(false);
      if (mirrorDome?.isEnabled()) mirrorDome.setEnabled(false);
    }catch{}
  });

  /* boot */
  const start = nodesById.get(startNodeId);
  await showFile(start.file);
  worldRoot.position.copyFrom(nodeWorldPos(start));
  worldYaw = Number.isFinite(start?.yaw) ? -rad(start.yaw) : 0;
  worldRoot.rotation.y = worldYaw;
  cam.rotation.y = 0;
  cam.rotation.x = 0;
  setCamPitch(0);
  buildHotspotsFor(start, /*forXR*/ false);
  await setMirrorNode(start.id);
  updateMirrorLayout();
  sendSync(start.id);

  const api = {
    nudgeYaw:  d=>{ cam.rotation.y += (d||0); sendSync(currentNodeId); },
    nudgePitch:d=>{ const clamp=Math.PI*70/180; const nx=Math.max(-clamp,Math.min(clamp,cam.rotation.x + (d||0))); cam.rotation.x = nx; sendSync(currentNodeId); },
    adjustFov: d=>{ const MIN_FOV=0.45, MAX_FOV=1.7; cam.fov=Math.max(MIN_FOV,Math.min(MAX_FOV, cam.fov + (d||0))); },
    toggleMirror: ()=>{ mirrorVisible=!mirrorVisible; if (!mirrorVisible) cam.viewport=new Viewport(0,0,1,1); updateMirrorLayout(); },
    switchView: ()=>{ mirrorPrimary = !mirrorPrimary; updateMirrorLayout(); },
    toggleMinimap: ()=>{ const wrap=document.querySelector('.mini-wrap'); if(wrap){ const show=wrap.style.display==='none'; wrap.style.display= show? '' : 'none'; } },
    toggleXR: async ()=>{ if (!xr?.baseExperience) return; try{ const inx = (xr.baseExperience.state===WebXRState.IN_XR); if (inx) { await xr.baseExperience.exitXRAsync?.(); } else { await xr.baseExperience.enterXRAsync?.("immersive-vr", "local-floor"); } }catch{} },
    switchExperience: async (newExp)=>{
      if (!newExp) return;
      const normalized = String(newExp).trim();
      const pack = await loadExperiencePackage(normalized);
      if (!pack) return;
      if (pack.base === BASE && nodesById.has(pack.startNodeId || pack.data?.startNodeId || '')) return;
      const nextFlip = resolveFlipConfig(normalized);
      const flipXChanged = nextFlip.flipX !== flipX;
      flipU = nextFlip.flipU;
      flipX = nextFlip.flipX;
      if (flipXChanged){
        dome.rotation.x = flipX ? Math.PI : 0;
        crossDome.rotation.x = flipX ? Math.PI : 0;
        mirrorDome.rotation.x = flipX ? Math.PI : 0;
      }
      BASE = pack.base;
      PANOS_DIR = "panos";
      try{ for (const [k,tex] of texCache.entries()){ try{ tex?.dispose?.(); }catch{} } texCache.clear(); }catch{}
      data = pack.data;
      nodesById = pack.nodesById;
      startNodeId = pack.data?.startNodeId ?? pack.startNodeId ?? startNodeId;
      rememberExperience(normalized, pack);
      await maybeSelectMobilePanoDir();
      rebuildFloorMaps();
      const node = nodesById.get(startNodeId) || (nodesById.size?nodesById.values().next().value:null); if (!node) return;
      currentNodeId = node.id;
      await showFile(node.file);
      worldRoot.position.copyFrom(nodeWorldPos(node));
      worldYaw = Number.isFinite(node?.yaw) ? -rad(node.yaw) : worldYaw;
      worldRoot.rotation.y = worldYaw;
      cam.rotation.y = 0;
      cam.rotation.x = 0;
      setCamPitch(0);
      buildHotspotsFor(node);
      await setMirrorNode(node.id);
      rebuildMinimap(); updateMirrorLayout(); sendSync(node.id);
      try{ dispatchEvent(new CustomEvent('agent:experience', { detail: { expId: normalized, nodeId: node.id } })); }catch{}
    },
    setMirrorPitchSign: (s)=>{ const n = Number(s); if (n===1 || n===-1){ MIRROR_PITCH_SIGN = n; } },
    toggleMirrorPitchSign: ()=>{ MIRROR_PITCH_SIGN *= -1; },
    setMirrorYawSign: (s)=>{ const n = Number(s); if (n===1 || n===-1){ MIRROR_YAW_SIGN = n; } },
    toggleMirrorYawSign: ()=>{ MIRROR_YAW_SIGN *= -1; },
    // Expose minimal navigation and data for AI assistant
    getContext: ()=>({
      exp: expName(),
      floors: data?.floors||[],
      zones: data?.zones||[],
      nodes: data?.nodes?.map(n=>({ id:n.id, floorId:n.floorId, zoneId:n.zoneId }))||[],
      currentNodeId
    }),
    getExperienceData: async (expId)=>{
      const target = String(expId || expName()).trim();
      if (!target || target === expName()){
        return cloneExperienceData({ data, expId: expName(), startNodeId });
      }
      const pack = await loadExperiencePackage(target);
      if (!pack) return null;
      return cloneExperienceData(pack);
    },
    goToNode: (id, options)=>goTo(id, {
      source: (options && typeof options === 'object' && options.source) ? options.source : 'user',
      broadcast: options?.broadcast,
      sync: options?.sync,
    }),
    goToZoneByName: (name, options={})=>{
      if (!name) return Promise.resolve();
      const list=(data?.zones||[]).map(z=>({ id:z.id, name:String(z.name||z.id).toLowerCase().trim() }));
      const q=String(name).toLowerCase().trim();
      const hit = list.find(z=>z.name===q) || list.find(z=>z.name.includes(q));
      if (!hit) return Promise.resolve();
      // Choose rep node or first node within that zone on current floor, else any
      const cand = (data?.nodes||[]).find(n=>n.zoneId===hit.id && n.floorId===nodesById.get(currentNodeId)?.floorId) ||
                   (data?.nodes||[]).find(n=>n.zoneId===hit.id) || null;
      if (cand) return goTo(cand.id, {
        source: (options && typeof options === 'object' && options.source) ? options.source : 'user',
        broadcast: options?.broadcast,
        sync: options?.sync,
      });
      return Promise.resolve();
    },
    goToNextInZone: ()=>{
      const cur = nodesById.get(currentNodeId); if(!cur||!cur.zoneId) return Promise.resolve();
      const list=(data?.nodes||[]).filter(n=>n.zoneId===cur.zoneId);
      if (!list.length) return Promise.resolve();
      const i = Math.max(0, list.findIndex(n=>n.id===cur.id));
      const next = list[(i+1)%list.length];
      return goTo(next.id,{ source:'user', broadcast:true });
    },
    goToPrevInZone: ()=>{
      const cur = nodesById.get(currentNodeId); if(!cur||!cur.zoneId) return Promise.resolve();
      const list=(data?.nodes||[]).filter(n=>n.zoneId===cur.zoneId);
      if (!list.length) return Promise.resolve();
      const i = Math.max(0, list.findIndex(n=>n.id===cur.id));
      const prev = list[(i-1+list.length)%list.length];
      return goTo(prev.id,{ source:'user', broadcast:true });
    }
  };

  try{
    if (typeof window !== "undefined"){
      window.__xrDebug = {
        xrHotspots: ()=>({
          xr: hotspotRootXR?.getChildren?.()?.length ?? 0,
          dom: hotspotRoot?.getChildren?.()?.length ?? 0
        }),
        xrControllers: ()=>Array.from(xr?.baseExperience?.input?.controllers || []).map(c=>({
          id: c?.uniqueId,
          handedness: c?.inputSource?.handedness,
          hasMotionController: !!c?.motionController
        })),
        xrHotspotMeshes: ()=>(hotspotRootXR?.getChildren?.() || []).map(m=>({
          name: m?.name,
          meta: m?.metadata,
          children: m?.getChildMeshes?.()?.map(ch=>({ name: ch?.name, meta: ch?.metadata })) || []
        })),
        xrState: ()=>({ inXR, controllers: Array.from(xr?.baseExperience?.input?.controllers || []).length }),
        currentNode: ()=>{
          const n = nodesById.get(currentNodeId);
          return n ? { id: n.id, hotspots: Array.isArray(n.hotspots)? n.hotspots.map(h=>({ to:h?.to, yaw:h?.yaw, pitch:h?.pitch })) : [] } : null;
        }
      };
    }
  }catch{}

  engine.runRenderLoop(()=>scene.render());
  window.addEventListener("resize", ()=>{ engine.resize(); updateMirrorLayout(); });
  return api;
}

