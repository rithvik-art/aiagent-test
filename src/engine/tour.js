// Simple guided tour controller for Agent/Guide mode
// Drives cross-experience navigation, step timing, and narration.

function now() { try { return performance.now(); } catch { return Date.now(); } }

async function tryPlayServerTTS(text, opts = {}) {
  const voice = (import.meta?.env?.VITE_TOUR_TTS_VOICE || 'alloy').trim();
  const model = (import.meta?.env?.VITE_TOUR_TTS_MODEL || 'gpt-4o-mini-tts').trim();
  const endpoint = (import.meta?.env?.VITE_TOUR_TTS_URL || '/.netlify/functions/speech');
  if (!text) return false;
  try {
    const res = await fetch(endpoint, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ input: text, voice, model })
    });
    if (!res.ok) throw new Error('tts-failed');
    // Netlify returns audio with isBase64Encoded; but returning here as binary also works
    const blob = await res.blob();
    const url = URL.createObjectURL(blob);
    const audio = new Audio(url);
    audio.preload = 'auto';
    await audio.play();
    return { audio, url };
  } catch { return false; }
}

function speakWithSynthesis(text) {
  if (!text) return false;
  try {
    if (!('speechSynthesis' in window)) return false;
    const u = new SpeechSynthesisUtterance(text);
    u.rate = Math.max(0.8, Math.min(1.15, Number(import.meta?.env?.VITE_TOUR_TTS_RATE) || 1));
    u.pitch = 1; u.lang = (navigator.language || 'en-US');
    try { window.speechSynthesis.cancel(); } catch {}
    window.speechSynthesis.speak(u);
    return { synth: true };
  } catch { return false; }
}

// Force faster pano cadence: 10s per step
const DEFAULT_DWELL = 10;
const DWELL_MIN = 10;
const DWELL_MAX = 10;
const clampDwell = (sec) => {
  const v = Number(sec);
  if (!Number.isFinite(v)) return DEFAULT_DWELL;
  return Math.max(DWELL_MIN, Math.min(DWELL_MAX, v));
};

export function createTourController({ api, tourId = 'default', onEvent, experiencesMeta = [] } = {}) {
  let steps = [];
  let index = -1;
  let playing = false;
  let timer = null;
  let remainingMs = 0;
  let stepStartedAt = 0;
  let curAudio = null; let curObjectUrl = '';
  let plan = [];
  let zoneNameById = new Map();
  let activeExperienceId = '';
  const experienceCache = new Map();
  const experienceLabelById = new Map();
  if (Array.isArray(experiencesMeta)) {
    for (const item of experiencesMeta) {
      const id = typeof item?.id === 'string' ? item.id.trim() : '';
      if (!id) continue;
      const label = (typeof item?.label === 'string' && item.label.trim()) ? item.label.trim() : id;
      experienceLabelById.set(id, label);
    }
  }
  function titleCase(input = ''){
    return input.replace(/\w\S*/g, (word) => word.charAt(0).toUpperCase() + word.slice(1));
  }
  function getExperienceLabel(expId){
    const key = String(expId || '').trim();
    if (!key) return '';
    if (experienceLabelById.has(key)) return experienceLabelById.get(key) || key;
    const fallback = key.replace(/[-_]+/g, ' ').replace(/\s+/g, ' ').trim();
    const label = fallback ? titleCase(fallback) : key;
    experienceLabelById.set(key, label);
    return label;
  }
  function getActivePlan(){
    return (plan.length ? plan : steps);
  }
  function getStepAt(idx){
    const arr = getActivePlan();
    if (!Array.isArray(arr) || idx < 0 || idx >= arr.length) return null;
    return arr[idx];
  }
  function resolveZoneLabel(step, expId){
    const zoneKey = String(step?.zoneId || '').trim();
    if (!zoneKey) return step?.zoneName || '';
    const expKey = String(expId || activeExperienceId || '').trim();
    const mapped = zoneNameById.get(`${expKey}:${zoneKey}`) || zoneNameById.get(zoneKey);
    if (step?.zoneName && step.zoneName.trim()) return step.zoneName.trim();
    return mapped || zoneKey;
  }
  function isMidZone(idx, arr){
    const list = Array.isArray(arr) ? arr : getActivePlan();
    if (!Array.isArray(list) || idx <= 0) return false;
    const curr = list[idx];
    const prev = list[idx - 1];
    if (!curr || !prev) return false;
    return Boolean(
      SHORT_CUE_ENABLED &&
      curr.zoneId && prev.zoneId &&
      curr.zoneId === prev.zoneId &&
      curr.nodeId && prev.nodeId &&
      curr.nodeId !== prev.nodeId
    );
  }
  function buildNarration(step, idx, { midZone = false, experienceId = null, zoneLabel: providedZone } = {}){
    const expId = experienceId || step?.exp || activeExperienceId;
    const expLabel = getExperienceLabel(expId);
    const zoneLabel = providedZone || resolveZoneLabel(step, expId);
    const parts = [];
    if (expLabel) parts.push(`You are in the ${expLabel} experience.`);
    const hasZone = Boolean(zoneLabel);
    if (hasZone) {
      parts.push(midZone ? `Staying in zone ${zoneLabel}.` : `Entering zone ${zoneLabel}.`);
    } else {
      parts.push(`Exploring the current area.`);
    }
    let action = '';
    if (step?.nodeId) {
      if (midZone && hasZone) {
        action = `Moving to the next view in ${zoneLabel}.`;
      } else {
        action = `Moving to view ${idx + 1}${hasZone ? ` in ${zoneLabel}` : ''}.`;
      }
    } else {
      action = hasZone ? `Moving deeper into ${zoneLabel}.` : `Moving to the next section.`;
    }
    if (action) parts.push(action);
    return parts.join(' ');
  }
  function applyAutoNarration(list){
    if (!Array.isArray(list)) return;
    for (let i = 0; i < list.length; i++){
      const step = list[i];
      if (!step) continue;
      const audio = (step?.narration?.audio || '').trim();
      const hasText = typeof step?.narration?.text === 'string' && step.narration.text.trim().length > 0;
      if (!step.narration) step.narration = {};
      if (!hasText && !audio){
        step.narration.text = buildNarration(step, i, { midZone: isMidZone(i, list) });
      }
    }
  }
  async function ensureExperienceData(expId){
    const key = String(expId || '').trim();
    if (!key) return null;
    if (experienceCache.has(key)) return experienceCache.get(key);
    let payload = null;
    if (typeof api?.getExperienceData === 'function'){
      try {
        payload = await api.getExperienceData(key);
      } catch {}
    }
    if (payload && typeof payload === 'object'){
      const normalized = {
        expId: key,
        nodes: Array.isArray(payload.nodes) ? payload.nodes : [],
        zones: Array.isArray(payload.zones) ? payload.zones : [],
        startNodeId: payload.startNodeId || null,
      };
      experienceCache.set(key, normalized);
      normalized.zones.forEach(z => {
        const label = (typeof z.name === 'string' && z.name.trim()) ? z.name.trim() : z.id;
        zoneNameById.set(`${key}:${z.id}`, label);
        zoneNameById.set(z.id, label);
      });
      return normalized;
    }
    experienceCache.set(key, null);
    return null;
  }
  // Track last node we advanced to in order to avoid duplicate step triggers
  let lastAppliedNodeId = null;
  const SHORT_CUE_ENABLED = (import.meta?.env?.VITE_TOUR_NEXT_VIEW_CUE || '1') !== '0';

  function emit(type, detail = {}) { try { onEvent?.({ type, ...detail }); } catch {} }
  function clearTimer() { if (timer) { clearTimeout(timer); timer = null; } }
  function stopNarration() {
    try { if (curAudio) { curAudio.pause(); curAudio.src = ''; } } catch {}
    curAudio = null; try { if (curObjectUrl) URL.revokeObjectURL(curObjectUrl); } catch {}
    curObjectUrl = '';
    try { window.speechSynthesis?.cancel?.(); } catch {}
  }

  async function load() {
    const res = await fetch(`/tours/${encodeURIComponent(tourId)}.json`, { cache: 'no-cache' });
    const json = await res.json();
    steps = Array.isArray(json?.steps) ? json.steps : [];
    plan = [];
    zoneNameById = new Map();
    let activeExp = '';
    try {
      const ctx = await api?.getContext?.();
      activeExp = String(ctx?.exp || '').trim();
    } catch {}
    if (activeExp) activeExperienceId = activeExp;
    for (const s of steps) {
      const dwell = clampDwell(s?.dwellSec);
      const nar = s?.narration || {};
      const rawExp = s?.exp ? String(s.exp).trim() : '';
      const expId = rawExp || activeExp;
      if (expId) activeExp = expId;
      const expData = expId ? await ensureExperienceData(expId) : null;
      if (expData) {
        expData.zones.forEach(z => {
          zoneNameById.set(`${expId}:${z.id}`, (typeof z.name === 'string' && z.name.trim()) ? z.name.trim() : z.id);
        });
      }
      if (s?.nodeId) {
        plan.push({ exp: expId, nodeId: s.nodeId, dwellSec: dwell, narration: nar });
        continue;
      }
      const zoneRef = s?.zoneId ? String(s.zoneId).trim() : '';
      if (!zoneRef) {
        plan.push({ exp: expId, nodeId: null, dwellSec: dwell, narration: nar, zoneId: null });
        continue;
      }
      const zoneLower = zoneRef.toLowerCase();
      const zoneList = Array.isArray(expData?.zones) ? expData.zones : [];
      const nodeList = Array.isArray(expData?.nodes) ? expData.nodes : [];
      const zoneMatch =
        zoneList.find(z => String(z.id || '').toLowerCase() === zoneLower) ||
        zoneList.find(z => String(z.name || '').trim().toLowerCase() === zoneLower) || null;
      const zoneId = zoneMatch?.id || zoneRef;
      const zoneLabel = zoneMatch?.name?.trim?.() || zoneId;
      if (zoneId) {
        zoneNameById.set(`${expId}:${zoneId}`, zoneLabel);
        zoneNameById.set(zoneId, zoneLabel);
      }
      const nodesInZone = nodeList.filter(n => {
        const zid = String(n.zoneId || '').trim();
        if (!zid) return false;
        return zid === zoneId || zid.toLowerCase() === zoneLower;
      });
      if (nodesInZone.length > 0) {
        let first = true;
        for (const node of nodesInZone) {
          plan.push({ exp: expId, nodeId: node.id, dwellSec: dwell, narration: first ? nar : {}, zoneId, zoneName: zoneLabel });
          first = false;
        }
        continue;
      }
      plan.push({ exp: expId, nodeId: null, dwellSec: dwell, narration: nar, zoneId, zoneName: zoneLabel });
    }
    applyAutoNarration(getActivePlan());
  }

  async function goToStep(i) {
    index = i;
    const currentPlan = getActivePlan();
    const s = currentPlan[index];
    if (!s) return complete();
    lastAppliedNodeId = s?.nodeId || null;
    const stepExp = s?.exp ? String(s.exp).trim() : '';
    const desiredExp = stepExp || activeExperienceId;
    if (desiredExp && typeof api?.switchExperience === 'function' && desiredExp !== activeExperienceId) {
      await api.switchExperience(desiredExp);
      activeExperienceId = desiredExp;
      await ensureExperienceData(desiredExp);
    } else if (desiredExp && !activeExperienceId) {
      activeExperienceId = desiredExp;
      await ensureExperienceData(desiredExp);
    }
    // zone or node
    if (s.nodeId && typeof api?.goToNode === 'function') {
      await api.goToNode(s.nodeId, { source: 'tour', broadcast: true, sync: true });
    } else if (s.zoneId && typeof api?.goToZoneByName === 'function') {
      const zoneLabel = s?.zoneName || zoneNameById.get(`${activeExperienceId}:${s.zoneId}`) || zoneNameById.get(s.zoneId) || s.zoneId;
      await api.goToZoneByName(zoneLabel, { source: 'tour', broadcast: true, sync: true });
    }
    // narration
    stopNarration();
    const midZone = isMidZone(index, currentPlan);
    const zoneLabel = resolveZoneLabel(s, activeExperienceId);
    let text = (s?.narration?.text || '').trim();
    let url = (s?.narration?.audio || '').trim();
    if (midZone) {
      url = '';
    }
    if (!text || midZone) {
      text = buildNarration(s, index, { midZone, experienceId: activeExperienceId, zoneLabel });
    }
    try {
      if (url && !midZone) {
        curAudio = new Audio(url);
        curAudio.preload = 'auto';
        // don't block dwell on play rejection; iOS needs gesture which we have
        curAudio.play().catch(()=>{});
      } else {
        const mode = (import.meta?.env?.VITE_TOUR_TTS || 'fallback').toLowerCase();
        if (mode === 'server' && !midZone) {
          const r = await tryPlayServerTTS(text);
          if (r && r.audio) { curAudio = r.audio; curObjectUrl = r.url || ''; }
          else if (text) speakWithSynthesis(text);
        } else if (text) {
          // Use lightweight synthesis for short cues or fallback
          speakWithSynthesis(text);
        }
      }
    } catch {}

    const dwellSec = clampDwell(s?.dwellSec);
    const dwellMs = Math.max(3000, Math.round(dwellSec * 1000));
    remainingMs = dwellMs; stepStartedAt = now();
    clearTimer(); timer = setTimeout(next, dwellMs);
    emit('tour:step', { index, step: s });
  }

  function pause() {
    if (!playing) return;
    playing = false; clearTimer();
    const elapsed = Math.max(0, now() - stepStartedAt);
    remainingMs = Math.max(500, (remainingMs || 0) - elapsed);
    try { curAudio?.pause?.(); } catch {}
    emit('tour:pause', { index });
  }
  function resume() {
    if (playing) return;
    playing = true; clearTimer();
    const ms = Math.max(500, remainingMs || 1000);
    stepStartedAt = now();
    try { if (curAudio && curAudio.paused) curAudio.play().catch(()=>{}); } catch {}
    timer = setTimeout(next, ms);
    emit('tour:resume', { index });
  }
  function prev() { clearTimer(); stopNarration(); goToStep(Math.max(0, (index - 1))); }
  function next() { clearTimer(); stopNarration(); goToStep(index + 1); }
  function stop() { playing = false; clearTimer(); stopNarration(); emit('tour:stop', {}); }
  function complete() { stop(); emit('tour:complete', {}); }

  return {
    load,
    start: async () => { await load(); playing = true; await goToStep(0); emit('tour:start', { count: getActivePlan().length }); },
    pause, resume, prev, next, stop,
    isPlaying: () => playing,
    getIndex: () => index,
    getSteps: () => {
      const arr = getActivePlan();
      return Array.isArray(arr) ? arr.slice() : [];
    },
    jumpToNode: async (nodeId) => { try{ if (nodeId && nodeId===lastAppliedNodeId) return; const arr = getActivePlan(); const idx = Array.isArray(arr) ? arr.findIndex(s=>s?.nodeId===nodeId) : -1; if(idx>=0 && idx!==index){ clearTimer(); stopNarration(); playing = true; await goToStep(idx); } }catch{} },
  };
}

// Allow manual navigation during autoplay: keep the tour in sync with Agent moves
try {
  addEventListener('agent:navigate', (ev)=>{
    const d = ev?.detail || {}; const tour = (window && window.__tour) ? window.__tour : null;
    if (!tour || !tour.isPlaying || !tour.isPlaying()) return;
    const src = String(d?.source || '').toLowerCase();
    if (src === 'user') {
      try{ tour.stop(); }catch{}
      return;
    }
    if (!d?.nodeId || src === 'tour') return;
    try{
      tour.jumpToNode?.(d.nodeId);
    }catch{}
  });
} catch {}
