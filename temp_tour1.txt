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

export function createTourController({ api, tourId = 'default', onEvent } = {}) {
  const DEF_DWELL = 10; // force 10s per view as requested
  let steps = [];
  let index = -1;
  let playing = false;
  let timer = null;
  let remainingMs = 0;
  let stepStartedAt = 0;
  let curAudio = null; let curObjectUrl = '';
  let plan = [];
  let zoneNameById = new Map();
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
    // Expand zones to concrete node sequence using agent context
    try {
      const ctx = await api?.getContext?.();
      const zones = Array.isArray(ctx?.zones) ? ctx.zones : [];
      const nodes = Array.isArray(ctx?.nodes) ? ctx.nodes : [];
      const zoneByName = new Map(zones.map(z=>[String(z.name||z.id).toLowerCase().trim(), z.id]));
      const zoneById = new Map(zones.map(z=>[z.id, z]));
      zoneNameById = new Map(zones.map(z=>[z.id, (typeof z.name==='string' && z.name.trim()) ? z.name.trim() : z.id]));
      plan = [];
      for (const s of steps) {
        const dwell = DEF_DWELL; // enforce 10s per step regardless of source
        const nar = s?.narration || {};
        const exp = s?.exp || null;
        if (s?.nodeId) { plan.push({ exp, nodeId: s.nodeId, dwellSec: dwell, narration: nar }); continue; }
        const zoneRef = s?.zoneId ? String(s.zoneId).trim() : '';
        if (!zoneRef) { plan.push({ exp, nodeId: null, dwellSec: dwell, narration: nar, zoneId: null }); continue; }
        let zid = zoneById.has(zoneRef) ? zoneRef : (zoneByName.get(zoneRef.toLowerCase()) || null);
        if (!zid) { plan.push({ exp, nodeId: null, dwellSec: dwell, narration: nar, zoneId: zoneRef }); continue; }
        const inZone = nodes.filter(n=>n.zoneId===zid).map(n=>n.id);
        if (inZone.length === 0) { plan.push({ exp, nodeId: null, dwellSec: dwell, narration: nar, zoneId: zid }); continue; }
        let first = true;
        for (const nid of inZone) {
          // Only the first node in a zone inherits the full narration
          plan.push({ exp, nodeId: nid, dwellSec: dwell, narration: first ? nar : {}, zoneId: zid });
          first = false;
        }
      }
    } catch { plan = steps.slice(); }
  }

  async function goToStep(i) {
    index = i; const s = plan[index] || steps[index];
    if (!s) return complete();
    lastAppliedNodeId = s?.nodeId || null;
    // experience switch
    if (s.exp && typeof api?.switchExperience === 'function') {
      await api.switchExperience(s.exp);
    }
    // zone or node
    if (s.zoneId && !s.nodeId && typeof api?.goToZoneByName === 'function') {
      await api.goToZoneByName(s.zoneId);
    } else if (s.nodeId && typeof api?.goToNode === 'function') {
      await api.goToNode(s.nodeId);
    }
    // narration
    stopNarration();
    let text = s?.narration?.text || '';
    let url = s?.narration?.audio || '';
    // Mid-zone step: use short cue instead of full narration/audio
    const prev = (index > 0) ? (plan[index-1] || steps[index-1]) : null;
    const midZone = SHORT_CUE_ENABLED && s?.zoneId && prev?.zoneId && (prev.zoneId === s.zoneId) && s.nodeId && prev.nodeId && (s.nodeId !== prev.nodeId);
    if (midZone) {
      const zn = zoneNameById.get(s.zoneId) || 'this zone';
      text = `Taking you to the next view in ${zn}.`;
      url = '';
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

    const dwellMs = Math.max(3000, Math.round((DEF_DWELL) * 1000));
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
    start: async () => { await load(); playing = true; await goToStep(0); emit('tour:start', { count: (plan.length||steps.length) }); },
    pause, resume, prev, next, stop,
    isPlaying: () => playing,
    getIndex: () => index,
    getSteps: () => (plan.length? plan.slice() : steps.slice()),
    jumpToNode: async (nodeId) => { try{ if (nodeId && nodeId===lastAppliedNodeId) return; const arr = (plan.length? plan : steps); const idx = arr.findIndex(s=>s?.nodeId===nodeId); if(idx>=0 && idx!==index){ clearTimer(); stopNarration(); playing = true; await goToStep(idx); } }catch{} },
  };
}

// Allow manual navigation during autoplay: keep the tour in sync with Agent moves
try {
  addEventListener('agent:navigate', (ev)=>{
    const d = ev?.detail || {}; const tour = (window && window.__tour) ? window.__tour : null;
    if (!tour || !tour.isPlaying || !tour.isPlaying()) return;
    // Ignore programmatic moves triggered by the tour itself; only react to user-driven navigation
    if (d?.source && String(d.source).toLowerCase() !== 'user') return;
    try{
      tour.jumpToNode?.(d.nodeId);
    }catch{}
  });
} catch {}
