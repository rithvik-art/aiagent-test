// user.js — Viewer: 2D mono (crop TB), XR true TB stereo, pose broadcast (~10 Hz)

import "@babylonjs/loaders";
import {
  Engine, Scene, FreeCamera, Vector3, MeshBuilder, Mesh, Color4,
  StandardMaterial, Texture, Material, TransformNode, WebXRState, Quaternion
} from "@babylonjs/core";
import { PhotoDome } from "@babylonjs/core/Helpers/photoDome";
import { loadWalkthrough } from "./walkthrough-loader.js";

/* ---------- config ---------- */
const FLIP_U = true, FLIP_X = true;
const DOME_DIAMETER = 2000, FLOOR_HEIGHT_M = 3.0;

/* mark experiences that have Top/Bottom stereo sources */
const STEREO_EXPERIENCES = new Set(["flat"]);

/* ---------- helpers ---------- */
const rad = d => d * Math.PI / 180;

/* map for 2D: crop TB stereo to one half (mono), full image for mono */
function mapFor2D(tex, stereo){
  if (!tex) return;
  tex.coordinatesMode = Texture.FIXED_EQUIRECTANGULAR_MODE;
  tex.uScale  = FLIP_U ? -1 : 1;
  tex.uOffset = FLIP_U ?  1 : 0;
  tex.vScale  = stereo ? -0.5 : -1.0;   // bottom half (flip to 0.5/0.0 for top half)
  tex.vOffset = 1.0;
  tex.wrapU = Texture.CLAMP_ADDRESSMODE;
  tex.wrapV = Texture.CLAMP_ADDRESSMODE;
}

export async function initViewer({ roomId="demo", exp="amenities" } = {}) {
  const uid = (crypto?.randomUUID?.() || Math.random().toString(36).slice(2)).replace(/[^a-z0-9\-]/gi,"");
  const BASE_URL = (import.meta?.env?.BASE_URL ?? "/");
  let   BASE     = `${BASE_URL}${exp}`.replace(/\/{2,}/g,"/");
  const expName  = () => BASE.split("/").filter(Boolean).pop();
  const isStereo = () => STEREO_EXPERIENCES.has(expName());
  const panoUrl  = f => `${BASE}/panos/${f}`.replace(/\/{2,}/g,"/");

  /* Engine / Scene */
  const canvas = document.getElementById("renderCanvas");
  const engine = new Engine(canvas, true);
  const scene  = new Scene(engine);
  scene.clearColor = new Color4(0,0,0,1);

  const cam = new FreeCamera("cam", new Vector3(0,0,0), scene);
  cam.attachControl(canvas, true);
  cam.inputs.clear();
  cam.fov = 1.1; cam.minZ = 0.1; cam.maxZ = 50000;

  engine.runRenderLoop(()=>scene.render());
  addEventListener("resize", ()=>engine.resize());

  /* Data */
  let { data, nodesById, startNodeId } = await loadWalkthrough(`${BASE}/walkthrough.json`);
  let currentNodeId = startNodeId;

  // floor → world
  const floorIndex=new Map(), floorCenters=new Map();
  function rebuildFloors(){
    floorIndex.clear(); floorCenters.clear();
    data.floors.forEach((f,i)=>floorIndex.set(f.id,i));
    for (const f of data.floors){
      const on=data.nodes.filter(n=>n.floorId===f.id);
      let minX=Infinity,maxX=-Infinity,minY=Infinity,maxY=-Infinity;
      for (const n of on){
        if(typeof n.x==="number" && typeof n.y==="number"){
          if(n.x<minX)minX=n.x; if(n.x>maxX)maxX=n.x;
          if(n.y<minY)minY=n.y; if(n.y>maxY)maxY=n.y;
        }
      }
      const ppm=f.pxPerMeter||100, cx=isFinite(minX)?(minX+maxX)/2:0, cy=isFinite(minY)?(minY+maxY)/2:0;
      floorCenters.set(f.id,{cx,cy,ppm});
    }
  }
  rebuildFloors();
  const nodeWorldPos=(n)=>{ const f=floorCenters.get(n.floorId)||{cx:0,cy:0,ppm:100}; const idx=floorIndex.get(n.floorId)??0;
    return new Vector3((n.x-f.cx)/f.ppm, idx*FLOOR_HEIGHT_M, (n.y-f.cy)/f.ppm); };

  // world + dual domes (for fade)
  const worldRoot = new TransformNode("worldRoot", scene);
  const domeA = MeshBuilder.CreateSphere("domeA",{diameter:DOME_DIAMETER,segments:48,sideOrientation:Mesh.BACKSIDE},scene);
  const domeB = MeshBuilder.CreateSphere("domeB",{diameter:DOME_DIAMETER,segments:48,sideOrientation:Mesh.BACKSIDE},scene);
  domeA.parent=worldRoot; domeB.parent=worldRoot;
  if (FLIP_X){ domeA.rotation.x = Math.PI; domeB.rotation.x = Math.PI; }

  const matA=new StandardMaterial("panoMatA",scene);
  const matB=new StandardMaterial("panoMatB",scene);
  [matA,matB].forEach(m=>{ m.disableLighting=true; m.backFaceCulling=false; m.transparencyMode=Material.MATERIAL_ALPHABLEND; m.alpha=1.0; });
  domeA.material=matA; domeB.material=matB;
  domeA.setEnabled(true); domeB.setEnabled(false);
  let activeDome="A";

  /* 2D look: rotate CAMERA (not world) */
  let yaw=0, pitch=0;
  function applyCam(){ cam.rotation.y=yaw; cam.rotation.x=pitch; }
  ;(function(){
    let dragging=false,lx=0,ly=0,S=0.18*Math.PI/180, clamp=Math.PI*0.39;
    canvas.addEventListener("pointerdown",e=>{ dragging=true; lx=e.clientX; ly=e.clientY; try{canvas.setPointerCapture(e.pointerId);}catch{} },{passive:false});
    addEventListener("pointerup",()=>{ dragging=false; },{passive:true});
    addEventListener("pointermove",e=>{
      if(!dragging) return;
      const dx=e.clientX-lx, dy=e.clientY-ly; lx=e.clientX; ly=e.clientY;
      yaw -= dx*S; pitch = Math.max(-clamp, Math.min(clamp, pitch - dy*S));
      applyCam();
    },{passive:true});
  })();

  /* XR */
  let xr=null, inXR=false, xrA=null, xrB=null;
  async function ensureXR(){
    try{ if(!(navigator.xr && await navigator.xr.isSessionSupported?.("immersive-vr"))) return false; }catch{ return false; }
    if (!xr){
      xr = await scene.createDefaultXRExperienceAsync({
        uiOptions:{sessionMode:"immersive-vr",referenceSpaceType:"local-floor", disableDefaultUI:true},
        optionalFeatures:true
      });
      xr.baseExperience.onStateChangedObservable.add((s)=>{
        inXR = (s===WebXRState.IN_XR);
        if (inXR){
          // XR camera only; hide 2D domes so nothing screen-locks
          domeA.setEnabled(false); domeB.setEnabled(false);
          scene.activeCameras = [xr.baseExperience.camera];
        }else{
          scene.activeCameras = [cam];
          (activeDome==="A"?domeA:domeB).setEnabled(true);
        }
      });
    }
    return true;
  }

  /* textures */
  const NO_MIPS=true, BILINEAR=Texture.BILINEAR_SAMPLINGMODE, INVERT_Y=false;
  const cache=new Map(), inflight=new Map();
  function makeTex(file,onReady){ return new Texture(panoUrl(file), scene, NO_MIPS, INVERT_Y, BILINEAR, ()=>onReady?.(), ()=>onReady?.()); }
  async function getTex(file){
    const key=`${BASE}|${file}`;
    if (cache.has(key)) return cache.get(key);
    if (inflight.has(key)) return inflight.get(key);
    const p=new Promise(res=>{ const t=makeTex(file, ()=>res(t)); });
    inflight.set(key,p); const tex=await p; inflight.delete(key); cache.set(key,tex); return tex;
  }

  /* cross-fades */
  async function crossfade2D(file){
    const next = await getTex(file);
    mapFor2D(next, /*stereo?*/ isStereo());
    const first = !matA.emissiveTexture && !matB.emissiveTexture;
    if (first){ matA.emissiveTexture=next; domeA.setEnabled(true); domeB.setEnabled(false); matA.alpha=1; matB.alpha=0; activeDome="A"; return; }
    const fromMat = (activeDome==="A")?matA:matB;
    const toMat   = (activeDome==="A")?matB:matA;
    const toDome  = (activeDome==="A")?domeB:domeA;
    const fromDome= (activeDome==="A")?domeA:domeB;
    toMat.emissiveTexture=next; toMat.alpha=0; toDome.setEnabled(true);
    const FADE=160, t0=performance.now();
    await new Promise(res=>{
      const ob=scene.onBeforeRenderObservable.add(()=>{
        const t=Math.min(1,(performance.now()-t0)/FADE);
        fromMat.alpha=1-t; toMat.alpha=t;
        if (t>=1){ scene.onBeforeRenderObservable.remove(ob); res(); }
      });
    });
    fromDome.setEnabled(false); fromMat.alpha=0; toMat.alpha=1; activeDome=(activeDome==="A")?"B":"A";
  }

  async function crossfadeXR(file){
    if (!xrA && !xrB){
      xrA = new PhotoDome("vpdA", panoUrl(file), { size:DOME_DIAMETER }, scene);
      xrB = new PhotoDome("vpdB", panoUrl(file), { size:DOME_DIAMETER }, scene);
      xrA.mesh.isVisible = true; xrB.mesh.isVisible = false;
    }
    const useA = xrB?.mesh?.isVisible === true;
    const from = useA ? xrB : xrA;
    const to   = useA ? xrA : xrB;

    const mode = isStereo()? PhotoDome.MODE_TOPBOTTOM : PhotoDome.MODE_MONOSCOPIC;
    if ("stereoMode" in to) to.stereoMode = mode;
    if ("imageMode"  in to) to.imageMode  = mode;

    if (to.photoTexture) to.photoTexture.updateURL(panoUrl(file));
    await new Promise(res=>{
      const iv=setInterval(()=>{ if(to?.photoTexture?.isReady()){ clearInterval(iv); res(); }},16);
    });

    const fromM = from.mesh.material, toM = to.mesh.material;
    to.mesh.isVisible = true; toM.alpha = 0;
    const FADE=160, t0=performance.now();
    await new Promise(res=>{
      const ob=scene.onBeforeRenderObservable.add(()=>{
        const t=Math.min(1,(performance.now()-t0)/FADE);
        fromM.alpha=1-t; toM.alpha=t;
        if (t>=1){ scene.onBeforeRenderObservable.remove(ob); res(); }
      });
    });
    from.mesh.isVisible=false; fromM.alpha=0; toM.alpha=1;
  }

  async function swapPano(file){
    if (await ensureXR() && inXR) await crossfadeXR(file);
    else await crossfade2D(file);
  }

  /* WebSocket sync (talk to Agent + mirror) */
  const WS_URL =
    (typeof import.meta !== "undefined" && import.meta.env && import.meta.env.VITE_WS_URL)
      ? import.meta.env.VITE_WS_URL
      : "wss://vrsync.dev.opensky.co.in/";
  let socket=null, wsOpen=false;
  function safeSend(o){ if (wsOpen) { try{ socket.send(JSON.stringify(o)); }catch{} } }

  // Boot
  const start = nodesById.get(startNodeId);
  worldRoot.position.copyFrom(nodeWorldPos(start));
  yaw = -rad(start.yaw||0); pitch = 0; applyCam();
  await swapPano(start.file);

  // follow Agent world position smoothly
  const targetPos = new Vector3().copyFrom(worldRoot.position);

  // Compute viewer pose (camera in 2D, HMD in XR)
  function computeViewerPose(){
    if (inXR && xr?.baseExperience?.camera){
      const dir = xr.baseExperience.camera.getForwardRay().direction;
      const yawV   = Math.atan2(-dir.x, -dir.z);
      const pitchV = Math.asin(dir.y);
      return { yaw:yawV, pitch:pitchV };
    }
    return { yaw: cam.rotation.y, pitch: cam.rotation.x };
  }

  // Connect WS and listen to Agent
  let switchingExp=false;
  (function connectWS(){
    try{ socket=new WebSocket(WS_URL); }catch{ socket=null; return; }
    socket.addEventListener("open", ()=>{
      wsOpen=true;
      safeSend({ type:"join", room:roomId, role:"viewer", uid });
      // initial pose burst
      safeSend({ type:"sync", room:roomId, from:"viewer", uid, nodeId: currentNodeId, pose: computeViewerPose() });
    });
    socket.addEventListener("close", ()=>{ wsOpen=false; setTimeout(connectWS,1200); });
    socket.addEventListener("error", ()=>{ try{ socket.close(); }catch{} });

    socket.addEventListener("message", async (ev)=>{
      let msg; try{ msg=JSON.parse(ev.data); }catch{ return; }
      if (msg?.type!=="sync" || msg.room!==roomId) return;

      // Experience switch from Agent
      if (msg.exp && `${BASE_URL}${msg.exp}` !== BASE && !switchingExp){
        switchingExp = true;
        BASE = `${BASE_URL}${msg.exp}`.replace(/\/{2,}/g,"/");
        ({ data, nodesById, startNodeId } = await loadWalkthrough(`${BASE}/walkthrough.json`));
        rebuildFloors();
        currentNodeId = startNodeId;
        const nd = nodesById.get(currentNodeId);
        worldRoot.position.copyFrom(nodeWorldPos(nd));
        yaw = -rad(nd.yaw||0); pitch=0; applyCam();
        await swapPano(nd.file);
        switchingExp = false;
      }

      // world position follow
      if (Array.isArray(msg.worldPos) && msg.worldPos.length===3){
        targetPos.set(msg.worldPos[0], msg.worldPos[1], msg.worldPos[2]);
      }

      // pano swap
      if (msg.nodeId && nodesById.has(msg.nodeId) && msg.nodeId !== currentNodeId){
        currentNodeId = msg.nodeId;
        await swapPano(nodesById.get(msg.nodeId).file);
      }
    });
  })();

  // Render-time updates: smooth follow + 10 Hz pose broadcast
  let lastPoseT = 0;
  scene.onBeforeRenderObservable.add(()=>{
    worldRoot.position = Vector3.Lerp(worldRoot.position, targetPos, 0.18);

    const now = performance.now();
    if (wsOpen && now - lastPoseT > 100){          // ~10 Hz
      const pose = computeViewerPose();
      safeSend({ type:"sync", room:roomId, from:"viewer", uid, nodeId: currentNodeId, pose });
      lastPoseT = now;
    }
  });

  return {};
}
