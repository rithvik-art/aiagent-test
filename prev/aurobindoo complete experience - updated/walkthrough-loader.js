/* -------- walkthrough-loader.js -------- */

export async function loadWalkthrough(url = "./walkthrough.json") {
  const r = await fetch(url);
  if (!r.ok) throw new Error(`walkthrough.json fetch failed: ${r.status} ${r.statusText}`);
  let raw;
  try { raw = await r.json(); } catch { throw new Error("walkthrough.json is not valid JSON"); }

  const candidate = (raw && (raw.data || raw.project)) || raw || {};
  const floors = Array.isArray(candidate.floors) ? candidate.floors : [];
  const nodesIn = Array.isArray(candidate.nodes) ? candidate.nodes : [];

  const nodes = nodesIn.map((n, i) => {
    const id =
      (typeof n.id === "string" && n.id) ||
      (typeof crypto !== "undefined" && crypto.randomUUID ? crypto.randomUUID() : `node-${i + 1}`);
    const hotspots = Array.isArray(n.hotspots)
      ? n.hotspots.map(h => ({
          to: h?.to, type: h?.type || "walk",
          yaw: typeof h?.yaw === "number" ? h.yaw : 0,
          pitch: typeof h?.pitch === "number" ? h.pitch : 0,
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
      hotspots,
    };
  });

  const nodesById = new Map(nodes.map(n => [n.id, n]));
  let startNodeId = candidate.startNodeId;
  if (!startNodeId || !nodesById.has(startNodeId)) startNodeId = nodes[0]?.id ?? null;

  return { data: { floors, nodes, startNodeId }, nodesById, startNodeId };
}

/* -------- Minimap (uses basePath for ./<exp>/floors/) -------- */
export function buildMinimapDOM({
  floors,
  basePath = ".",            // IMPORTANT: pass the experience folder here
  padByFloor,
  coordsMode = "auto",
  edgePadRatio = 0.06,
  ui = "dropdown",
  panelWidth = "min(28vw, 420px)",
  position = "top-right",
  paddingPx = 14,
  onSelectNode,
  onFloorChange,
  container,
} = {}) {
  if (!document.getElementById("mini-style-override")) {
    const st = document.createElement("style");
    st.id = "mini-style-override";
    st.textContent = `
      .mini-wrap{position:absolute; top:18px; z-index:30; width:var(--mini-width,360px)}
      .mini-wrap.pos-right{right:18px} .mini-wrap.pos-left{left:18px}
      .mini-bar{display:flex; gap:8px; margin-bottom:10px}
      .mini-select{flex:1; padding:10px 12px; border-radius:12px; border:1px solid #2a3242; background:#1b2233; color:#e8eaf0}
      .mini-img-wrap{position:relative; background:rgba(15,20,32,.78); border:1px solid #2a3242; border-radius:14px}
      .mini-content{position:absolute; inset:var(--pad,14px)}
      .mini-fit{position:absolute; left:50%; top:50%; transform:translate(-50%,-50%)}
      .mini-img{position:absolute; inset:0; width:100%; height:100%; object-fit:fill; border-radius:10px}
      .mini-points{position:absolute; inset:0; pointer-events:none}
      .mini-point{position:absolute; width:12px; height:12px; margin:-6px 0 0 -6px; background:#ffd166; border-radius:50%;
                  box-shadow:0 0 0 2px rgba(8,10,15,.55), 0 0 0 5px rgba(255,209,102,.32); pointer-events:auto}
      .mini-point.active{background:#06d6a0; box-shadow:0 0 0 2px rgba(8,10,15,.65), 0 0 0 5px rgba(6,214,160,.35)}
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
  const points = document.createElement("div");
  points.className = "mini-points";

  fit.appendChild(img);
  fit.appendChild(points);
  content.appendChild(fit);
  imgWrap.appendChild(content);
  wrap.appendChild(imgWrap);
  (container || document.body).appendChild(wrap);

  const autoSizeByFloor = new Map();
  const isMap = (m) => m && typeof m.get === "function";
  const getPad = (fid) => (isMap(padByFloor) && padByFloor.get(fid)) || { x: 0, y: 0 };

  // Preload all floor images using basePath
  (floors || []).forEach((f) => {
    const im = new Image();
    im.onload = () => {
      autoSizeByFloor.set(f.id, { w: im.naturalWidth, h: im.naturalHeight });
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
    renderPoints(lastNodesForFloor, lastActiveId);
  };
  addEventListener("resize", () => {
    const sz = autoSizeByFloor.get(currentFloorId);
    if (sz) layoutFit(sz);
    renderPoints(lastNodesForFloor, lastActiveId);
  });

  function chooseMode(nodesForFloor, sz) {
    if (coordsMode !== "auto") return coordsMode;
    if (!nodesForFloor?.length || !sz) return "image";
    let minX = Infinity, maxX = -Infinity, minY = Infinity, maxY = -Infinity;
    for (const n of nodesForFloor) if (typeof n.x === "number" && typeof n.y === "number") {
      if (n.x < minX) minX = n.x; if (n.x > maxX) maxX = n.x;
      if (n.y < minY) minY = n.y; if (n.y > maxY) maxY = n.y;
    }
    const spanX = maxX - minX, spanY = maxY - minY;
    if (!(spanX > 0 && spanY > 0)) return "image";
    const ratioX = spanX / sz.w, ratioY = spanY / sz.h;
    return ratioX < 0.75 || ratioY < 0.75 ? "editor" : "image";
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

    const mode = chooseMode(lastNodesForFloor, sz);

    let minX = Infinity, maxX = -Infinity, minY = Infinity, maxY = -Infinity;
    if (mode === "editor") {
      for (const n of lastNodesForFloor) if (typeof n.x === "number" && typeof n.y === "number") {
        if (n.x < minX) minX = n.x; if (n.x > maxX) maxX = n.x;
        if (n.y < minY) minY = n.y; if (n.y > maxY) maxY = n.y;
      }
      if (!isFinite(minX) || !isFinite(minY) || maxX <= minX || maxY <= minY) {
        minX = 0; maxX = sz.w; minY = 0; maxY = sz.h;
      }
    }

    const insetX = drawnW * edgePadRatio;
    const insetY = drawnH * edgePadRatio;

    for (const n of lastNodesForFloor) {
      let px, py;
      if (mode === "editor") {
        const nx = (n.x - minX) / (maxX - minX);
        const ny = (n.y - minY) / (maxY - minY);
        px = insetX + nx * (drawnW - 2 * insetX);
        py = insetY + ny * (drawnH - 2 * insetY);
      } else {
        px = (n.x / sz.w) * drawnW;
        py = (n.y / sz.h) * drawnH;
      }

      const nudge = getPad(currentFloorId);
      if (nudge?.x) px += nudge.x;
      if (nudge?.y) py += nudge.y;

      const dot = document.createElement("div");
      dot.className = "mini-point" + (n.id === activeId ? " active" : "");
      dot.style.left = px + "px";
      dot.style.top = py + "px";
      dot.title = n.id;
      dot.onclick = (ev) => { ev.stopPropagation(); onSelectNode?.(n.id); };
      points.appendChild(dot);
    }
  }

  selectEl.onchange = () => setActiveFloor(selectEl.value, true, true);

  if (floors?.[0]) {
    setActiveFloor(floors[0].id, true, false);
  }

  return {
    setActiveFloor,
    renderPoints,
    getCurrentFloorId: () => currentFloorId,
  };
}
