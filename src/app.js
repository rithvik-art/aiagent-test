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
const exitFSBtn = document.getElementById("exitFSBtn");
const rotateOverlay = document.getElementById("rotateOverlay");
const tapStartBtn = document.getElementById("tapStart");

const UA = (navigator.userAgent || "").toLowerCase();
const IS_IOS = /iphone|ipad|ipod|ios/.test(UA);
const IS_ANDROID = /android/.test(UA);
const IS_MOBILE = /android|iphone|ipad|ipod|mobile|crios|fxios/.test(UA);
let LAST_GESTURE_AT = 0;

function updateHtmlFlags() {
  try {
    const el = document.documentElement;
    const w = Math.max(window.innerWidth || 0, document.documentElement.clientWidth || 0);
    const h = Math.max(window.innerHeight || 0, document.documentElement.clientHeight || 0);
    const orient = (w >= h) ? 'landscape' : 'portrait';
    el.setAttribute('data-orient', orient);
    const device = IS_MOBILE ? (Math.min(w, h) <= 820 ? 'phone' : 'tablet') : 'desktop';
    el.setAttribute('data-device', device);
  } catch {}
}

function isFullscreenActive() {
  const d = document;
  return Boolean(
    d.fullscreenElement || d.webkitFullscreenElement || d.mozFullScreenElement || d.msFullscreenElement ||
    document.body.classList.contains('fakefs') || document.body.getAttribute('data-xr') === '1'
  );
}

function updateFSButtonVisibility() {
  try { if (exitFSBtn) exitFSBtn.style.display = isFullscreenActive() ? '' : 'none'; } catch {}
}

function attemptAutoFullscreenIfLandscape(){
  try{
    const el = document.documentElement;
    const orient = el.getAttribute('data-orient') || '';
    if (orient !== 'landscape') return;
    const recently = (Date.now() - LAST_GESTURE_AT) < 60000; // 60s window
    const allowed = recently || (sessionStorage.getItem('autoFs') === '1');
    if (!isFullscreenActive() && allowed){ void enterFullscreenLandscape(); }
  }catch{}
}

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
const btnMirror = document.getElementById("btnMirror");
const btnMini = document.getElementById("btnMini");
// Tour controls
const tourStartBtn = document.getElementById('tourStart');
const tourPauseBtn = document.getElementById('tourPause');
const tourPrevBtn  = document.getElementById('tourPrev');
const tourNextBtn  = document.getElementById('tourNext');
const tourStopBtn  = document.getElementById('tourStop');

const state = {
  manifest: [],
  manifestById: new Map(),
  activeExpId: null,
  agentApi: null,
  setGateExp: null,
  setLiveExp: null,
  tour: null,
  boundExperienceListener: false,
  zoneNavigateListener: null,
};

const STEP_YAW = 0.06;
const STEP_PITCH = 0.045;

function createTourVoiceControl(){
  const Recognition = window.SpeechRecognition || window.webkitSpeechRecognition;
  if (!Recognition) {
    return {
      attach: () => {},
      handleEvent: () => {},
      ensureListening: () => {}
    };
  }
  let recognition = null;
  let listening = false;
  let shouldRestart = false;
  let attachedTour = null;
  let attachedAgent = null;
  let lastCommand = { text: "", at: 0 };

  function ensure(){
    if (recognition) return recognition;
    recognition = new Recognition();
    recognition.continuous = true;
    recognition.interimResults = false;
    recognition.maxAlternatives = 1;
    recognition.lang = navigator.language || "en-US";
    recognition.onresult = handleResult;
    recognition.onerror = handleError;
    recognition.onend = handleEnd;
    return recognition;
  }

  function startListening(){
    if (!attachedTour) return;
    const inst = ensure();
    shouldRestart = true;
    if (listening) return;
    try {
      inst.start();
      listening = true;
    } catch (err) {
      if (err?.name === "InvalidStateError") {
        listening = true;
      } else {
        console.warn("[tour-voice] start failed", err);
      }
    }
  }

  function stopListening(){
    shouldRestart = false;
    if (!recognition) { listening = false; return; }
    try { recognition.stop(); } catch {}
    listening = false;
  }

  function handleEnd(){
    listening = false;
    if (shouldRestart && attachedTour) {
      setTimeout(startListening, 400);
    }
  }

  function handleError(ev){
    if (!ev) return;
    if (ev.error === "not-allowed" || ev.error === "service-not-allowed") {
      shouldRestart = false;
      listening = false;
    } else {
      console.warn("[tour-voice] error", ev.error);
    }
  }

  function handleResult(event){
    const results = event?.results;
    if (!results || !results.length) return;
    const res = results[results.length - 1];
    if (!res?.isFinal) return;
    const transcript = (res[0]?.transcript || "").trim();
    if (!transcript) return;
    interpret(transcript);
  }

  function interpret(raw){
    if (!attachedTour) return;
    const normalized = raw.toLowerCase().replace(/[^a-z0-9\s]/g, " ").replace(/\s+/g, " ").trim();
    if (!normalized) return;
    const now = Date.now();
    if (normalized === lastCommand.text && (now - lastCommand.at) < 1200) return;
    lastCommand = { text: normalized, at: now };

    const tour = attachedTour;
    const isPlaying = typeof tour?.isPlaying === "function" ? tour.isPlaying() : false;
    const runAsync = (fn) => {
      try {
        const result = fn?.();
        if (result && typeof result.then === "function") result.catch(()=>{});
      } catch {}
    };
    const agent = attachedAgent;

    if (/\brestart\b/.test(normalized)) {
      runAsync(() => { tour.stop?.(); });
      setTimeout(() => { if (attachedTour === tour) runAsync(() => tour.start?.()); }, 500);
      return;
    }
    if (/\b(next\s+zone|zone\s+next|advance\s+zone|change\s+zone)\b/.test(normalized)) { runAsync(() => agent?.goToNextInZone?.()); return; }
    if (/\b(prev(ious)?\s+zone|zone\s+back|zone\s+previous)\b/.test(normalized)) { runAsync(() => agent?.goToPrevInZone?.()); return; }
    if (/\b(previous|go back|back|prior)\b/.test(normalized) && !/\bzone\b/.test(normalized)) { runAsync(() => tour.prev?.()); return; }
    if (/\b(next|forward|advance|skip)\b/.test(normalized) && !/\bzone\b/.test(normalized)) { runAsync(() => tour.next?.()); return; }
    if (/\b(stop|end tour|exit tour|quit)\b/.test(normalized)) { runAsync(() => tour.stop?.()); return; }
    if (/\b(pause|hold)\b/.test(normalized)) { if (isPlaying) runAsync(() => tour.pause?.()); return; }
    if (/\b(resume|continue)\b/.test(normalized)) { if (!isPlaying) runAsync(() => tour.resume?.()); return; }
    if (/\b(play|start|begin|autoplay)\b/.test(normalized)) {
      if (typeof tour.getIndex === "function" && tour.getIndex() < 0 && typeof tour.start === "function") {
        runAsync(() => tour.start());
      } else if (!isPlaying && typeof tour.resume === "function") {
        runAsync(() => tour.resume());
      }
      return;
    }
  }

  return {
    attach(tour, agentApi){
      attachedTour = tour || null;
      if (agentApi !== undefined) attachedAgent = agentApi || null;
      if (!attachedTour) {
        stopListening();
        recognition = null;
        return;
      }
      ensure();
      startListening();
    },
    setAgentApi(api){
      attachedAgent = api || null;
      if (attachedTour) ensure();
    },
    handleEvent(ev){
      if (!ev || !ev.type) return;
      if (ev.type === "tour:start" || ev.type === "tour:resume") {
        startListening();
      } else if (ev.type === "tour:pause") {
        // keep listening so the guide can say "resume"
      } else if (ev.type === "tour:stop") {
        startListening();
      } else if (ev.type === "tour:complete") {
        stopListening();
      }
    },
    ensureListening(){
      if (attachedTour && !listening) startListening();
    }
  };
}

const tourVoiceControl = createTourVoiceControl();

// Global fullscreen helper so we can trigger it from role buttons
export async function enterFullscreenLandscape(){
  const d = document;
  const target = d.documentElement;
  const fsEl = d.fullscreenElement || d.webkitFullscreenElement || d.mozFullScreenElement || d.msFullscreenElement;
  try {
    if (fsEl) {
      await (d.exitFullscreen?.() || d.webkitExitFullscreen?.() || d.mozCancelFullScreen?.() || d.msExitFullscreen?.());
      document.body.classList.remove('fakefs');
      updateFSButtonVisibility();
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
  updateFSButtonVisibility();
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
              // Avoid createImageBitmap on iOS to reduce memory spikes/leaks
              if (!IS_IOS && 'createImageBitmap' in window && typeof createImageBitmap === 'function') {
                await createImageBitmap(blob);
              } else {
                await new Promise((res2, rej2) => {
                  const img = new Image();
                  img.decoding = 'async';
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
  // Trickle toward completion if network doesnâ€™t expose byte sizes
  const trickle = setInterval(() => {
    if (performance.now() - lastUpdate > 700) {
      target = Math.min(0.9, target + 0.01);
      if (!rafId) rafId = requestAnimationFrame(tick);
    }
  }, 300);

  // Adaptive strategy for slow connections and iOS memory constraints
  const { saveData, slow, isMobile } = getNetworkProfile();
  let mode = PRELOAD_MODE;
  if (mode !== 'all' && mode !== 'stage') mode = (saveData || slow || IS_IOS) ? 'stage' : 'all';
  const stageCount = mode === 'all' ? files.length : (saveData || slow || IS_IOS ? 1 : (isMobile ? 2 : 3));
  const stageList = files.slice(0, Math.min(files.length, stageCount));
  const restList = files.slice(stageList.length);

  const mobileConc = IS_IOS ? 1 : (IS_ANDROID ? Math.max(1, Math.min(PRELOAD_CONCURRENCY, 2)) : PRELOAD_CONCURRENCY);
  await preloadImagesStreaming(stageList, onRawProgress, mobileConc);
  if (mode === 'all' && restList.length) {
    await preloadImagesStreaming(restList, onRawProgress, Math.max(1, mobileConc));
  } else if (restList.length) {
    // Background warm cache of remaining panos; no need to await
    preloadImagesStreaming(restList, () => {}, Math.max(1, Math.min(2, mobileConc))).catch(()=>{});
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
  try{ document.body.setAttribute('data-role','guide'); }catch{}
  // Use stub to avoid breaking dev if agent.js is unavailable
  const importPromise = import("./engine/agent.js");
  // Attempt fullscreen + landscape early (user gesture)
  void enterFullscreenLandscape();
  await preloadExperience(id); try { (window.unlockAudio && window.unlockAudio()) } catch {}

  const roomId = roomInput?.value?.trim() || "demo";
  gate?.remove();
  if (bottomBar) { bottomBar.hidden = false; bottomBar.style.display = 'flex'; }
  
  // Engine chunk + init; overlay remains visible from preload until we're fully ready
  const { initAgent } = await importPromise;
  state.agentApi = await initAgent({ roomId, exp: id, experiencesMeta: state.manifest });
  tourVoiceControl.setAgentApi(state.agentApi);
  if (!state.boundExperienceListener) {
    addEventListener('agent:experience', (ev) => {
      const nextId = normaliseExpId(ev?.detail?.expId);
      if (!nextId) return;
      syncActiveExperience(nextId, { syncGate: false, syncLive: true });
      setupZoneUI().catch(() => {});
    });
    state.boundExperienceListener = true;
  }
  // Build zone selector (if zones exist)
  try {
    await setupZoneUI();
  } catch {}
  // Build tour controller lazily
  try {
    const { createTourController } = await import('./engine/tour.js');
    state.tour = createTourController({
      api: state.agentApi,
      tourId: (import.meta?.env?.VITE_TOUR_ID || 'default'),
      experiencesMeta: state.manifest,
      onEvent: tourVoiceControl.handleEvent
    });
    window.__tour = state.tour; // exposed for AI voice
    tourVoiceControl.attach(state.tour, state.agentApi);
    // Auto-start tour if enabled
    const AUTOSTART = String(import.meta?.env?.VITE_TOUR_AUTOSTART ?? '0') === '1';
    if (AUTOSTART) { try { await state.tour.start(); } catch (e) { console.warn('[tour] autostart failed', e); } }
  } catch {}
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
  try{ document.body.setAttribute('data-role','viewer'); }catch{}
  const importPromise = import("./engine/viewer.js");
  // Attempt fullscreen + landscape early (user gesture)
  void enterFullscreenLandscape();
  await preloadExperience(id); try { (window.unlockAudio && window.unlockAudio()) } catch {}

  const roomId = roomInput?.value?.trim() || "demo";
  gate?.remove();
  if (bottomBar) bottomBar.hidden = true;
  state.agentApi = null;
  const { initViewer } = await importPromise;
  await initViewer({ roomId, exp: id, experiencesMeta: state.manifest });
  dispatchEvent(new CustomEvent('loading:hide'));
}

// Zone select wiring (created dynamically so it works on older HTML)
async function setupZoneUI(){
  if (!state.agentApi) return;
  const bar = document.getElementById('bottomBar');
  if (!bar) return;
  let wrap = document.getElementById('zoneSelectWrap');
  if (!wrap){
    // Insert zone select right after the experience dropdown
    const anchor = document.getElementById('expSelectLiveWrap');
    wrap = document.createElement('div');
    wrap.className = 'select'; wrap.id = 'zoneSelectWrap'; wrap.setAttribute('data-open','false');
    wrap.style.display = 'none';
    wrap.innerHTML = `
      <button type="button" class="select-btn" id="zoneBtn">
        <span id="zoneLabel">Zone</span>
        <svg width="14" height="10" viewBox="0 0 12 8" xmlns="http://www.w3.org/2000/svg"><path fill="#F3C400" d="M1 1l5 6 5-6"/></svg>
      </button>
      <ul class="select-list" id="zoneList" role="listbox"></ul>
      <select id="zoneSelect" hidden></select>`;
    if (anchor && anchor.parentElement===bar){ bar.insertBefore(wrap, anchor.nextSibling); }
    else { bar.insertBefore(wrap, bar.firstChild); }
  }
  // Wire custom select behaviors
  const setZoneValue = wireCustomSelect({ wrapId:'zoneSelectWrap', btnId:'zoneBtn', listId:'zoneList', labelId:'zoneLabel', selectId:'zoneSelect' });
  const zoneSelect = document.getElementById('zoneSelect');

  async function refreshList(){
    try{
      const ctx = await state.agentApi.getContext?.();
      const zones = Array.isArray(ctx?.zones)? ctx.zones : [];
      const nodes = Array.isArray(ctx?.nodes)? ctx.nodes : [];
      const curId = ctx?.currentNodeId || null;
      const curNode = nodes.find(n=>n.id===curId) || null;
      const zmap = new Map(zones.map(z=>[z.id, (typeof z.name==='string' && z.name.trim())? z.name.trim() : z.id]));
      // Derive current zoneId
      const currentZoneId = curNode?.zoneId || null;
      if (!zones.length){ wrap.style.display='none'; return; }
      wrap.style.display='';
      // Populate options and list
      zoneSelect.innerHTML=''; const list = document.getElementById('zoneList'); if (list) list.innerHTML='';
      zones.forEach((z, idx)=>{
        const id = z.id; const label = zmap.get(id) || String(id);
        const opt = document.createElement('option'); opt.value = id; opt.textContent = label; if (currentZoneId && id===currentZoneId) opt.selected = true; zoneSelect.appendChild(opt);
        const li = document.createElement('li'); li.dataset.value = id; li.role='option'; li.textContent = label; if (currentZoneId && id===currentZoneId) { li.classList.add('active'); li.setAttribute('aria-selected','true'); } else { li.setAttribute('aria-selected','false'); }
        document.getElementById('zoneList')?.appendChild(li);
      });
      // Sync label to current selection
      try{ const sel = zoneSelect.options[zoneSelect.selectedIndex]; setZoneValue(sel?.value || zones[0]?.id || '', false); }catch{}
    }catch{
      wrap.style.display='none';
    }
  }

  // Handle user selection â†’ navigate to that zone
  zoneSelect?.addEventListener('change', ()=>{
    try{
      const opt = zoneSelect.options[zoneSelect.selectedIndex];
      const name = opt?.textContent || opt?.value || '';
      if (name) state.agentApi?.goToZoneByName?.(name);
    }catch{}
  });

  // Keep UI in sync as the guide moves
  if (state.zoneNavigateListener) {
    removeEventListener('agent:navigate', state.zoneNavigateListener);
  }
  state.zoneNavigateListener = () => { refreshList().catch(() => {}); };
  addEventListener('agent:navigate', state.zoneNavigateListener);
  await refreshList();
}


async function onLiveExperienceChange() {
  const nextId = normaliseExpId(expSelectLive?.value);
  syncActiveExperience(nextId, { syncGate: false, syncLive: true });
  await preloadExperience(nextId);
  if (state.agentApi?.switchExperience) {
    try { await state.agentApi.switchExperience(nextId); }
    catch (e) { console.error('[agent] switchExperience failed', e); }
  }
  if (state.tour?.isPlaying && state.tour.isPlaying()) {
    try { state.tour.stop(); } catch {}
  }
  // Rebuild zone UI for the new experience
  try { await setupZoneUI(); } catch {}
  // After switching, hide the loader since textures are already cached
  dispatchEvent(new CustomEvent('loading:hide'));
}

async function bootstrap() {
  // Device/orientation flags + fullscreen button wiring
  updateHtmlFlags();
  addEventListener('resize', updateHtmlFlags);
  addEventListener('orientationchange', updateHtmlFlags);
  addEventListener('orientationchange', attemptAutoFullscreenIfLandscape);
  addEventListener('resize', attemptAutoFullscreenIfLandscape);
  addEventListener('pointerdown', ()=>{ LAST_GESTURE_AT = Date.now(); try{ sessionStorage.setItem('autoFs','1'); }catch{} });
  document.addEventListener('fullscreenchange', updateFSButtonVisibility);
  document.addEventListener('webkitfullscreenchange', updateFSButtonVisibility);
  exitFSBtn?.addEventListener('click', async ()=>{
    try {
      const d=document; if (d.exitFullscreen) await d.exitFullscreen();
      else if (d.webkitExitFullscreen) await d.webkitExitFullscreen();
    } catch {}
    document.body.classList.remove('fakefs');
    try { dispatchEvent(new CustomEvent('ui:exit')); } catch {}
    updateFSButtonVisibility();
  });

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

  // Optional cinematic intro + 3D start hub
  // Default: ON. You can disable with ?intro=0 or ?skipIntro=1 or env VITE_INTRO_ENABLED=0
  try {
    const qs = getQS();
    const qsIntro = (qs.get('intro')||'').trim().toLowerCase();
    const skipIntro = qsIntro === '0' || qsIntro === 'false' || qsIntro === 'no' || qs.get('skipIntro') === '1';
    const envOn = String(import.meta?.env?.VITE_INTRO_ENABLED ?? '0') === '1';
    const introEnabled = !skipIntro && (qsIntro === '1' || envOn);
    const introMs = Math.max(0, Number(import.meta?.env?.VITE_INTRO_DURATION_MS) || 5000);
    if (introEnabled) {
      // Hide gate during intro
      if (gate) gate.style.display = 'none';
      try { dispatchEvent(new CustomEvent('loading:show', { detail: { label: 'Preparingâ€¦' } })); } catch {}
      try { console.info('[intro] enabled'); } catch {}
      const { runStartHub } = await import('./engine/start-hub.js');
      // Hide overlay before showing teaser + chips so it doesn't block input
      try { dispatchEvent(new CustomEvent('loading:hide')); } catch {}
      const res = await runStartHub({ expId: state.activeExpId, durationMs: introMs });
      const act = (res?.action || '').toLowerCase();
      if (act === 'host' || act === 'solo') {
        await startGuide();
        return;
      }
      // If skipped or invite, show gate again
      if (gate) gate.style.display = '';
    }
  } catch (e) { console.warn('[intro] failed', e); if (gate) gate.style.display=''; }

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

  // auto-start by querystring (iOS needs a user gesture)
  const qs = getQS();
  const wantRole = (qs.get('role')||'').toLowerCase();
  const qsExp = qs.get('exp');
  const qsRoom = qs.get('room');
  const flush = qs.get('flush') === '1';
  if (qsRoom) roomInput.value = qsRoom;
  if (qsExp && state.manifestById.has(qsExp)) {
    state.activeExpId = qsExp; state.setGateExp?.(qsExp,false); state.setLiveExp?.(qsExp,false);
  }
  // Ask SW (if active) to flush pano cache when requested
  if (flush) { try { navigator.serviceWorker?.controller?.postMessage({ type:'flush' }); } catch {} }
  if (wantRole === 'viewer' || wantRole === 'guide') {
    const startFn = wantRole === 'viewer' ? startViewer : startGuide;
    if (IS_IOS) {
      try {
        const orient = document.documentElement.getAttribute('data-orient') || '';
        if (orient === 'portrait') {
          if (rotateOverlay) rotateOverlay.style.display = 'grid';
          if (tapStartBtn) {
            tapStartBtn.style.display = 'inline-block';
            tapStartBtn.onclick = async () => { try { await enterFullscreenLandscape(); } catch {} await startFn(); if (rotateOverlay) rotateOverlay.style.display='none'; };
          }
          // Defer actual start until user taps
          return;
        }
      } catch {}
    }
    await startFn();
    return;
  }

  expSelect?.addEventListener("change", () => {
    const val = normaliseExpId(expSelect.value);
    syncActiveExperience(val, { syncGate: false, syncLive: false });
    if (state.setLiveExp) state.setLiveExp(val, false);
  });

  expSelectLive?.addEventListener("change", () => onLiveExperienceChange().catch(console.error));
  btnGuide?.addEventListener("click", () => startGuide().catch(console.error));
  btnViewer?.addEventListener("click", () => startViewer().catch(console.error));

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
  // Fullscreen with iOS-friendly behavior
  btnFullscreen?.addEventListener("click", enterFullscreenLandscape);
  btnFS?.addEventListener("click", enterFullscreenLandscape);

  // Tour controls
  function tourReady(){ return Boolean(state.tour); }
  tourStartBtn?.addEventListener('click', async ()=>{
    try {
      if (!state.tour) {
        const { createTourController } = await import('./engine/tour.js');
        state.tour = createTourController({
          api: state.agentApi,
          tourId: (import.meta?.env?.VITE_TOUR_ID || 'default'),
          experiencesMeta: state.manifest,
          onEvent: tourVoiceControl.handleEvent
        });
        window.__tour = state.tour;
      }
      tourVoiceControl.attach(state.tour, state.agentApi);
      await state.tour.start();
    } catch(e){ console.error('[tour] start failed', e); }
  });
  tourPauseBtn?.addEventListener('click', ()=>{ if(!tourReady()) return; try{ state.tour.isPlaying()? state.tour.pause() : state.tour.resume(); }catch{} });
  tourPrevBtn?.addEventListener('click', ()=>{ if(tourReady()) try{ state.tour.prev(); }catch{} });
  tourNextBtn?.addEventListener('click', ()=>{ if(tourReady()) try{ state.tour.next(); }catch{} });
  tourStopBtn?.addEventListener('click', ()=>{ if(tourReady()) try{ state.tour.stop(); }catch{} });

  // Keyboard shortcuts (when Agent running): Space toggles, Shift+Arrows step
  window.addEventListener('keydown', (e)=>{
    if (!state.agentApi || !state.tour) return;
    if (e.code==='Space') { e.preventDefault(); try{ state.tour.isPlaying()? state.tour.pause() : state.tour.resume(); }catch{} }
    if (e.shiftKey && e.key==='ArrowLeft') { e.preventDefault(); try{ state.tour.prev(); }catch{} }
    if (e.shiftKey && e.key==='ArrowRight'){ e.preventDefault(); try{ state.tour.next(); }catch{} }
    if (e.key==='Escape'){ try{ state.tour.stop(); }catch{} }
  }, { passive:false });

  updateFSButtonVisibility();

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


















