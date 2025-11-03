// agent.js — Agent with multi-viewer mirror grid (bottom-right), camera-driven look
// 2D stays mono (cropped if the source is TB). XR uses true TB stereo via PhotoDome.

import {
  Engine, Scene, FreeCamera, WebXRState, Vector3, MeshBuilder, Mesh, Color4,
  StandardMaterial, Texture, Material, TransformNode, Color3, PointerEventTypes, Viewport, Ray
} from "@babylonjs/core";
import "@babylonjs/loaders";
import { PhotoDome } from "@babylonjs/core/Helpers/photoDome";
import { loadWalkthrough, buildMinimapDOM } from "./walkthrough-loader.js";

/* logs */
function LOG(){ try{ console.log.apply(console, arguments); }catch{} }
function stamp(){ return new Date().toISOString().split("T")[1].slice(0,12); }
function A(tag, obj){ LOG("[AGENT]", stamp(), tag, obj||""); }

/* constants */
const FLIP_U = true, FLIP_X = true;
const DOME_DIAMETER = 2000, FLOOR_HEIGHT_M = 3.0;
const NAV_DUR_MS = 550, NAV_PUSH_M = 3.0;
let MIRROR_YAW_SIGN = 1;
let MIRROR_PITCH_SIGN = 1; // 1 for same direction, -1 to invert if needed

/* env */
let BASE_URL = (import.meta?.env?.BASE_URL ?? "/");
function toWs(url){ try{ if(!url) return null; const s=String(url); return s.replace(/^http(s?):/i, 'ws$1:'); }catch{ return url; } }
const WS_PRIMARY = toWs(import.meta?.env?.VITE_WS_URL || "wss://vrsync.dev.opensky.co.in/");
const WS_FALLBACK = toWs(import.meta?.env?.VITE_WS_URL_SECONDARY || import.meta?.env?.VITE_WS_FALLBACK || "https://22abcd9c-f607-41d5-9109-203a6cf0b79e-00-3nw6aihj3adm4.sisko.replit.dev/");
function expandWs(u){ if(!u) return []; try{ const url=new URL(u); const list=[u]; const hasPath=url.pathname && url.pathname!=='/' && url.pathname!==''; if(!hasPath){ list.push((u.endsWith('/')?u.slice(0,-1):u)+"/ws"); } return list; }catch{ return [u]; } }

// WebP support
const SUPPORTS_WEBP = (() => { try { const c = document.createElement('canvas'); return c.toDataURL && c.toDataURL('image/webp').indexOf('image/webp') !== -1; } catch { return false; } })();
const chooseFile = (f) => SUPPORTS_WEBP ? f : f.replace(/\.webp$/i, '.jpg');

const rad = d => d*Math.PI/180;
const v3arr = v => [v.x,v.y,v.z];
const expNameFrom = base => { const p=base.split("/").filter(Boolean); return p[p.length-1]||"amenities"; };
const UA = (navigator.userAgent || "").toLowerCase();
const IS_IOS = /iphone|ipad|ipod|ios/.test(UA);
const IS_ANDROID = /android/.test(UA);
const IS_MOBILE = IS_IOS || IS_ANDROID || /mobile/.test(UA);

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

  let BASE = (BASE_URL + "experiences/" + exp).replace(/\/{2,}/g,"/");
  let PANOS_DIR = "panos";
  const expName  = () => expNameFrom(BASE);
  const isStereo = () => Boolean(metaById.get(expName())?.stereo);
  const panoPath = (dir, file) => (BASE + "/" + dir + "/" + chooseFile(file)).replace(/\/{2,}/g,"/");
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
    // Force HQ on request; otherwise cap to 2x for perf
    function determineDpr(){
      const qs = new URLSearchParams(location.search);
      const forceHQ = (qs.get('hq') === '1') || (String(import.meta?.env?.VITE_FORCE_HQ||'')==='1') || ((qs.get('q')||'').toLowerCase()==='high');
      const dpr = Math.max(1, window.devicePixelRatio || 1);
      const cap = forceHQ ? 3 : 2;
      const target = Math.min(cap, dpr);
      return IS_IOS ? Math.min(1.2, target) : target;
    }
    engine.setHardwareScalingLevel(1 / determineDpr());
  }catch{}

  function getQuality(){
    try{
      if (IS_IOS) return { mips:false, sampling:Texture.BILINEAR_SAMPLINGMODE, aniso:1 };
      const qs = new URLSearchParams(location.search);
      const override = (qs.get('q') || import.meta?.env?.VITE_QUALITY || 'auto').toLowerCase();
      if (override==='high') return { mips:true, sampling:Texture.TRILINEAR_SAMPLINGMODE, aniso:8 };
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

  const cam = new FreeCamera("cam", new Vector3(0,0,0), scene);
  cam.attachControl(canvas, true);
  cam.inputs.clear();
  cam.fov=1.1; cam.minZ=0.1; cam.maxZ=50000; cam.layerMask=0x1;
  scene.activeCamera = cam;

  /* data */
  try{ window.dispatchEvent(new CustomEvent('loading:show', { detail:{ label: 'Loading tour…' } })); }catch{}
  let { data, nodesById, startNodeId } = await loadWalkthrough((BASE + "/walkthrough.json").replace(/\/{2,}/g,"/"));
  try{ window.dispatchEvent(new CustomEvent('loading:hide')); }catch{}
  let currentNodeId = startNodeId;

  async function maybeSelectMobilePanoDir(){
    const node = nodesById.get(startNodeId) || (nodesById.size ? nodesById.values().next().value : null);
    const file = node?.file;
    if (!file) return;
    const caps = engine.getCaps?.() || {};
    const maxTexture = Number(caps.maxTextureSize) || 0;
    const dpr = Math.max(1, window.devicePixelRatio || 1);
    const needsMobile = IS_IOS || maxTexture <= 8192 || (IS_ANDROID && dpr >= 2.5);
    if (!needsMobile) return;
    const candidates = [];
    if (IS_IOS || maxTexture <= 7168) candidates.push("panos-mobile-6k");
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
  dome.parent=worldRoot; if(FLIP_X) dome.rotation.x=Math.PI; dome.layerMask=0x1; dome.isPickable=false;
  const domeMat=new StandardMaterial("panoMat",scene);
  domeMat.disableLighting=true; domeMat.backFaceCulling=false;
  domeMat.transparencyMode=Material.MATERIAL_ALPHABLEND; domeMat.disableDepthWrite=true;
  dome.material=domeMat; dome.renderingGroupId=0;

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
  function makeTexture(file){ const q=getQuality(); const tex = new Texture(panoUrl(file), scene, !q.mips, false, q.sampling); try{ tex.anisotropicFilteringLevel=q.aniso; }catch{} return tex; }
  function getTexture(file){
    const key=BASE+"|"+file;
    if (texCache.has(key)) { touchLRU(key); return Promise.resolve(texCache.get(key)); }
    if (inFlight.has(key)) return inFlight.get(key);
    const tex=makeTexture(file);
    const p=new Promise(res=>{ if (tex.isReady()){ texCache.set(key,tex); evictIfNeeded(key); return res(tex); } tex.onLoadObservable.addOnce(()=>{ texCache.set(key,tex); evictIfNeeded(key); res(tex); }); });
    inFlight.set(key,p); p.finally(()=>inFlight.delete(key));
    return p;
  }
  let lastMainFile = null;
  async function showFile(file){
    // DON'T show loading overlay - causes black screens
    const tex = await getTexture(file);
    // CORRECT: In 2D, CROP stereo (bottom half only for mono view)
    mapFor2D(tex, /*stereo*/ isStereo(), FLIP_U);
    domeMat.emissiveTexture = tex;
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
  const hotspotRoot = new TransformNode("hotspots", scene); hotspotRoot.parent=dome; hotspotRoot.layerMask=0x1;
  const hotspotRootXR = new TransformNode("hotspotsXR", scene); hotspotRootXR.layerMask=0x1;
  function vecFromYawPitch(yawDeg,pitchDeg,R,flipY=false){ const y=rad(yawDeg), p=rad(pitchDeg||0), cp=Math.cos(p), sp=Math.sin(p); const ySign = flipY ? -1 : 1; return new Vector3(R*Math.cos(y)*cp, ySign*R*sp, -R*Math.sin(y)*cp); }
  function clearHotspots(){ try{ hotspotRoot.getChildren().forEach(n=>n.dispose()); }catch{} try{ hotspotRootXR.getChildren().forEach(n=>n.dispose()); }catch{} }
  function buildHotspotsInRoot(node, parentRoot, flipXLocal=false, isXR=false){
    if (!node?.hotspots) return;
    const R = (DOME_DIAMETER/2) * 0.98;
    for (const h of node.hotspots){
      const toId = h?.to; if (!toId || !nodesById.has(toId)) continue;
      const root=new TransformNode("hs-"+(toId||""),scene); root.parent=parentRoot||hotspotRoot; root.layerMask=0x1; root.metadata={ hotspot:true, to:toId };
      const ring=MeshBuilder.CreateDisc("hsRing",{radius:20,tessellation:48,sideOrientation:Mesh.DOUBLESIDE},scene);
      const dot =MeshBuilder.CreateDisc("hsDot",{radius:10,tessellation:32,sideOrientation:Mesh.DOUBLESIDE},scene);
      const rm=new StandardMaterial("hsRingMat",scene); rm.disableLighting=true; rm.emissiveColor=new Color3(1,1,1);
      const dm=new StandardMaterial("hsDotMat",scene);  dm.disableLighting=true; dm.emissiveColor=new Color3(1,0.62,0.18);
      ring.material=rm; dot.material=dm; ring.parent=root; dot.parent=root;
      ring.billboardMode=Mesh.BILLBOARDMODE_ALL; dot.billboardMode=Mesh.BILLBOARDMODE_ALL;
      ring.isPickable=false; dot.isPickable=false;
      const pick=MeshBuilder.CreateSphere("hsPick",{diameter:120,segments:8},scene);
      const pm=new StandardMaterial("hsPickMat",scene); pm.alpha=0.001; pm.disableLighting=true; pm.backFaceCulling=false;
      pick.material=pm; pick.parent=root; pick.isPickable=true; pick.metadata={ hotspot:true, to:toId };
      // FIX: When dome is flipped (FLIP_X), invert Y coordinate for hotspots
      const v = vecFromYawPitch(h.yaw||0, h.pitch||0, R, flipXLocal);
      root.position.copyFrom(v);
      try{ root.lookAt(Vector3.Zero()); }catch{}
    }
  }
  function buildHotspotsFor(node){ clearHotspots(); buildHotspotsInRoot(node, hotspotRoot, /*flipXLocal*/ FLIP_X, /*isXR*/ false); }

  // 2D pick
  scene.onPointerObservable.add(poi=>{
    if (poi.type!==PointerEventTypes.POINTERUP) return;
    const pick=scene.pick(scene.pointerX,scene.pointerY,m=>m?.metadata?.hotspot===true,false,cam);
    const toId=pick?.pickedMesh?.metadata?.to;
    if (toId && nodesById.has(toId)) goTo(toId, true);
  });

  /* minimap */
  let mini=null;
  function rebuildMinimap(){
    document.querySelectorAll(".mini-wrap").forEach(el=>el.remove());
    const padByFloor = new Map(data.floors.map(f=>[f.id,{x:0,y:0}]));
    // Coordinate reference per floor: auto-detect from zones (preferred) or nodes
    const coordByFloor = new Map(); // fid -> { w, h }
    const originByFloor = new Map(); // fid -> { x, y }

    // Zones support: build one marker per zone (centroid of polygon), fallback to nodes when zones absent
    const hasZones = Array.isArray(data?.zones) && data.zones.length > 0;
    const zonesByFloor = new Map(); // fid -> [{id,x,y}]
    const zoneRep = new Map();      // zoneId -> representative nodeId
    if (hasZones){
      const centroid = (pts)=>{
        if (!Array.isArray(pts) || pts.length === 0) return { x: 0, y: 0 };
        let sx=0, sy=0; for (const p of pts){ sx += Number(p?.x)||0; sy += Number(p?.y)||0; }
        return { x: sx/pts.length, y: sy/pts.length };
      };
      // Detect coordinate extents (max X/Y) per floor from zone polygons
      const extents = new Map(); // fid -> { minX, minY, maxX, maxY }
      for (const z of (data.zones||[])){
        const c = centroid(z.points || []);
        if (!zonesByFloor.has(z.floorId)) zonesByFloor.set(z.floorId, []);
        zonesByFloor.get(z.floorId).push({ id: z.id, x: c.x, y: c.y, label: (typeof z.name==='string'? z.name : z.id) });
        // track max extents
        const arr = Array.isArray(z.points) ? z.points : [];
        let e = extents.get(z.floorId) || { minX:Infinity, minY:Infinity, maxX:0, maxY:0 };
        for (const p of arr){ const px = Number(p?.x)||0, py = Number(p?.y)||0; if (px>e.maxX) e.maxX=px; if (py>e.maxY) e.maxY=py; if (px<e.minX) e.minX=px; if (py<e.minY) e.minY=py; }
        extents.set(z.floorId, e);
        let rep = (typeof z.repNodeId === 'string' && nodesById.has(z.repNodeId)) ? z.repNodeId : null;
        if (!rep){ const found = (data.nodes || []).find(n => n.zoneId === z.id); rep = found?.id || null; }
        if (!rep){ rep = startNodeId || (nodesById.size? nodesById.values().next().value?.id : null); }
        if (rep) zoneRep.set(z.id, rep);
      }
      // Write coord reference from detected extents (fallback to image size if too small)
      for (const f of data.floors){ const e = extents.get(f.id); if (e){
        const w = Math.max((Number(e.maxX)||0) - (isFinite(e.minX)?Number(e.minX):0), Number(f.width||0)||0);
        const h = Math.max((Number(e.maxY)||0) - (isFinite(e.minY)?Number(e.minY):0), Number(f.height||0)||0);
        if (isFinite(e.minX) && isFinite(e.minY)) originByFloor.set(f.id, { x: e.minX, y: e.minY });
        if (w>0 && h>0) coordByFloor.set(f.id, { w, h });
      } }
    }

    mini = buildMinimapDOM({
      floors:data.floors, basePath:BASE, padByFloor, coordsMode: "auto", ui:"dropdown",
      panelWidth:"clamp(160px, min(44vw, 42vh), 280px)", position:"top-right", paddingPx:12,
      coordByFloor,
      originByFloor,
      onSelectNode:id=>{
        if(!id) return;
        if (hasZones && zoneRep.has(id)) { goTo(zoneRep.get(id), true); }
        else { goTo(id, true); }
      },
      onFloorChange:fid=>{
        if (hasZones){
          const activeZone = nodesById.get(currentNodeId)?.zoneId || null;
          const list = zonesByFloor.get(fid) || [];
          mini.renderPoints(list, activeZone);
        } else {
          const list=data.nodes.filter(x=>x.floorId===fid);
          mini.renderPoints(list,currentNodeId);
        }
      }
    });
    const cur = nodesById.get(currentNodeId) || nodesById.get(startNodeId) || (nodesById.size?nodesById.values().next().value:null);
    if (cur){
      mini.setActiveFloor(cur.floorId,true,true);
      if (hasZones){
        const list = zonesByFloor.get(cur.floorId) || [];
        const active = nodesById.get(currentNodeId)?.zoneId || null;
        mini.renderPoints(list, active);
      } else {
        mini.renderPoints(data.nodes.filter(x=>x.floorId===cur.floorId), currentNodeId);
      }
    }
  }
  rebuildMinimap();

  /* move then swap */
  function easeOutCubic(t){ return 1-Math.pow(1-t,3); }
  function forwardPushThenSwap(nextNode, dur=NAV_DUR_MS, push=NAV_PUSH_M){
    const startPos=worldRoot.position.clone();
    const yawW=cam.rotation.y;
    const fwd=new Vector3(-Math.sin(yawW),0,-Math.cos(yawW)).scale(push);
    const t0=performance.now();
    const pre = getTexture(nextNode.file);
    return new Promise(res=>{ const ob=scene.onBeforeRenderObservable.add(()=>{ const t=Math.min(1,(performance.now()-t0)/dur), e=easeOutCubic(t); worldRoot.position.copyFrom(startPos.add(fwd.scale(e))); if(t>=1){ scene.onBeforeRenderObservable.remove(ob); res(); } }); }).then(()=>pre).then(async ()=>{ await showFile(nextNode.file); worldRoot.position.copyFrom(nodeWorldPos(nextNode)); buildHotspotsFor(nextNode); });
  }
  let navLock=false;
  function goTo(targetId, broadcast){
    if (navLock) return Promise.resolve();
    if (!(targetId && targetId!==currentNodeId)) return Promise.resolve();
    const node=nodesById.get(targetId); if(!node) return Promise.resolve();
    navLock=true; currentNodeId=node.id;
    try { dispatchEvent(new CustomEvent('agent:navigate', { detail: { nodeId: currentNodeId, source: (broadcast?'user':'program') } })); } catch {}
    const fid=node.floorId; mini?.setActiveFloor(fid,true,true);
    // Render one marker per zone when zones are present
    const hasZones = Array.isArray(data?.zones) && data.zones.length > 0;
    if (hasZones){
      // Recompute simple centroid list on-demand for current floor (cheap and avoids stale closure)
      const centroid = (pts)=>{ if(!pts?.length) return {x:0,y:0}; let sx=0,sy=0; for(const p of pts){ sx+=Number(p?.x)||0; sy+=Number(p?.y)||0; } return {x:sx/pts.length,y:sy/pts.length}; };
      const list = (data.zones||[]).filter(z=>z.floorId===fid).map(z=>{ const c=centroid(z.points||[]); return { id:z.id, x:c.x, y:c.y, label:(typeof z.name==='string'? z.name : z.id) }; });
      const active = node.zoneId || null;
      mini?.renderPoints(list, active);
    } else {
      mini?.renderPoints(data.nodes.filter(x=>x.floorId===fid), node.id);
    }
    return forwardPushThenSwap(node).then(()=>{ if (broadcast===true) sendSync(currentNodeId); }).finally(()=>{ navLock=false; });
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
  if(FLIP_X) mirrorDome.rotation.x=Math.PI; mirrorDome.layerMask=0x2; mirrorDome.isPickable=false;
  const mirrorMat = new StandardMaterial("mirrorMat",scene);
  mirrorMat.disableLighting=true; mirrorMat.backFaceCulling=false;
  mirrorMat.transparencyMode=Material.MATERIAL_ALPHABLEND; mirrorMat.disableDepthWrite=true;
  mirrorDome.material = mirrorMat;

  let mirrorNodeId=null, mirrorTexKey=null;
  async function setMirrorNode(id){ if (!id || id===mirrorNodeId || !nodesById.has(id)) return; const file = nodesById.get(id).file, key = BASE + "|" + file; if (mirrorTexKey === key) { mirrorNodeId = id; return; } const tex = await getTexture(file); mirrorMat.emissiveTexture = tex; mapFor2D(tex, /*stereo*/ isStereo(), FLIP_U); mirrorTexKey = key; mirrorNodeId = id; try{ const keep = new Set([key]); retainOnly(keep); retainSW([panoUrl(file)]); }catch{} }

  /* WebSocket (guide + viewers) */
  let socket=null; let wsIndex=0; let wsLockedIdx=-1;
  function safeSend(o){ if (socket && socket.readyState===1){ try{ socket.send(JSON.stringify(o)); }catch{} } }
  function sendSync(nodeId){ if (!nodeId) return; const expPath = `experiences/${expName()}`; safeSend({ type:"sync", room:roomId, nodeId, exp:expName(), expPath, worldPos:v3arr(worldRoot.position) }); }
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
          mCam.fov=1.0; mCam.minZ=0.1; mCam.maxZ=50000; mCam.layerMask=0x2;
          viewers.set(msg.uid, { cam:mCam, root, nodeId:null, last: performance.now() });
          updateMirrorLayout();
        }
        const v = viewers.get(msg.uid); v.last = performance.now();
        if (msg.pose){
          const mode = (msg.pose && (msg.pose.mode||'')).toLowerCase();
          const xrFixPitch = (mode === 'xr') ? -1 : 1; // XR pitch sign may differ; flip so up = up
          const xrFixYaw   = (mode === 'xr') ? -1 : 1; // When texture is flipped, yaw sign differs
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

  /* camera drag */
  let dragging=false,lastX=0,lastY=0,cPitch=0;
  const yawSpeed=0.005, pitchSpeed=0.003, pitchClamp=rad(70);
  function setCamPitch(p){ cPitch=Math.max(-pitchClamp,Math.min(pitchClamp,p)); cam.rotation.x=cPitch; }
  canvas.style.cursor="grab";
  canvas.addEventListener("pointerdown",e=>{ dragging=true; lastX=e.clientX; lastY=e.clientY; try{canvas.setPointerCapture(e.pointerId);}catch{} canvas.style.cursor="grabbing"; },{passive:false});
  canvas.addEventListener("pointermove",e=>{ if(!dragging) return; const dx=e.clientX-lastX, dy=e.clientY-lastY; lastX=e.clientX; lastY=e.clientY; cam.rotation.y -= dx*yawSpeed; setCamPitch(cPitch - dy*pitchSpeed); sendSync(currentNodeId); },{passive:true});
  canvas.addEventListener("pointerup",()=>{ dragging=false; canvas.style.cursor="grab"; },{passive:true});
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
  function setVrStereoMode(d){ const mode = isStereo()? PhotoDome.MODE_TOPBOTTOM : PhotoDome.MODE_MONOSCOPIC; try{ if("stereoMode" in d) d.stereoMode=mode; }catch{} try{ if("imageMode" in d) d.imageMode=mode; }catch{} }
  function ensureVrDome(index){ if (vrDomes[index]) return vrDomes[index]; const domeVR = new PhotoDome("pd_"+index, panoUrl(nodesById?.get?.(currentNodeId)?.file || ""), { size:DOME_DIAMETER }, scene); domeVR.mesh.isVisible = false; domeVR.mesh.isPickable = false; domeVR.mesh.parent = worldRoot; vrDomes[index] = domeVR; return domeVR; }
  function attachXRHotspotsToCurrentDome(){ try{ const mesh = (vrDomes[activeVr]||vrDomes[0]||vrDomes[1])?.mesh || ensureVrDome(activeVr)?.mesh; if (mesh) hotspotRootXR.parent = mesh; }catch{} }
  async function setVrPano(file){ const idx = 1-activeVr; const d = ensureVrDome(idx); setVrStereoMode(d); await new Promise(res=>{ const tex = d?.photoTexture; if(!tex){ res(); return; } let done=false; const obs = tex.onLoadObservable.add(()=>{ done=true; try{ tex.onLoadObservable.remove(obs); }catch{} res(); }); try{ tex.updateURL(panoUrl(file)); }catch{ try{ tex.onLoadObservable.remove(obs); }catch{} res(); } setTimeout(()=>{ if(!done){ try{ tex.onLoadObservable.remove(obs); }catch{} res(); } }, 1200); }).then(()=>{ try{ if(d.photoTexture){ d.photoTexture.anisotropicFilteringLevel=8; } }catch{} }); d.mesh.isVisible=true; try{ const cur=vrDomes[activeVr]; if(cur) cur.mesh.isVisible=false; }catch{} activeVr=idx; attachXRHotspotsToCurrentDome(); try{ hotspotRoot.setEnabled(false); hotspotRootXR.setEnabled(true); }catch{} }
  try{
    if (navigator?.xr){
      const qs = new URLSearchParams(location.search); const xrRef = (qs.get('xrRef') || 'local-floor');
      xr = await scene.createDefaultXRExperienceAsync({ uiOptions:{sessionMode:"immersive-vr", referenceSpaceType:xrRef }, optionalFeatures:true });
      // Avoid remote hand mesh fetches in constrained networks
      try{ const fm = xr?.baseExperience?.featuresManager; fm?.enableFeature?.('hand-tracking','latest',{ xrInput: xr?.baseExperience?.input, jointMeshes:false, doNotLoadHandMesh:true }); }catch{}
      // Fallback: manual ray from controllers + trigger
      try{
        const input = xr?.baseExperience?.input;
        const lasers = new Map();
        input?.onControllerAddedObservable?.add((source)=>{
          try{
            const ptr = source?.pointer; if (!ptr) return;
            const len = DOME_DIAMETER*0.7;
            const laser = MeshBuilder.CreateBox("laser_"+(lasers.size+1), { height:0.004, width:0.004, depth: len }, scene);
            const lm = new StandardMaterial("laserMat", scene); lm.disableLighting=true; lm.emissiveColor=new Color3(0.95,0.8,0.2); lm.backFaceCulling=false;
            laser.material=lm; laser.isPickable=false; laser.parent=ptr; laser.position.z = len/2; lasers.set(source, laser);
            source.onMotionControllerInitObservable.add((mc)=>{
              try{ const tr = mc?.getComponent?.('xr-standard-trigger') || mc?.getComponent?.('trigger'); tr?.onButtonStateChangedObservable?.add((c)=>{ if (c.pressed){ try{ const origin = ptr.getAbsolutePosition?.() || ptr.absolutePosition || ptr.position; const dir = Vector3.TransformNormal(new Vector3(0,0,1), ptr.getWorldMatrix()).normalize(); const ray = new Ray(origin, dir, DOME_DIAMETER); const hit = scene.pickWithRay(ray, m=>m?.metadata?.hotspot===true); const toId = hit?.pickedMesh?.metadata?.to; if (toId && nodesById.has(toId)) goTo(toId, true); }catch{} } }); }catch{}
            });
          }catch{}
        });
        input?.onControllerRemovedObservable?.add((source)=>{ try{ lasers.get(source)?.dispose?.(); lasers.delete(source); }catch{} });
      }catch{}
      xr?.baseExperience?.onStateChangedObservable?.add(s=>{
        inXR = (s === WebXRState.IN_XR);
        try{ if (inXR){ prevHSL = engine.getHardwareScalingLevel?.() ?? null; engine.setHardwareScalingLevel(1.0); } else if (prevHSL!=null){ engine.setHardwareScalingLevel(prevHSL); } }catch{}
        try{ const cur = nodesById?.get?.(currentNodeId); if (cur && cur.file) { showFile(cur.file); buildHotspotsFor(cur); } }catch{}
      });
    }
  }catch{}

  /* boot */
  const start = nodesById.get(startNodeId);
  await showFile(start.file);
  worldRoot.position.copyFrom(nodeWorldPos(start));
  cam.rotation.y = -rad(start.yaw||0); cam.rotation.x = 0;
  buildHotspotsFor(start);
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
      const next=(BASE_URL+"experiences/"+newExp).replace(/\/{2,}/g,"/"); if (next===BASE) return;
      BASE=next;
      PANOS_DIR = "panos";
      try{ for (const [k,tex] of texCache.entries()){ try{ tex?.dispose?.(); }catch{} } texCache.clear(); }catch{}
      ({ data, nodesById, startNodeId } = await loadWalkthrough((BASE + "/walkthrough.json").replace(/\/{2,}/g,"/")));
      await maybeSelectMobilePanoDir();
      rebuildFloorMaps(); const node = nodesById.get(startNodeId) || (nodesById.size?nodesById.values().next().value:null); if (!node) return;
      currentNodeId = node.id; await showFile(node.file); worldRoot.position.copyFrom(nodeWorldPos(node)); buildHotspotsFor(node); await setMirrorNode(node.id); rebuildMinimap(); updateMirrorLayout(); sendSync(node.id);
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
    goToNode: (id)=>goTo(id,true),
    goToZoneByName: (name)=>{
      if (!name) return Promise.resolve();
      const list=(data?.zones||[]).map(z=>({ id:z.id, name:String(z.name||z.id).toLowerCase().trim() }));
      const q=String(name).toLowerCase().trim();
      const hit = list.find(z=>z.name===q) || list.find(z=>z.name.includes(q));
      if (!hit) return Promise.resolve();
      // Choose rep node or first node within that zone on current floor, else any
      const cand = (data?.nodes||[]).find(n=>n.zoneId===hit.id && n.floorId===nodesById.get(currentNodeId)?.floorId) ||
                   (data?.nodes||[]).find(n=>n.zoneId===hit.id) || null;
      if (cand) return goTo(cand.id,true);
      return Promise.resolve();
    },
    goToNextInZone: ()=>{
      const cur = nodesById.get(currentNodeId); if(!cur||!cur.zoneId) return Promise.resolve();
      const list=(data?.nodes||[]).filter(n=>n.zoneId===cur.zoneId);
      if (!list.length) return Promise.resolve();
      const i = Math.max(0, list.findIndex(n=>n.id===cur.id));
      const next = list[(i+1)%list.length];
      return goTo(next.id,true);
    },
    goToPrevInZone: ()=>{
      const cur = nodesById.get(currentNodeId); if(!cur||!cur.zoneId) return Promise.resolve();
      const list=(data?.nodes||[]).filter(n=>n.zoneId===cur.zoneId);
      if (!list.length) return Promise.resolve();
      const i = Math.max(0, list.findIndex(n=>n.id===cur.id));
      const prev = list[(i-1+list.length)%list.length];
      return goTo(prev.id,true);
    }
  };

  engine.runRenderLoop(()=>scene.render());
  window.addEventListener("resize", ()=>{ engine.resize(); updateMirrorLayout(); });
  return api;
}
