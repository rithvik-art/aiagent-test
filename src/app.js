// Lazy-load heavy engine modules only when needed
// Note: dynamic imports create separate chunks and keep initial bundle light

const BASE_URL = (import.meta?.env?.BASE_URL ?? "/");
const BASE_TRIMMED = BASE_URL.endsWith("/") ? BASE_URL.slice(0, -1) : BASE_URL;
const EXPERIENCES_ROOT = `${BASE_TRIMMED || ""}/experiences`.replace(/\/{2,}/g, "/");
const EXPERIENCE_FALLBACK = [
  { id: "skywalk", label: "Skywalk" },
  { id: "flat", label: "Flat" },
  { id: "amenities", label: "Amenities" },
];
// Preload configuration (tunable via Vite env)
const PRELOAD_MODE = (import.meta?.env?.VITE_PRELOAD_MODE || 'auto').toLowerCase(); // 'auto' | 'all' | 'stage'
const PRELOAD_CONCURRENCY = Math.max(1, Number(import.meta?.env?.VITE_PRELOAD_CONCURRENCY) || 3);

const gate = document.getElementById("roleGate");
const roomInput = document.getElementById("roomInput");
const bottomBar = document.getElementById("bottomBar");
const expSelect = document.getElementById("expSelect");
const expSelectLive = document.getElementById("expSelectLive");
const gateList = document.getElementById("gateExpList");
const liveList = document.getElementById("expList");
const overlay = document.getElementById("preloadOverlay");
const barFill = document.getElementById("barFill");

function showOverlay(){ if (overlay){ overlay.setAttribute('aria-busy','true'); } }
function hideOverlay(){ if (overlay){ overlay.removeAttribute('aria-busy'); overlay.style.display='none'; } }
function setProgress(p){ const pct = Math.max(0, Math.min(100, Math.round(p*100))); if (barFill) barFill.style.width = `${pct}%`; }

// Listen for app-wide progress events from engine modules
addEventListener('loading:show', ()=>{ showOverlay(); setProgress(0); });
addEventListener('loading:progress', (ev)=>{ const d=ev?.detail||{}; setProgress(d.progress ?? 0); });
addEventListener('loading:hide', ()=>{ hideOverlay(); });

const btnGuide = document.getElementById("btnGuide");
const btnViewer = document.getElementById("btnViewer");
const btnUp = document.getElementById("btnUp");
const btnDown = document.getElementById("btnDown");
const btnLeft = document.getElementById("btnLeft");
const btnRight = document.getElementById("btnRight");
const btnZoomIn = document.getElementById("btnZoomIn");
const btnZoomOut = document.getElementById("btnZoomOut");
const btnFullscreen = document.getElementById("btnFullscreen");
// Legacy IDs from previous project UI (kept for parity)
const zoomInLegacy = document.getElementById("zoomIn");
const zoomOutLegacy = document.getElementById("zoomOut");
const btnFS = document.getElementById("btnFS");
const btnVR = document.getElementById("btnVR");
const btnMirror = document.getElementById("btnMirror");
const btnMini = document.getElementById("btnMini");
const btnAI = document.getElementById("btnAI");

const state = {
  manifest: [],
  manifestById: new Map(),
  activeExpId: null,
  agentApi: null,
  setGateExp: null,
  setLiveExp: null,
};

const STEP_YAW = 0.06;
const STEP_PITCH = 0.045;

// Global fullscreen helper so we can trigger it from role buttons
export async function enterFullscreenLandscape(){
  const d = document;
  const target = d.documentElement;
  const fsEl = d.fullscreenElement || d.webkitFullscreenElement || d.mozFullScreenElement || d.msFullscreenElement;
  try {
    if (fsEl) {
      await (d.exitFullscreen?.() || d.webkitExitFullscreen?.() || d.mozCancelFullScreen?.() || d.msExitFullscreen?.());
      document.body.classList.remove('fakefs');
      return;
    }
    if (target.requestFullscreen || target.webkitRequestFullscreen || target.mozRequestFullScreen || target.msRequestFullscreen) {
      await (target.requestFullscreen?.() || target.webkitRequestFullscreen?.() || target.mozRequestFullScreen?.() || target.msRequestFullscreen?.());
    } else {
      document.body.classList.toggle('fakefs');
    }
    if (screen?.orientation?.lock) {
      try { await screen.orientation.lock('landscape'); } catch {}
    }
    try { window.scrollTo(0, 1); } catch {}
  } catch (err) {
    document.body.classList.toggle('fakefs');
  }
}

function getQS() {
  try { return new URLSearchParams(window.location.search); } catch { return new URLSearchParams(); }
}

function experiencesRootPath() {
  return EXPERIENCES_ROOT.startsWith("/") ? EXPERIENCES_ROOT : `/${EXPERIENCES_ROOT}`;
}

function experienceAssetUrl(id, relative = "") {
  const cleanId = String(id || "").replace(/^\/+|\/+$/g, "");
  const suffix = relative ? `/${relative.replace(/^\/+/, "")}` : "";
  return `${experiencesRootPath()}/${cleanId}${suffix}`.replace(/\/{2,}/g, "/");
}

// WebP support detection (sync via canvas)
function supportsWebp() {
  try { const c = document.createElement('canvas'); return c.toDataURL && c.toDataURL('image/webp').indexOf('image/webp') !== -1; } catch { return false; }
}
function choosePanoPath(absUrl) {
  return (!supportsWebp() && /\.webp($|\?)/i.test(absUrl)) ? absUrl.replace(/\.webp(\?|$)/i, '.jpg$1') : absUrl;
}

async function loadManifest() {
  const manifestUrl = `${experiencesRootPath()}/manifest.json`.replace(/\/{2,}/g, "/");
  try {
    const res = await fetch(manifestUrl, { cache: "no-cache" });
    if (!res.ok) throw new Error(`Manifest request failed (${res.status})`);
    const payload = await res.json();
    const list = Array.isArray(payload?.experiences) ? payload.experiences : [];
    if (!list.length) return EXPERIENCE_FALLBACK;
    return list
      .map((item, index) => ({
        id: String(item?.id || "").trim() || EXPERIENCE_FALLBACK[0].id,
        label: (item?.label && String(item.label).trim()) || item?.id || EXPERIENCE_FALLBACK[0].label,
        order: Number.isFinite(item?.order) ? item.order : index,
        stereo: Boolean(item?.stereo),
      }))
      .sort((a, b) => (a.order ?? 0) - (b.order ?? 0) || a.label.localeCompare(b.label));
  } catch (err) {
    console.warn("[manifest] using fallback", err);
    return EXPERIENCE_FALLBACK;
  }
}

function wireCustomSelect({ wrapId, btnId, listId, labelId, selectId }) {
  const wrap = document.getElementById(wrapId);
  const btn = document.getElementById(btnId);
  const list = document.getElementById(listId);
  const label = document.getElementById(labelId);
  const select = document.getElementById(selectId);
  if (!wrap || !btn || !list || !label || !select) return () => {};

  function setValue(val, trigger = true) {
    select.value = val;
    const selectedOption = select.options[select.selectedIndex];
    label.textContent = selectedOption?.textContent || val;
    [...list.children].forEach((li) => {
      const active = li.getAttribute("data-value") === val;
      li.classList.toggle("active", active);
      li.setAttribute("aria-selected", active ? "true" : "false");
    });
    if (trigger) select.dispatchEvent(new Event("change", { bubbles: true }));
  }

  btn.addEventListener("click", () => {
    const open = wrap.getAttribute("data-open") === "true";
    wrap.setAttribute("data-open", open ? "false" : "true");
    btn.setAttribute("aria-expanded", (!open).toString());
  });

  list.addEventListener("click", (event) => {
    const li = event.target.closest?.("li[data-value]");
    if (!li) return;
    setValue(li.getAttribute("data-value"));
    wrap.setAttribute("data-open", "false");
    btn.setAttribute("aria-expanded", "false");
  });

  document.addEventListener("click", (event) => {
    if (!wrap.contains(event.target)) {
      wrap.setAttribute("data-open", "false");
      btn.setAttribute("aria-expanded", "false");
    }
  });

  return setValue;
}

function populateSelect(selectEl, listEl, experiences, activeId) {
  if (!selectEl || !listEl) return;
  selectEl.innerHTML = "";
  listEl.innerHTML = "";

  experiences.forEach((exp, index) => {
    const option = document.createElement("option");
    option.value = exp.id;
    option.textContent = exp.label;
    if (exp.id === activeId || (!activeId && index === 0)) option.selected = true;
    selectEl.appendChild(option);

    const li = document.createElement("li");
    li.dataset.value = exp.id;
    li.role = "option";
    li.textContent = exp.label;
    li.setAttribute("aria-selected", exp.id === activeId ? "true" : "false");
    if (exp.id === activeId) li.classList.add("active");
    listEl.appendChild(li);
  });
}

function normaliseExpId(id) {
  return String(id || "").trim() || EXPERIENCE_FALLBACK[0].id;
}

async function fetchWalkthrough(expId) {
  const url = experienceAssetUrl(expId, "walkthrough.json");
  const response = await fetch(url, { cache: "no-cache" });
  const text = await response.text();
  if (!response.ok) throw new Error(`walkthrough.json fetch failed (${response.status}) at ${url}`);
  try { return JSON.parse(text); }
  catch { throw new Error(`Expected JSON at ${url}, got: ${text.slice(0, 80)}`); }
}

function preloadImages(urls, onProgress, concurrency = 2) {
  return new Promise((resolve) => {
    const total = urls.length;
    if (total === 0) {
      onProgress(1, 0, 0);
      return resolve();
    }
    let done = 0, errs = 0, idx = 0, inFlight = 0;
    function next() {
      if (done + errs >= total) { resolve(); return; }
      while (inFlight < concurrency && idx < total) {
        const url = urls[idx++];
        inFlight++;
        const img = new Image();
        img.onload = () => { inFlight--; done++; onProgress((done + errs) / total, done, errs); next(); };
        img.onerror = () => { inFlight--; errs++; onProgress((done + errs) / total, done, errs); next(); };
        img.decoding = "async";
        img.loading = "eager";
        img.src = url;
      }
    }
    next();
  });
}

// Streaming preloader with byte-level progress (smoother progress on slow links)
async function preloadImagesStreaming(urls, onProgress, concurrency = 3) {
  const total = urls.length;
  if (total === 0) { onProgress?.(1); return; }
  let active = 0, idx = 0, done = 0;
  let totalKnown = 0, loadedKnown = 0;

  const queue = urls.slice();

  function report() {
    const countFrac = total ? done / total : 1;
    const byteFrac = totalKnown > 0 ? (loadedKnown / totalKnown) : 0;
    const progress = Math.max(0, Math.min(1, byteFrac * 0.7 + countFrac * 0.3));
    onProgress?.(progress);
  }

  await new Promise((resolve) => {
    function next() {
      if (done >= total && active === 0) { report(); resolve(); return; }
      while (active < concurrency && idx < total) {
        const url = queue[idx++];
        active++;
        (async () => {
          try {
            const res = await fetch(url, { cache: 'force-cache' });
            const contentType = res.headers.get('content-type') || 'image/jpeg';
            const reader = res.body?.getReader?.();
            let expected = Number(res.headers.get('content-length')) || 0;
            if (expected > 0) totalKnown += expected;
            let received = 0;
            const chunks = [];
            if (reader) {
              while (true) {
                const { done: rdone, value } = await reader.read();
                if (rdone) break;
                chunks.push(value);
                received += value.byteLength;
                if (expected > 0) { loadedKnown += value.byteLength; report(); }
              }
            }
            const blob = reader ? new Blob(chunks, { type: contentType }) : await res.blob();
            // Decode image to ensure it can be displayed without jank later
            let objectUrl = '';
            try {
              if ('createImageBitmap' in window && typeof createImageBitmap === 'function') {
                await createImageBitmap(blob);
              } else {
                await new Promise((res2, rej2) => {
                  const img = new Image();
                  img.onload = () => { try { URL.revokeObjectURL(objectUrl); } catch {} res2(); };
                  img.onerror = (e) => { try { URL.revokeObjectURL(objectUrl); } catch {} rej2(e); };
                  objectUrl = URL.createObjectURL(blob);
                  img.src = objectUrl;
                });
              }
            } catch {}
          } catch {}
          finally {
            done++; report();
            active--; next();
          }
        })();
      }
    }
    next();
  });
}

function getNetworkProfile() {
  try {
    const conn = navigator.connection || navigator.webkitConnection || navigator.mozConnection;
    const effective = String(conn?.effectiveType || '').toLowerCase();
    const saveData = Boolean(conn?.saveData);
    const slow = /^(slow-)?2g|3g$/.test(effective);
    const isMobile = /Android|iPhone|iPad|iPod|Quest|Oculus/i.test(navigator.userAgent);
    return { conn, effective, saveData, slow, isMobile };
  } catch { return { conn: null, effective: '', saveData: false, slow: false, isMobile: false }; }
}

async function preloadExperience(expId) {
  // Keep the overlay visible across the entire boot; app will hide it
  // only after the engine is fully initialized and first frame is ready.
  showOverlay();
  setProgress(0);

  const data = await fetchWalkthrough(expId);
  const files = Array.from(new Set((data?.nodes || []).map((node) => choosePanoPath(experienceAssetUrl(expId, `panos/${node.file}`)))));

  // Preload hint for the very first pano
  const head = document.head || document.getElementsByTagName('head')[0];
  if (files[0] && head) {
    try {
      const link = document.createElement('link');
      link.rel = 'preload'; link.as = 'image'; link.href = files[0];
      link.fetchPriority = 'high';
      head.appendChild(link);
    } catch {}
  }

  // Ask SW (if present) to precache everything; it will no-op if not ready
  try { navigator.serviceWorker?.controller?.postMessage({ type: 'precache', urls: files }); } catch {}

  // Smoothing wrapper so the bar moves continuously even when sizes are unknown
  let uiProgress = 0, target = 0, rafId = null; let lastUpdate = performance.now();
  function tick() {
    if (uiProgress >= 0.999 && target >= 0.999) { uiProgress = 1; try { dispatchEvent(new CustomEvent('loading:progress', { detail: { progress: 1 } })); } catch {} rafId = null; return; }
    const delta = Math.max(0.002, (target - uiProgress) * 0.18);
    if (target > uiProgress) { uiProgress = Math.min(0.995, uiProgress + delta); try { dispatchEvent(new CustomEvent('loading:progress', { detail: { progress: uiProgress } })); } catch {} }
    rafId = requestAnimationFrame(tick);
  }
  function onRawProgress(p) {
    target = Math.max(target, Math.min(0.995, p));
    lastUpdate = performance.now();
    if (!rafId) rafId = requestAnimationFrame(tick);
  }
  // Trickle toward completion if network doesn’t expose byte sizes
  const trickle = setInterval(() => {
    if (performance.now() - lastUpdate > 700) {
      target = Math.min(0.9, target + 0.01);
      if (!rafId) rafId = requestAnimationFrame(tick);
    }
  }, 300);

  // Adaptive strategy for slow connections
  const { saveData, slow, isMobile } = getNetworkProfile();
  let mode = PRELOAD_MODE;
  if (mode !== 'all' && mode !== 'stage') mode = (saveData || slow) ? 'stage' : 'all';
  const stageCount = mode === 'all' ? files.length : (saveData || slow ? 1 : (isMobile ? 2 : 3));
  const stageList = files.slice(0, Math.min(files.length, stageCount));
  const restList = files.slice(stageList.length);

  await preloadImagesStreaming(stageList, onRawProgress, PRELOAD_CONCURRENCY);
  if (mode === 'all' && restList.length) {
    await preloadImagesStreaming(restList, onRawProgress, Math.max(1, PRELOAD_CONCURRENCY - 1));
  } else if (restList.length) {
    // Background warm cache of remaining panos; no need to await
    preloadImagesStreaming(restList, () => {}, 2).catch(()=>{});
  }

  // Finish bar to 100% (engine init will hide overlay after first frame)
  clearInterval(trickle);
  target = 1; if (!rafId) rafId = requestAnimationFrame(tick);
}

function holdRepeat(el, fn, firstDelay = 230, interval = 45) {
  if (!el) return;
  let timeout = null;
  let repeat = null;
  const start = (event) => {
    if (event.isPrimary === false) return;
    event.preventDefault();
    el.setPointerCapture?.(event.pointerId);
    if (timeout || repeat) return;
    fn();
    timeout = setTimeout(() => {
      repeat = setInterval(fn, interval);
    }, firstDelay);
  };
  const stop = (event) => {
    if (repeat) clearInterval(repeat);
    if (timeout) clearTimeout(timeout);
    repeat = null;
    timeout = null;
    try { el.releasePointerCapture?.(event.pointerId); } catch {}
  };
  el.addEventListener("pointerdown", start, { passive: false });
  el.addEventListener("pointerup", stop);
  el.addEventListener("pointercancel", stop);
  el.addEventListener("pointerleave", stop);
}

function syncActiveExperience(id, { syncLive = true, syncGate = false } = {}) {
  state.activeExpId = id;
  if (syncGate && state.setGateExp) state.setGateExp(id, false);
  if (syncLive && state.setLiveExp) state.setLiveExp(id, false);
}

function getSelectedExperience() {
  const id = normaliseExpId(expSelect?.value || state.activeExpId);
  return state.manifestById.get(id) || { id, label: id };
}

async function startGuide() {
  const { id } = getSelectedExperience();
  syncActiveExperience(id, { syncGate: true, syncLive: true });
  // Use stub to avoid breaking dev if agent.js is unavailable
  const importPromise = import("./engine/agent.js");
  // Attempt fullscreen + landscape early (user gesture)
  void enterFullscreenLandscape();
  await preloadExperience(id);

  const roomId = roomInput?.value?.trim() || "demo";
  gate?.remove();
  if (bottomBar) bottomBar.hidden = false;
  
  // Engine chunk + init; overlay remains visible from preload until we're fully ready
  const { initAgent } = await importPromise;
  state.agentApi = await initAgent({ roomId, exp: id, experiencesMeta: state.manifest });
  // If a persisted mirror pitch sign exists (for field calibration), apply it
  try {
    const savedPitch = Number(localStorage.getItem('mirrorPitchSign'));
    if (savedPitch===1||savedPitch===-1) state.agentApi?.setMirrorPitchSign?.(savedPitch);
  } catch {}
  // Apply persisted yaw sign if present
  try {
    const savedYaw = Number(localStorage.getItem('mirrorYawSign'));
    if (savedYaw===1||savedYaw===-1) state.agentApi?.setMirrorYawSign?.(savedYaw);
  } catch {}
  // Now the first frame is ready; hide the loader.
  dispatchEvent(new CustomEvent('loading:hide'));
}

async function startViewer() {
  const { id } = getSelectedExperience();
  syncActiveExperience(id, { syncGate: true, syncLive: true });
  const importPromise = import("./engine/viewer.js");
  // Attempt fullscreen + landscape early (user gesture)
  void enterFullscreenLandscape();
  await preloadExperience(id);

  const roomId = roomInput?.value?.trim() || "demo";
  gate?.remove();
  if (bottomBar) bottomBar.hidden = true;
  state.agentApi = null;
  const { initViewer } = await importPromise;
  await initViewer({ roomId, exp: id, experiencesMeta: state.manifest });
  dispatchEvent(new CustomEvent('loading:hide'));
}

async function startAI() {
  const { id } = getSelectedExperience();
  syncActiveExperience(id, { syncGate: true, syncLive: true });
  const importPromise = import("./engine/ai-agent.js");
  // Attempt fullscreen + landscape early (user gesture)
  void enterFullscreenLandscape();
  await preloadExperience(id);
  const roomId = roomInput?.value?.trim() || "demo";
  gate?.remove();
  if (bottomBar) bottomBar.hidden = false;
  const { initAIAgent } = await importPromise;
  state.agentApi = await initAIAgent({ roomId, exp: id, experiencesMeta: state.manifest });
  dispatchEvent(new CustomEvent('loading:hide'));
}

async function onLiveExperienceChange() {
  const nextId = normaliseExpId(expSelectLive?.value);
  syncActiveExperience(nextId, { syncGate: false, syncLive: true });
  await preloadExperience(nextId);
  if (state.agentApi?.switchExperience) {
    state.agentApi.switchExperience(nextId);
  }
  // After switching, hide the loader since textures are already cached
  dispatchEvent(new CustomEvent('loading:hide'));
}

async function bootstrap() {
  // Enhance buttons: larger fullscreen icon and tooltips across controls
  const setTip = (el, text) => { if (el){ el.setAttribute('title', text); el.setAttribute('data-tip', text); } };
  try {
    const fsSvg = '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M4 9V4h5"/><path d="M20 9V4h-5"/><path d="M4 15v5h5"/><path d="M20 15v5h-5"/></svg>';
    const upSvg = '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M12 7l-5 5h10z"/></svg>';
    const downSvg = '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M12 17l5-5H7z"/></svg>';
    const leftSvg = '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M8 12l6-6v12z"/></svg>';
    const rightSvg = '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M16 12l-6 6V6z"/></svg>';

    const fsBtn = document.getElementById('btnFS');
    if (fsBtn) { fsBtn.innerHTML = fsSvg; setTip(fsBtn, 'Fullscreen'); }
    if (btnUp)    { btnUp.innerHTML = upSvg;    setTip(btnUp,    'Look up'); }
    if (btnDown)  { btnDown.innerHTML = downSvg;  setTip(btnDown,  'Look down'); }
    if (btnLeft)  { btnLeft.innerHTML = leftSvg;  setTip(btnLeft,  'Look left'); }
    if (btnRight) { btnRight.innerHTML = rightSvg; setTip(btnRight, 'Look right'); }
    if (btnMini)   setTip(btnMini,   'Toggle minimap');
    if (btnMirror) setTip(btnMirror, 'Switch view');
    if (zoomInLegacy)  setTip(zoomInLegacy,  'Zoom in');
    if (zoomOutLegacy) setTip(zoomOutLegacy, 'Zoom out');
  } catch {}
  state.setLiveExp = wireCustomSelect({ wrapId: "expSelectLiveWrap", btnId: "expBtn", listId: "expList", labelId: "expLabel", selectId: "expSelectLive" });
  state.setGateExp = wireCustomSelect({ wrapId: "gateExpWrap", btnId: "gateExpBtn", listId: "gateExpList", labelId: "gateExpLabel", selectId: "expSelect" });

  state.manifest = await loadManifest();
  state.manifestById = new Map(state.manifest.map((exp) => [exp.id, exp]));
  const initialId = normaliseExpId(state.manifest[0]?.id);
  state.activeExpId = initialId;

  populateSelect(expSelect, gateList, state.manifest, initialId);
  populateSelect(expSelectLive, liveList, state.manifest, initialId);

  if (state.setGateExp) state.setGateExp(initialId, false);
  if (state.setLiveExp) state.setLiveExp(initialId, false);

  // Background prefetch of engine code on decent networks to speed first click
  try {
    const conn = navigator.connection || navigator.webkitConnection || navigator.mozConnection;
    const slow = /^(2g|slow-2g|3g)$/i.test(conn?.effectiveType || "");
    const save = Boolean(conn?.saveData);
    if (!slow && !save) {
      // Only prefetch viewer to avoid pulling agent bundle when not needed
      setTimeout(() => { import("./engine/viewer.js").catch(()=>{}); }, 600);
    }
  } catch {}

  // auto-start by querystring
  const qs = getQS();
  const wantRole = (qs.get('role')||'').toLowerCase();
  const qsExp = qs.get('exp');
  const qsRoom = qs.get('room');
  if (qsRoom) roomInput.value = qsRoom;
  if (qsExp && state.manifestById.has(qsExp)) {
    state.activeExpId = qsExp; state.setGateExp?.(qsExp,false); state.setLiveExp?.(qsExp,false);
  }
  if (wantRole === 'viewer') { await startViewer(); return; }
  if (wantRole === 'guide') { await startGuide(); return; }

  expSelect?.addEventListener("change", () => {
    const val = normaliseExpId(expSelect.value);
    syncActiveExperience(val, { syncGate: false, syncLive: false });
    if (state.setLiveExp) state.setLiveExp(val, false);
  });

  expSelectLive?.addEventListener("change", () => onLiveExperienceChange().catch(console.error));
  btnGuide?.addEventListener("click", () => startGuide().catch(console.error));
  btnViewer?.addEventListener("click", () => startViewer().catch(console.error));
  btnAI?.addEventListener("click", () => startAI().catch(console.error));

  holdRepeat(btnLeft, () => state.agentApi?.nudgeYaw?.(-STEP_YAW));
  holdRepeat(btnRight, () => state.agentApi?.nudgeYaw?.(STEP_YAW));
  holdRepeat(btnUp, () => state.agentApi?.nudgePitch?.(STEP_PITCH));
  holdRepeat(btnDown, () => state.agentApi?.nudgePitch?.(-STEP_PITCH));

  // Zoom (support both new and legacy ids)
  btnZoomIn?.addEventListener("click", () => state.agentApi?.adjustFov?.(-0.05));
  btnZoomOut?.addEventListener("click", () => state.agentApi?.adjustFov?.(0.05));
  zoomInLegacy?.addEventListener("click", () => state.agentApi?.adjustFov?.(-0.05));
  zoomOutLegacy?.addEventListener("click", () => state.agentApi?.adjustFov?.(0.05));

  // Minimap + Mirror + VR
  btnMini?.addEventListener("click", () => state.agentApi?.toggleMinimap?.());
  // Repurpose mirror button to swap primary/secondary views (normal vs mirror)
  btnMirror?.addEventListener("click", () => state.agentApi?.switchView?.());
  // Optional quick keys for mirror calibration in the field:
  //  - Shift+V toggles pitch sign
  //  - Shift+Y toggles yaw sign
  window.addEventListener('keydown', (e)=>{
    if (!e.shiftKey) return;
    if (e.key==='V' || e.key==='v'){
      state.agentApi?.toggleMirrorPitchSign?.();
      try{ const cur=Number(localStorage.getItem('mirrorPitchSign'))||1; localStorage.setItem('mirrorPitchSign', String(-cur)); }catch{}
    }
    if (e.key==='Y' || e.key==='y'){
      state.agentApi?.toggleMirrorYawSign?.();
      try{ const cur=Number(localStorage.getItem('mirrorYawSign'))||1; localStorage.setItem('mirrorYawSign', String(-cur)); }catch{}
    }
  });
  btnVR?.addEventListener("click", () => state.agentApi?.toggleXR?.());

  // Fullscreen with iOS-friendly behavior
  btnFullscreen?.addEventListener("click", enterFullscreenLandscape);
  btnFS?.addEventListener("click", enterFullscreenLandscape);

  window.addEventListener("keydown", (event) => {
    if (!state.agentApi) return;
    if (event.key === "ArrowLeft") state.agentApi.nudgeYaw?.(-STEP_YAW);
    if (event.key === "ArrowRight") state.agentApi.nudgeYaw?.(STEP_YAW);
    if (event.key === "ArrowUp") {
      event.preventDefault();
      state.agentApi.nudgePitch?.(STEP_PITCH);
    }
    if (event.key === "ArrowDown") {
      event.preventDefault();
      state.agentApi.nudgePitch?.(-STEP_PITCH);
    }
  }, { passive: false });
}

bootstrap().catch((err) => console.error("[app] bootstrap failed", err));


















