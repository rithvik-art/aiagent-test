/* -------- walkthrough-loader.js -------- */

export async function loadWalkthrough(url = "./walkthrough.json") {
  const r = await fetch(url);
  if (!r.ok) throw new Error(`walkthrough.json fetch failed: ${r.status} ${r.statusText}`);
  let raw;
  try { raw = await r.json(); } catch { throw new Error("walkthrough.json is not valid JSON"); }

  const candidate = (raw && (raw.data || raw.project)) || raw || {};
  const floors = Array.isArray(candidate.floors) ? candidate.floors : [];
  const nodesIn = Array.isArray(candidate.nodes) ? candidate.nodes : [];
  const zonesIn = Array.isArray(candidate.zones) ? candidate.zones : [];

  const nodes = nodesIn.map((n, i) => {
    const id =
      (typeof n.id === "string" && n.id) ||
      (typeof crypto !== "undefined" && crypto.randomUUID ? crypto.randomUUID() : `node-${i + 1}`);
    const hotspots = Array.isArray(n.hotspots)
      ? n.hotspots.map(h => ({
          to: h?.to,
          type: h?.type || "walk",
          // Prefer absolute angles if provided by the authoring tool
          yaw: typeof h?.absYaw === "number" ? h.absYaw : (typeof h?.yaw === "number" ? h.yaw : 0),
          pitch: typeof h?.absPitch === "number" ? h.absPitch : (typeof h?.pitch === "number" ? h.pitch : 0),
          // Preserve authored direction vector for exact placement if available
          dir: Array.isArray(h?.dir) ? h.dir.slice(0,3) : undefined,
          // Keep UV if needed in future for UI hinting (not used for placement)
          uv: Array.isArray(h?.uv) ? h.uv.slice(0,2) : undefined,
        }))
      : [];
    return {
      id,
      file: n?.file ?? "",
      floorId: n?.floorId ?? (floors[0]?.id || "floor-1"),
      x: typeof n?.x === "number" ? n.x : 0,
      y: typeof n?.y === "number" ? n.y : 0,
      z: typeof n?.z === "number" ? n.z : 0,
      yaw: typeof n?.yaw === "number" ? n.yaw : 0,
      zoneId: (typeof n?.zoneId === "string" && n.zoneId) ? n.zoneId : undefined,
      hotspots,
    };
  });

  // Normalize zones (optional)
  const zones = zonesIn.map((z, i) => {
    const id = (typeof z?.id === "string" && z.id) || `zone-${i + 1}`;
    const floorId = z?.floorId ?? (floors[0]?.id || "floor-1");
    const points = Array.isArray(z?.points) ? z.points
      .map(p => ({ x: Number(p?.x) || 0, y: Number(p?.y) || 0 })) : [];
    return {
      id,
      name: (typeof z?.name === "string" ? z.name : id),
      floorId,
      repNodeId: (typeof z?.repNodeId === "string" ? z.repNodeId : null),
      points,
    };
  });

  const nodesById = new Map(nodes.map(n => [n.id, n]));
  let startNodeId = candidate.startNodeId;
  if (!startNodeId || !nodesById.has(startNodeId)) startNodeId = nodes[0]?.id ?? null;

  return { data: { floors, nodes, zones, startNodeId }, nodesById, startNodeId };
}

/* -------- Minimap (uses basePath for ./<exp>/floors/) -------- */
export function buildMinimapDOM({
  floors,
  basePath = ".",
  padByFloor,
  coordsMode = "auto",
  mappingMode = "auto",
  edgePadRatio = 0.06,
  ui = "dropdown",
  // Default width adapts to both portrait and landscape using vw/vh
  panelWidth = "clamp(160px, min(44vw, 42vh), 320px)",
  position = "top-right",
  paddingPx = 14,
  onSelectNode,
  onFloorChange,
  container,
  coordByFloor,
  originByFloor,
  // optional: zones overlay per floor [{ id, points:[{x,y}...], label }]
  zonesByFloor,
} = {}) {
  if (!document.getElementById("mini-style-override")) {
    const st = document.createElement("style");
    st.id = "mini-style-override";
    st.textContent = `
      .mini-wrap{position:absolute; top:18px; z-index:30; width:var(--mini-width, clamp(160px, min(44vw, 42vh), 320px))}
      .mini-wrap.pos-right{right:18px} .mini-wrap.pos-left{left:18px}
      .mini-bar{display:flex; gap:8px; margin-bottom:10px}
      .mini-select{flex:1; padding:10px 12px; border-radius:12px; border:1px solid #2a3242; background:#1b2233; color:#e8eaf0}
      .mini-img-wrap{position:relative; background:rgba(15,20,32,.78); border:1px solid #2a3242; border-radius:14px}
      .mini-content{position:absolute; inset:var(--pad,14px)}
      .mini-fit{position:absolute; left:50%; top:50%; transform:translate(-50%,-50%)}
      .mini-img{position:absolute; inset:0; width:100%; height:100%; object-fit:fill; border-radius:10px}
      .mini-zones{position:absolute; inset:0; width:100%; height:100%; pointer-events:none}
      .mini-zone{fill:rgba(255,255,255,0.10); stroke:rgba(255,255,255,0.85); stroke-width:2; vector-effect:non-scaling-stroke; pointer-events:auto}
      .mini-zone.active{fill:rgba(6,214,160,0.18); stroke:#06d6a0}
      .mini-torch{fill:rgba(255,209,102,.18); stroke:rgba(255,209,102,.55); stroke-width:2; vector-effect:non-scaling-stroke}
      .mini-points{position:absolute; inset:0; pointer-events:none}
      .mini-point{position:absolute; width:12px; height:12px; margin:-6px 0 0 -6px; background:#ffd166; border-radius:50%;
                  box-shadow:0 0 0 2px rgba(8,10,15,.55), 0 0 0 5px rgba(255,209,102,.32); pointer-events:auto}
      .mini-point.active{background:#06d6a0; box-shadow:0 0 0 2px rgba(8,10,15,.65), 0 0 0 5px rgba(6,214,160,.35)}
      .mini-label{position:absolute; transform:translate(-50%, -14px); padding:2px 6px; border-radius:8px; font:600 11px/1.2 Inter, ui-sans-serif, system-ui, -apple-system, 'Segoe UI', Roboto; color:#e8eaf0; background:rgba(0,0,0,.55); border:1px solid rgba(255,255,255,.12); pointer-events:none; white-space:nowrap}
    `;
    document.head.appendChild(st);
  }

  const wrap = document.createElement("div");
  wrap.className = "mini-wrap " + (position === "top-left" ? "pos-left" : "pos-right");
  wrap.style.setProperty("--mini-width", panelWidth);
  wrap.style.setProperty("--pad", `${paddingPx}px`);

  const bar = document.createElement("div");
  bar.className = "mini-bar";
  wrap.appendChild(bar);

  const selectEl = document.createElement("select");
  selectEl.className = "mini-select";
  (floors || []).forEach(f => {
    const opt = document.createElement("option");
    opt.value = f.id; opt.textContent = f.name || f.id;
    selectEl.appendChild(opt);
  });
  bar.appendChild(selectEl);

  const imgWrap = document.createElement("div");
  imgWrap.className = "mini-img-wrap";
  const content = document.createElement("div");
  content.className = "mini-content";
  const fit = document.createElement("div");
  fit.className = "mini-fit";
  const img = document.createElement("img");
  img.className = "mini-img";
  const zonesSvg = document.createElementNS("http://www.w3.org/2000/svg", "svg");
  zonesSvg.setAttribute("class", "mini-zones");
  const torchPath = document.createElementNS("http://www.w3.org/2000/svg", "path");
  torchPath.setAttribute("class", "mini-torch");
  const points = document.createElement("div");
  points.className = "mini-points";
  const zoneLabels = document.createElement("div");
  zoneLabels.className = "mini-zone-labels mini-points";

  fit.appendChild(img);
  fit.appendChild(zonesSvg);
  fit.appendChild(points);
  fit.appendChild(zoneLabels);
  content.appendChild(fit);
  imgWrap.appendChild(content);
  wrap.appendChild(imgWrap);
  (container || document.body).appendChild(wrap);

  const autoSizeByFloor = new Map();
  const isMap = (m) => m && typeof m.get === "function";
  const getPad = (fid) => (isMap(padByFloor) && padByFloor.get(fid)) || { x: 0, y: 0 };
  const getCoordRef = (fid) => (isMap(coordByFloor) && coordByFloor.get(fid)) || null;
  const getOrigin = (fid) => (isMap(originByFloor) && originByFloor.get(fid)) || { x: 0, y: 0 };

  (floors || []).forEach((f) => {
    const im = new Image();
    im.onload = () => {
      const overrideW = Number(f?.width || f?.w || f?.imageWidth || 0) || 0;
      const overrideH = Number(f?.height || f?.h || f?.imageHeight || 0) || 0;
      const w = overrideW > 0 ? overrideW : im.naturalWidth;
      const h = overrideH > 0 ? overrideH : im.naturalHeight;
      autoSizeByFloor.set(f.id, { w, h });
      if (f.id === currentFloorId) {
        setWrapAspectFor(autoSizeByFloor.get(f.id));
        layoutFit(autoSizeByFloor.get(f.id));
        renderPoints(lastNodesForFloor, lastActiveId);
      }
    };
    im.src = `${basePath}/floors/${encodeURI(f.image || "")}`;
  });

  function setWrapAspectFor(sz) {
    if (!sz) return;
    imgWrap.style.aspectRatio = `${sz.w + 2 * paddingPx} / ${sz.h + 2 * paddingPx}`;
  }
  function layoutFit(sz) {
    if (!sz) return;
    const cr = content.getBoundingClientRect();
    if (!cr.width || !cr.height) return;
    const s = Math.min(cr.width / sz.w, cr.height / sz.h);
    fit.style.width = `${sz.w * s}px`;
    fit.style.height = `${sz.h * s}px`;
  }

  let currentFloorId = floors?.[0]?.id;
  let lastNodesForFloor = [];
  let lastActiveId = null;
  let lastZonesForFloor = [];
  let lastActiveZoneId = null;
  let lastTorch = { x:0, y:0, yawRad:0, visible:false };
  let lastZoneExtents = null; // {minX,maxX,minY,maxY}

  function setActiveFloor(fid, clear = false, notify = false) {
    const f = (floors || []).find((x) => x.id === fid) || (floors || [])[0];
    if (!f) return;
    currentFloorId = f.id;
    const sz = autoSizeByFloor.get(currentFloorId);
    if (sz) {
      setWrapAspectFor(sz);
      requestAnimationFrame(() => {
        layoutFit(sz);
        renderPoints(lastNodesForFloor, lastActiveId);
      });
    }
    img.src = `${basePath}/floors/${encodeURI(f.image || "")}`;
    if (clear) points.innerHTML = "";
    if (notify && typeof onFloorChange === "function") onFloorChange(currentFloorId);
    selectEl.value = currentFloorId;
  }

  img.onload = () => {
    const sz = autoSizeByFloor.get(currentFloorId);
    if (sz) {
      setWrapAspectFor(sz);
      layoutFit(sz);
    } else if (img.naturalWidth && img.naturalHeight) {
      autoSizeByFloor.set(currentFloorId, { w: img.naturalWidth, h: img.naturalHeight });
      setWrapAspectFor({ w: img.naturalWidth, h: img.naturalHeight });
      layoutFit({ w: img.naturalWidth, h: img.naturalHeight });
    }
    renderZones(lastZonesForFloor, lastActiveZoneId);
    renderPoints(lastNodesForFloor, lastActiveId);
    renderTorch();
  };
  addEventListener("resize", () => {
    const sz = autoSizeByFloor.get(currentFloorId);
    if (sz) layoutFit(sz);
    renderZones(lastZonesForFloor, lastActiveZoneId);
    renderPoints(lastNodesForFloor, lastActiveId);
    renderTorch();
  });

  function chooseMode(nodesForFloor, sz) {
    if (coordsMode !== "auto") return coordsMode;
    if (!nodesForFloor?.length || !sz) return "image";
    let minX = Infinity, maxX = -Infinity, minY = Infinity, maxY = -Infinity;
    for (const n of nodesForFloor) if (typeof n.x === "number" && typeof n.y === "number") {
      if (n.x < minX) minX = n.x; if (n.x > maxX) maxX = n.x;
      if (n.y < minY) minY = n.y; if (n.y > maxY) maxY = n.y;
    }
    // Heuristic: if any coordinate is near 0 or near the image edge, assume absolute image pixels
    const nearEdge = (v, max)=> (v<8 || (max-v)<8);
    const absEdge = nearEdge(minX, sz.w) || nearEdge(minY, sz.h) || nearEdge(maxX, sz.w) || nearEdge(maxY, sz.h);
    if (absEdge) return "image";
    const spanX = maxX - minX, spanY = maxY - minY;
    if (!(spanX > 0 && spanY > 0)) return "image";
    const ratioX = spanX / sz.w, ratioY = spanY / sz.h;
    return ratioX < 0.75 || ratioY < 0.75 ? "editor" : "image";
  }

  const fixedMode = mappingMode && mappingMode !== "auto" ? mappingMode : null;
  const decideMode = (nodesForFloor, sz) => fixedMode || chooseMode(nodesForFloor, sz);

  function mapXY(x, y, mode, sz){
    const drawnW = fit.clientWidth;
    const drawnH = fit.clientHeight;
    if (!drawnW || !drawnH || !sz) return { px: 0, py: 0 };
    if (mode === "editor"){
      // In editor mode, normalize by zone extents when available; fallback to nodes extents
      let minX = Infinity, maxX = -Infinity, minY = Infinity, maxY = -Infinity;
      if (lastZoneExtents && isFinite(lastZoneExtents.minX)){
        ({minX, maxX, minY, maxY} = lastZoneExtents);
      } else {
        for (const n of lastNodesForFloor) if (typeof n.x === "number" && typeof n.y === "number") {
          if (n.x < minX) minX = n.x; if (n.x > maxX) maxX = n.x;
          if (n.y < minY) minY = n.y; if (n.y > maxY) maxY = n.y;
        }
        if (!isFinite(minX) || !isFinite(minY) || maxX <= minX || maxY <= minY){ minX = 0; maxX = sz.w; minY = 0; maxY = sz.h; }
      }
      const insetX = drawnW * edgePadRatio;
      const insetY = drawnH * edgePadRatio;
      const nx = (x - minX) / (maxX - minX);
      const ny = (y - minY) / (maxY - minY);
      return { px: insetX + nx * (drawnW - 2 * insetX), py: insetY + ny * (drawnH - 2 * insetY) };
    }
    const cref = getCoordRef(currentFloorId);
    const org = getOrigin(currentFloorId);
    const refW = (cref && cref.w) ? cref.w : sz.w;
    const refH = (cref && cref.h) ? cref.h : sz.h;
    const nx = ((x - (org.x || 0)) / refW);
    const ny = ((y - (org.y || 0)) / refH);
    return { px: nx * drawnW, py: ny * drawnH };
  }

  function renderPoints(nodesForFloor, activeId) {
    lastNodesForFloor = nodesForFloor || [];
    lastActiveId = activeId || null;
    points.innerHTML = "";

    const sz = autoSizeByFloor.get(currentFloorId);
    if (!sz || !sz.w || !sz.h) return;

    const drawnW = fit.clientWidth;
    const drawnH = fit.clientHeight;
    if (!drawnW || !drawnH) return;

    const mode = decideMode(lastNodesForFloor, sz);

    const insetX = drawnW * edgePadRatio;
    const insetY = drawnH * edgePadRatio;

    const labelEntries = [];
    const dotEntries = [];
    const hasZoneLabels = zoneLabels.childElementCount > 0; // avoid duplicate labels when zones already labeled
    for (const n of lastNodesForFloor) {
      const { px: px0, py: py0 } = mapXY(n.x, n.y, mode, sz);
      let px = px0, py = py0;

      const nudge = getPad(currentFloorId);
      if (nudge?.x) px += nudge.x;
      if (nudge?.y) py += nudge.y;
      px = Math.max(0, Math.min(drawnW, px));
      py = Math.max(0, Math.min(drawnH, py));

      const dot = document.createElement("div");
      dot.className = "mini-point" + (n.id === activeId ? " active" : "");
      dot.style.left = px + "px";
      dot.style.top = py + "px";
      dot.title = n.label || n.name || n.id;
      dot.onclick = (ev) => { ev.stopPropagation(); onSelectNode?.(n.id); };
      points.appendChild(dot);
      dotEntries.push({ element: dot, px, py });

      if (!hasZoneLabels && (n.label || n.name)) {
        const lab = document.createElement("div");
        lab.className = "mini-label";
        lab.textContent = n.label || n.name || n.id;
        lab.style.left = px + "px";
        lab.style.top = py + "px";
        points.appendChild(lab);
        labelEntries.push({ element: lab, px, py, node: n });
      }
    }

    applyLabelLayout(labelEntries, drawnW, drawnH);
    labelEntries.forEach(item => {
      const { element, px, py, labelOffsetX = 0, labelOffsetY = 0 } = item;
      element.style.left = (px + labelOffsetX) + "px";
      element.style.top = (py + labelOffsetY) + "px";
    });

    // De-clutter dots with light repulsion, capped to small shifts
    if (dotEntries.length > 1){
      const MIN = 22, ITER_MAX = 36;
      for (let iter=0; iter<ITER_MAX; iter++){
        let moved=false;
        for (let i=0;i<dotEntries.length;i++){
          for (let j=i+1;j<dotEntries.length;j++){
            const a=dotEntries[i], b=dotEntries[j];
            const dx=b.px-a.px, dy=b.py-a.py; const d=Math.hypot(dx,dy);
            if (d<MIN){
              const push=(MIN-d)/2; const ang=d>1e-4?Math.atan2(dy,dx):Math.random()*Math.PI*2;
              const ox=Math.cos(ang)*push, oy=Math.sin(ang)*push;
              a.px=Math.max(0, Math.min(drawnW, a.px-ox));
              a.py=Math.max(0, Math.min(drawnH, a.py-oy));
              b.px=Math.max(0, Math.min(drawnW, b.px+ox));
              b.py=Math.max(0, Math.min(drawnH, b.py+oy));
              moved=true;
            }
          }
        }
        if (!moved) break;
      }
      dotEntries.forEach(d=>{ d.element.style.left = d.px + 'px'; d.element.style.top = d.py + 'px'; });
    }
  }

  function renderZones(zonesForFloor, activeZoneId){
    lastZonesForFloor = Array.isArray(zonesForFloor) ? zonesForFloor : [];
    lastActiveZoneId = activeZoneId || null;
    while (zonesSvg.firstChild) zonesSvg.removeChild(zonesSvg.firstChild);
    zoneLabels.innerHTML = "";

    const sz = autoSizeByFloor.get(currentFloorId);
    if (!sz || !sz.w || !sz.h) return;
    const drawnW = fit.clientWidth;
    const drawnH = fit.clientHeight;
    if (!drawnW || !drawnH) return;
    zonesSvg.setAttribute("viewBox", `0 0 ${drawnW} ${drawnH}`);
    zonesSvg.appendChild(torchPath);

    // Mode should follow points mapping
    const mode = decideMode(lastNodesForFloor, sz);

    // Compute and store zone extents for consistent editor mapping across polygons and dots
    if (mode === 'editor'){
      let minX = Infinity, maxX = -Infinity, minY = Infinity, maxY = -Infinity;
      for (const z of lastZonesForFloor){
        for (const p of (z.points||[])){
          const x = Number(p?.x); const y = Number(p?.y);
          if (!isFinite(x) || !isFinite(y)) continue;
          if (x < minX) minX = x; if (x > maxX) maxX = x;
          if (y < minY) minY = y; if (y > maxY) maxY = y;
        }
      }
      if (isFinite(minX) && isFinite(minY) && maxX > minX && maxY > minY){
        lastZoneExtents = { minX, maxX, minY, maxY };
      } else {
        lastZoneExtents = null;
      }
    } else {
      lastZoneExtents = null;
    }

    const labels = [];
    for (const z of lastZonesForFloor){
      const pts = Array.isArray(z.points) ? z.points : [];
      if (!pts.length) continue;
      const mapped = pts.map(p => mapXY(Number(p.x)||0, Number(p.y)||0, mode, sz));
      const d = mapped.map((p,i)=>`${i? 'L':'M'}${p.px},${p.py}`).join(' ') + ' Z';
      const path = document.createElementNS('http://www.w3.org/2000/svg','path');
      path.setAttribute('d', d);
      path.setAttribute('class', 'mini-zone' + (z.id===lastActiveZoneId ? ' active' : ''));
      path.addEventListener('click', (ev)=>{ ev.stopPropagation(); onSelectNode?.(z.id); });
      zonesSvg.appendChild(path);

      // Simple centroid for label placement
      let cx = 0, cy = 0; for (const p of mapped){ cx += p.px; cy += p.py; }
      cx /= mapped.length; cy /= mapped.length;
      const div = document.createElement('div');
      div.className = 'mini-label';
      div.textContent = z.label || z.name || z.id;
      div.style.left = `${cx}px`;
      div.style.top = `${cy}px`;
      // labels are absolutely positioned within zoneLabels container
      zoneLabels.appendChild(div);
      labels.push({ element: div, px: cx, py: cy });
    }
    // Adjust label positions to avoid collisions
    applyLabelLayout(labels, drawnW, drawnH);
    labels.forEach(item => {
      const { element, px, py, labelOffsetX = 0, labelOffsetY = 0 } = item;
      element.style.left = (px + labelOffsetX) + 'px';
      element.style.top = (py + labelOffsetY) + 'px';
    });
  }

  function renderTorch(){
    torchPath.setAttribute('d','');
    if (!lastTorch?.visible) return;
    const sz = autoSizeByFloor.get(currentFloorId);
    if (!sz || !sz.w || !sz.h) return;
    const mode = chooseMode(lastNodesForFloor, sz);
    const { px: cx, py: cy } = mapXY(lastTorch.x, lastTorch.y, mode, sz);
    const drawnW = fit.clientWidth, drawnH = fit.clientHeight;
    if (!drawnW || !drawnH) return;
    const len = Math.max(60, Math.min(140, Math.min(drawnW, drawnH) * 0.35));
    const spread = Math.PI / 5; // ~36 deg
    const a = lastTorch.yawRad || 0;
    const ax = Math.cos(a), ay = Math.sin(a);
    const lx = Math.cos(a - spread/2), ly = Math.sin(a - spread/2);
    const rx = Math.cos(a + spread/2), ry = Math.sin(a + spread/2);
    const p1 = [cx + lx*len, cy + ly*len];
    const p2 = [cx + ax*(len*0.9), cy + ay*(len*0.9)];
    const p3 = [cx + rx*len, cy + ry*len];
    const d = `M ${cx},${cy} L ${p1[0]},${p1[1]} L ${p2[0]},${p2[1]} L ${p3[0]},${p3[1]} Z`;
    torchPath.setAttribute('d', d);
  }

  selectEl.onchange = () => setActiveFloor(selectEl.value, true, true);

  if (floors?.[0]) {
    setActiveFloor(floors[0].id, true, false);
  }

  return {
    setActiveFloor,
    renderPoints,
    renderZones,
    setTorchPose: ({ floorId, x, y, yawRad = 0, visible = true } = {}) => {
      if (floorId && floorId !== currentFloorId) setActiveFloor(floorId, false, false);
      lastTorch = { x:Number(x)||0, y:Number(y)||0, yawRad:Number(yawRad)||0, visible: !!visible };
      renderTorch();
    },
    getCurrentFloorId: () => currentFloorId,
  };
}

function applyLabelLayout(entries, width, height) {
  if (!Array.isArray(entries) || !entries.length) return;
  const margin = 12;
  const labelHalfWidth = 68;
  const labelHalfHeight = 18;
  const baselineY = -(labelHalfHeight + 8);
  const positions = entries.map(entry => ({
    x: Math.max(margin + labelHalfWidth, Math.min(width - margin - labelHalfWidth, entry.px)),
    y: Math.max(margin + labelHalfHeight, Math.min(height - margin - labelHalfHeight, entry.py + baselineY))
  }));
  const MIN_DIST = 38;
  const ITER_MAX = 48;
  for (let iter = 0; iter < ITER_MAX; iter++) {
    let moved = false;
    for (let i = 0; i < positions.length; i++) {
      for (let j = i + 1; j < positions.length; j++) {
        const a = positions[i];
        const b = positions[j];
        const dx = b.x - a.x;
        const dy = b.y - a.y;
        const dist = Math.hypot(dx, dy);
        if (dist < MIN_DIST) {
          const push = (MIN_DIST - dist) / 2;
          const angle = dist > 0.0001 ? Math.atan2(dy, dx) : (Math.PI / 2) * (j % 2 ? 1 : -1);
          const offsetX = Math.cos(angle) * push;
          const offsetY = Math.sin(angle) * push;
          a.x = Math.max(margin + labelHalfWidth, Math.min(width - margin - labelHalfWidth, a.x - offsetX));
          a.y = Math.max(margin + labelHalfHeight, Math.min(height - margin - labelHalfHeight, a.y - offsetY));
          b.x = Math.max(margin + labelHalfWidth, Math.min(width - margin - labelHalfWidth, b.x + offsetX));
          b.y = Math.max(margin + labelHalfHeight, Math.min(height - margin - labelHalfHeight, b.y + offsetY));
          moved = true;
        }
      }
    }
    if (!moved) break;
  }
  entries.forEach((entry, idx) => {
    entry.labelOffsetX = positions[idx].x - entry.px;
    entry.labelOffsetY = positions[idx].y - entry.py;
  });
}
