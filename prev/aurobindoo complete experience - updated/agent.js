// agent.js — Agent with multi-viewer mirror grid (bottom-right), camera-driven look
// 2D stays mono (cropped if the source is TB). XR uses true TB stereo via PhotoDome.

import "@babylonjs/loaders";
import {
  Engine, Scene, FreeCamera, WebXRState, Vector3, MeshBuilder, Mesh, Color4,
  StandardMaterial, Texture, Material, TransformNode, Color3, PointerEventTypes, ColorCurves, Viewport
} from "@babylonjs/core";
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
const STEREO_EXPERIENCES = new Set(["flat"]);   // mark TB stereo experiences here
const MIRROR_YAW_SIGN = 1;

/* env */
let BASE_URL = "/", WS_URL = "wss://vrsync.dev.opensky.co.in/";
try{
  if (import.meta?.env?.BASE_URL)    BASE_URL = import.meta.env.BASE_URL;
  if (import.meta?.env?.VITE_WS_URL) WS_URL   = import.meta.env.VITE_WS_URL;
}catch{}

const rad = d => d*Math.PI/180;
const normDeg = d => ((d%360)+360)%360;
const easeOutCubic = t => 1-Math.pow(1-t,3);
const v3arr = v => [v.x,v.y,v.z];
const expNameFrom = base => { const p=base.split("/").filter(Boolean); return p[p.length-1]||"amenities"; };

/* 2D texture mapping (mono crop for TB stereo) */
function mapFor2D(tex, stereo, flipU){
  if (!tex) return;
  tex.coordinatesMode = Texture.FIXED_EQUIRECTANGULAR_MODE;
  tex.uScale  = flipU ? -1 : 1;
  tex.uOffset = flipU ?  1 : 0;
  tex.vScale  = stereo ? -0.5 : -1.0; // bottom half = right eye (feel free to flip to 0.5/0.0 for top)
  tex.vOffset = 1.0;
  tex.wrapU = Texture.CLAMP_ADDRESSMODE;
  tex.wrapV = Texture.CLAMP_ADDRESSMODE;
}

export async function initAgent(opts = {}){
  const roomId = (opts.roomId && String(opts.roomId).trim()) || "demo";
  const exp    = (opts.exp    && String(opts.exp).trim()) || "amenities";

  let BASE = (BASE_URL + exp).replace(/\/{2,}/g,"/");
  const expName  = () => expNameFrom(BASE);
  const isStereo = () => STEREO_EXPERIENCES.has(expName());
  const panoUrl  = f => (BASE + "/panos/" + f).replace(/\/{2,}/g,"/");
  A("init", { roomId, exp:expName(), BASE, WS_URL });

  /* engine/scene */
  const canvas = document.getElementById("renderCanvas");
  const engine = new Engine(canvas, true);
  try{
    const IS_MOBILE=/Android|iPhone|iPad|iPod|Quest|Oculus/i.test(navigator.userAgent);
    engine.setHardwareScalingLevel(IS_MOBILE?1.25:1.0);
  }catch{}
  const scene  = new Scene(engine);
  scene.clearColor = new Color4(0,0,0,1);

  const cam = new FreeCamera("cam", new Vector3(0,0,0), scene);
  cam.attachControl(canvas, true);
  cam.inputs.clear();
  cam.fov=1.1; cam.minZ=0.1; cam.maxZ=50000; cam.layerMask=0x1;
  scene.activeCamera = cam;

  // gentle pop
  const ip = scene.imageProcessingConfiguration;
  ip.toneMappingEnabled = true; ip.exposure=1.08; ip.contrast=1.18;
  ip.colorCurvesEnabled = true; const curves=new ColorCurves(); curves.globalSaturation=35; ip.colorCurves=curves;

  /* data */
  let { data, nodesById, startNodeId } = await loadWalkthrough((BASE + "/walkthrough.json").replace(/\/{2,}/g,"/"));
  let currentNodeId = startNodeId;

  /* floors */
  const floorIndex=new Map(), floorCenter=new Map();
  function rebuildFloorMaps(){
    floorIndex.clear(); floorCenter.clear();
    data.floors.forEach((f,i)=>floorIndex.set(f.id,i));
    for (const f of data.floors){
      const on=data.nodes.filter(n=>n.floorId===f.id);
      let minX=Infinity,maxX=-Infinity,minY=Infinity,maxY=-Infinity;
      for (const n of on){ if(n.x<minX)minX=n.x; if(n.x>maxX)maxX=n.x; if(n.y<minY)minY=n.y; if(n.y>maxY)maxY=n.y; }
      const ppm=f.pxPerMeter||100, cx=isFinite(minX)?(minX+maxX)/2:0, cy=isFinite(minY)?(minY+maxY)/2:0;
      floorCenter.set(f.id,{cx,cy,ppm});
    }
  }
  rebuildFloorMaps();
  const nodeWorldPos = (n)=>{ const f=floorCenter.get(n.floorId)||{cx:0,cy:0,ppm:100}; const idx=floorIndex.get(n.floorId)??0;
    return new Vector3((n.x-f.cx)/f.ppm, idx*FLOOR_HEIGHT_M, (n.y-f.cy)/f.ppm); };

  /* world + main dome */
  const worldRoot = new TransformNode("worldRoot", scene);
  const dome = MeshBuilder.CreateSphere("dome",{diameter:DOME_DIAMETER,segments:64,sideOrientation:Mesh.BACKSIDE},scene);
  dome.parent=worldRoot; if(FLIP_X) dome.rotation.x=Math.PI; dome.layerMask=0x1;

  const domeMat=new StandardMaterial("panoMat",scene);
  domeMat.disableLighting=true; domeMat.backFaceCulling=false;
  domeMat.transparencyMode=Material.MATERIAL_ALPHABLEND; domeMat.disableDepthWrite=true;
  dome.material=domeMat; dome.renderingGroupId=0;

  /* XR (agent rarely uses; still correct if used) */
  const xr = await scene.createDefaultXRExperienceAsync({
    uiOptions:{sessionMode:"immersive-vr", referenceSpaceType:"local-floor"},
    optionalFeatures:true
  });
  let inXR=false, photoDome=null;
  const useXRMode = ()=>{
    if (inXR){
      dome.setEnabled(false);
      scene.activeCameras = [xr.baseExperience.camera];     // XR camera only
    }else{
      scene.activeCameras = [cam, ..._mirrorCams];          // restore mirror grid
      dome.setEnabled(true);
      photoDome && (photoDome.mesh.isVisible=false);
    }
  };
  function disposePhotoDome(){ if(photoDome){ photoDome.dispose(); photoDome=null; } }
  xr.baseExperience.onStateChangedObservable.add(s=>{ inXR=(s===WebXRState.IN_XR); useXRMode(); });

  /* textures */
  const NO_MIPS=true, SAMPLE=Texture.BILINEAR_SAMPLINGMODE;
  const texCache=new Map(), inFlight=new Map();
  function makeTexture(file){ return new Texture(panoUrl(file), scene, NO_MIPS, false, SAMPLE); }
  function getTexture(file){
    const key=BASE+"|"+file;
    if (texCache.has(key)) return Promise.resolve(texCache.get(key));
    if (inFlight.has(key)) return inFlight.get(key);
    const tex=makeTexture(file);
    const p=new Promise(res=>{
      if (tex.isReady()){ texCache.set(key,tex); return res(tex); }
      tex.onLoadObservable.addOnce(()=>{ texCache.set(key,tex); res(tex); });
    });
    inFlight.set(key,p); p.finally(()=>inFlight.delete(key));
    return p;
  }

  async function showFile(file){
    if (inXR){
      if (!photoDome) photoDome = new PhotoDome("pd", panoUrl(file), { size:DOME_DIAMETER }, scene);
      const mode = isStereo()? PhotoDome.MODE_TOPBOTTOM : PhotoDome.MODE_MONOSCOPIC;
      if ("stereoMode" in photoDome) photoDome.stereoMode = mode;
      if ("imageMode"  in photoDome) photoDome.imageMode  = mode;
      photoDome.mesh.isVisible = true;
      if (photoDome.photoTexture) photoDome.photoTexture.updateURL(panoUrl(file));
      dome.setEnabled(false);
    }else{
      const tex = await getTexture(file);
      mapFor2D(tex, /*stereo*/ isStereo(), FLIP_U); // 2D mono crop if TB
      domeMat.emissiveTexture = tex;
      dome.setEnabled(true);
    }
  }

  /* hotspots */
  const hotspotRoot=new TransformNode("hotspots",scene); hotspotRoot.parent=worldRoot; hotspotRoot.layerMask=0x1;
  function vecFromYawPitch(yawDeg,pitchDeg,R){ const y=rad(yawDeg), p=rad(pitchDeg||0), cp=Math.cos(p), sp=Math.sin(p); return new Vector3(R*Math.cos(y)*cp, R*sp, -R*Math.sin(y)*cp); }
  function makeHotspotMesh(label, meta){
    const root=new TransformNode("hs-"+label,scene); root.parent=hotspotRoot; root.layerMask=0x1;
    const ring=MeshBuilder.CreateDisc("hsRing",{radius:20,tessellation:48,sideOrientation:Mesh.DOUBLESIDE},scene);
    const dot =MeshBuilder.CreateDisc("hsDot",{radius:10,tessellation:32,sideOrientation:Mesh.DOUBLESIDE},scene);
    const rm=new StandardMaterial("hsRingMat",scene); rm.disableLighting=true; rm.emissiveColor=new Color3(1,1,1);
    const dm=new StandardMaterial("hsDotMat",scene);  dm.disableLighting=true; dm.emissiveColor=new Color3(1,0.62,0.18);
    ring.material=rm; dot.material=dm; ring.parent=root; dot.parent=root;
    ring.billboardMode=Mesh.BILLBOARDMODE_ALL; dot.billboardMode=Mesh.BILLBOARDMODE_ALL;
    const pick=MeshBuilder.CreateSphere("hsPick",{diameter:120,segments:8},scene);
    const pm=new StandardMaterial("hsPickMat",scene); pm.alpha=0.001; pm.disableLighting=true; pm.backFaceCulling=false;
    pick.material=pm; pick.parent=root; pick.isPickable=true; pick.renderingGroupId=1; pick.layerMask=0x1;
    pick.metadata={hotspot:true, ...meta};
    return root;
  }
  function clearHotspots(){ hotspotRoot.getChildren().forEach(c=>c.dispose()); }
  function buildHotspotsFor(node){
    clearHotspots();
    if (!(node?.hotspots?.length)) return;
    const R=DOME_DIAMETER*0.47;
    node.hotspots.forEach((h,i)=>{
      const absYaw=normDeg((node.yaw||0)-(h.yaw||0));
      const pos=vecFromYawPitch(absYaw, h.pitch||0, R);
      const root=makeHotspotMesh(h?.to ?? ("hs-"+(i+1)), {nodeId:node.id,index:i,to:h.to});
      root.position=pos;
    });
  }
  scene.onPointerObservable.add(poi=>{
    if (poi.type!==PointerEventTypes.POINTERUP) return;
    const pick=scene.pick(scene.pointerX,scene.pointerY,m=>m?.metadata?.hotspot===true,false,cam);
    const toId=pick?.pickedMesh?.metadata?.to;
    if (toId && nodesById.has(toId)) goTo(toId, true);
  });

  /* ===== WebSocket (put early so sendSync exists before used) ===== */
  let socket=null;
  function safeSend(o){ if (socket && socket.readyState===1){ try{ socket.send(JSON.stringify(o)); }catch{} } }
  function sendSync(nodeId){
    if (!nodeId) return;
    safeSend({ type:"sync", room:roomId, nodeId, exp:expName(), worldPos:v3arr(worldRoot.position) });
  }
  function normAngle(val){
    if (typeof val !== "number" || !isFinite(val)) return 0;
    if (Math.abs(val) > Math.PI * 2) return rad(val); // degrees -> radians
    return val;
  }
  (function connect(){
    try{ socket=new WebSocket(WS_URL); }catch{ socket=null; return; }
    socket.addEventListener("open", ()=>{ A("ws open",{url:WS_URL,room:roomId}); safeSend({type:"join", room:roomId, role:"guide"}); if(currentNodeId) sendSync(currentNodeId); });
    socket.addEventListener("close", ()=>{ socket=null; });
    socket.addEventListener("error", ()=>{ try{ socket.close(); }catch{} });
    socket.addEventListener("message", (ev)=>{
      let msg; try{ msg=JSON.parse(ev.data); }catch{ return; }
      if (!(msg && msg.room===roomId)) return;

      // From viewers: { type:"sync", from:"viewer", uid, pose:{yaw,pitch}, nodeId? }
      const isViewer = msg.type==="sync" && msg.from==="viewer" && typeof msg.uid==="string";
      if (isViewer){
        if (!viewers.has(msg.uid)){
          const mCam = new FreeCamera("mcam_"+msg.uid, new Vector3(0,0,0), scene);
          const root = new TransformNode("mCamRoot_"+msg.uid, scene);
          mCam.parent = root; mCam.position.set(0,1.6,0);
          mCam.fov=1.0; mCam.minZ=0.1; mCam.maxZ=50000;
          viewers.set(msg.uid, { cam:mCam, root, nodeId:null });
          updateMirrorLayout();
        }
        const v = viewers.get(msg.uid);
        if (msg.pose){
          v.root.rotation.y = MIRROR_YAW_SIGN * normAngle(msg.pose.yaw||0);
          v.root.rotation.x = normAngle(msg.pose.pitch||0);
        }
        if (msg.nodeId) { v.nodeId = msg.nodeId; setMirrorNode(msg.nodeId); }
      }
    });
  })();

  /* camera drag */
  let dragging=false,lastX=0,lastY=0,cPitch=0;
  const yawSpeed=0.005, pitchSpeed=0.003, pitchClamp=rad(70);
  function setCamPitch(p){ cPitch=Math.max(-pitchClamp,Math.min(pitchClamp,p)); cam.rotation.x=cPitch; }
  canvas.style.cursor="grab";
  canvas.addEventListener("pointerdown",e=>{ dragging=true; lastX=e.clientX; lastY=e.clientY; try{canvas.setPointerCapture(e.pointerId);}catch{} canvas.style.cursor="grabbing"; },{passive:false});
  canvas.addEventListener("pointermove",e=>{
    if(!dragging) return;
    const dx=e.clientX-lastX, dy=e.clientY-lastY; lastX=e.clientX; lastY=e.clientY;
    cam.rotation.y -= dx*yawSpeed; setCamPitch(cPitch - dy*pitchSpeed);
    sendSync(currentNodeId);                // ✅ defined already
  },{passive:true});
  canvas.addEventListener("pointerup",()=>{ dragging=false; canvas.style.cursor="grab"; },{passive:true});

  /* minimap */
  let mini=null;
  function rebuildMinimap(){
    document.querySelectorAll(".mini-wrap").forEach(el=>el.remove());
    const padByFloor = new Map(data.floors.map(f=>[f.id,{x:0,y:0}]));
    mini = buildMinimapDOM({
      floors:data.floors, basePath:BASE, padByFloor, coordsMode:"auto", ui:"dropdown",
      panelWidth:"360px", position:"top-right", paddingPx:14,
      onSelectNode:id=>{ if(id) goTo(id,true); },
      onFloorChange:fid=>{ const list=data.nodes.filter(x=>x.floorId===fid); mini.renderPoints(list,currentNodeId); }
    });
    const cur = nodesById.get(currentNodeId) || nodesById.get(startNodeId) || (nodesById.size?nodesById.values().next().value:null);
    if (cur){ mini.setActiveFloor(cur.floorId,true,false); mini.renderPoints(data.nodes.filter(x=>x.floorId===cur.floorId), currentNodeId); }
  }
  rebuildMinimap();

  /* move then swap */
  function forwardPushThenSwap(nextNode, dur=NAV_DUR_MS, push=NAV_PUSH_M){
    const startPos=worldRoot.position.clone();
    const yawW=cam.rotation.y;
    const fwd=new Vector3(-Math.sin(yawW),0,-Math.cos(yawW)).scale(push);
    const t0=performance.now();
    const pre = getTexture(nextNode.file);
    return new Promise(res=>{
      const ob=scene.onBeforeRenderObservable.add(()=>{
        const t=Math.min(1,(performance.now()-t0)/dur), e=easeOutCubic(t);
        worldRoot.position.copyFrom(startPos.add(fwd.scale(e)));
        sendSync(currentNodeId);
        if(t>=1){ scene.onBeforeRenderObservable.remove(ob); res(); }
      });
    }).then(()=>pre)
      .then(async ()=>{
        await showFile(nextNode.file);           // 2D mono crop / XR stereo
        worldRoot.position.copyFrom(nodeWorldPos(nextNode));
      }).then(()=> sendSync(currentNodeId));
  }
  function goTo(targetId, broadcast){
    if (!(targetId && targetId!==currentNodeId)) return Promise.resolve();
    const node=nodesById.get(targetId); if(!node) return Promise.resolve();
    currentNodeId=node.id;
    const fid=node.floorId; mini.setActiveFloor(fid,true,true);
    mini.renderPoints(data.nodes.filter(x=>x.floorId===fid), node.id);
    return forwardPushThenSwap(node).then(()=>{ if (broadcast===true) sendSync(currentNodeId); });
  }

  /* ===== Mirror grid (multi-UID) ===== */
  const PANEL = { x: 1 - 0.20 - 0.02, y: 0.02, w: 0.20, h: 0.26 };
  const viewers = new Map(); // uid -> {cam, root, nodeId}
  let _mirrorCams = [];
  let mirrorVisible = true;

  const hud = document.getElementById("mirrorHud");
  const uidNum = new Map(); const getUidNum = uid => { if (!uidNum.has(uid)) uidNum.set(uid, uidNum.size + 1); return uidNum.get(uid); };

  function ensureBadge(uid){
    if (!hud) return null;
    let el = hud.querySelector(`[data-uid="${uid}"]`);
    if (!el){
      el = document.createElement("div");
      el.dataset.uid = uid; el.className = "mirror-badge"; el.textContent = getUidNum(uid);
      hud.appendChild(el);
    }
    return el;
  }
  function layoutLabels(){
    if (!hud) return;
    hud.querySelectorAll(".mirror-badge").forEach(el=>{ if (!viewers.has(el.dataset.uid)) el.remove(); });
    const keys=[...viewers.keys()], n=keys.length; if (!n) return;
    const cols=Math.ceil(Math.sqrt(n)), rows=Math.ceil(n/cols), tileW=PANEL.w/cols, tileH=PANEL.h/rows;
    for (let i=0;i<n;i++){
      const uid=keys[i], col=i%cols, row=(i/cols)|0;
      const vx=PANEL.x+col*tileW, vy=PANEL.y+row*tileH, vw=tileW, vh=tileH;
      const cssLeft=vx*100, cssTop=(1-(vy+vh))*100;
      const el=ensureBadge(uid);
      if (el){ const pad=6, size=22;
        el.style.left=`calc(${cssLeft}% + ${vw*100}% - ${pad + size}px)`;
        el.style.top =`calc(${cssTop }% + ${vh*100}% - ${pad + size}px)`;
        el.textContent=getUidNum(uid);
      }
    }
  }
  function updateMirrorLayout(){
    const cams=[], list=[...viewers.values()], n=list.length;
    if (n===0){ scene.activeCameras = [cam]; layoutLabels(); return; }
    const cols=Math.ceil(Math.sqrt(n)), rows=Math.ceil(n/cols);
    for (let i=0;i<n;i++){
      const v=list[i], col=i%cols, row=(i/cols)|0;
      const vpW=PANEL.w/cols, vpH=PANEL.h/rows, vpX=PANEL.x + col*vpW, vpY=PANEL.y + row*vpH;
      v.cam.viewport=new Viewport(vpX,vpY,vpW,vpH); v.cam.layerMask=0x2; cams.push(v.cam);
    }
    _mirrorCams=cams;
    if (!inXR) scene.activeCameras = mirrorVisible ? [cam, ..._mirrorCams] : [cam];
    layoutLabels();
  }

  const mirrorDome = MeshBuilder.CreateSphere("mirrorDome",{diameter:DOME_DIAMETER,segments:48,sideOrientation:Mesh.BACKSIDE},scene);
  if(FLIP_X) mirrorDome.rotation.x=Math.PI;
  mirrorDome.layerMask=0x2;
  const mirrorMat = new StandardMaterial("mirrorMat",scene);
  mirrorMat.disableLighting=true; mirrorMat.backFaceCulling=false;
  mirrorMat.transparencyMode=Material.MATERIAL_ALPHABLEND; mirrorMat.disableDepthWrite=true;
  mirrorDome.material = mirrorMat;
  let mirrorNodeId=null, mirrorTexKey=null;

  async function setMirrorNode(id){
    if (!id || id===mirrorNodeId || !nodesById.has(id)) return;
    const file = nodesById.get(id).file, key = BASE + "|" + file;
    if (mirrorTexKey === key) { mirrorNodeId = id; return; }
    const tex = await getTexture(file);
    mirrorMat.emissiveTexture = tex;
    mapFor2D(tex, /*stereo*/ isStereo(), FLIP_U);   // mirror shows same mono crop as 2D
    mirrorTexKey = key; mirrorNodeId = id;
  }

  /* boot */
  async function bootTo(node){
    const tex = await getTexture(node.file);
    mapFor2D(tex, /*stereo*/ isStereo(), FLIP_U);
    domeMat.emissiveTexture=tex;
    worldRoot.position.copyFrom(nodeWorldPos(node));
    cam.rotation.y = -rad(node.yaw||0); cam.rotation.x = 0;
    buildHotspotsFor(node);
    rebuildMinimap();
    mirrorMat.emissiveTexture = tex; mapFor2D(tex, /*stereo*/ isStereo(), FLIP_U);
    mirrorNodeId = node.id; mirrorTexKey = BASE + "|" + node.file;
    sendSync(node.id);
  }
  await bootTo(nodesById.get(startNodeId));
  await showFile(nodesById.get(startNodeId).file);
  updateMirrorLayout();

  const api = {
    nudgeYaw:  d=>{ cam.rotation.y += d; sendSync(currentNodeId); },
    nudgePitch:d=>{ const clamp=Math.PI*70/180; const nx=Math.max(-clamp,Math.min(clamp,cam.rotation.x + d)); cam.rotation.x=nx; sendSync(currentNodeId); },
    toggleMirror: ()=>{ mirrorVisible=!mirrorVisible; updateMirrorLayout(); },
    switchExperience: async (newExp)=>{
      if (!newExp) return;
      const next=(BASE_URL+newExp).replace(/\/{2,}/g,"/"); if (next===BASE) return;
      BASE=next;
      ({ data, nodesById, startNodeId } = await loadWalkthrough((BASE + "/walkthrough.json").replace(/\/{2,}/g,"/")));
      rebuildFloorMaps();
      const node = nodesById.get(startNodeId) || (nodesById.size?nodesById.values().next().value:null);
      if (!node) return;
      await bootTo(node);
      await showFile(node.file);
      updateMirrorLayout();
    }
  };

  engine.runRenderLoop(()=>scene.render());
  window.addEventListener("resize", ()=>{ engine.resize(); layoutLabels(); updateMirrorLayout(); });

  return api;
}
