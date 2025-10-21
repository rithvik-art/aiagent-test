// ai-agent.js - lightweight voice-driven assistant layered on top of Agent
// - Uses browser SpeechRecognition when available; falls back to OpenAI Whisper
// - Uses OpenAI TTS when a key is present; otherwise falls back to browser TTS

import { initAgent } from "./agent.js";
const API_PROXY = (import.meta?.env?.VITE_API_PROXY || '').trim();

function byId(id){ return document.getElementById(id); }
function getApiKey(){
  try{
    const envKey = (import.meta?.env?.VITE_OPENAI_API_KEY || '').trim();
    const lsKey  = (localStorage.getItem('openai:key') || '').trim();
    return envKey || lsKey || '';
  }catch{ return (import.meta?.env?.VITE_OPENAI_API_KEY || '').trim(); }
}

// Audio playback helpers
let currentAudio = null;
function stopAudio(){ try{ if(currentAudio){ currentAudio.pause(); currentAudio.src=''; currentAudio=null; } }catch{} try{ window.speechSynthesis?.cancel?.(); }catch{} }
function ensurePlayButtonFor(audio){
  try{
    let btn = byId('aiPlay');
    if (!btn){
      const wrap = byId('aiPanel'); if (!wrap) return;
      btn = document.createElement('button'); btn.id='aiPlay'; btn.textContent='PLAY';
      btn.title='Tap to play last response';
      btn.style.cssText='min-width:56px;height:40px;border-radius:10px;border:1px solid rgba(42,50,66,.8);background:#1b2350;color:#F3C400;cursor:pointer';
      wrap.appendChild(btn);
    }
    btn.onclick = ()=>{ try{ audio?.play?.(); }catch{} };
  }catch{}
}
async function speak(text){
  const t = String(text||'').trim(); if(!t) return;
  // If running behind a proxy (Netlify Functions), call it and avoid exposing the key in browser
  if (API_PROXY){
    try{
      const res = await fetch(`${API_PROXY}/speech`, { method:'POST', headers:{ 'Content-Type':'application/json' }, body: JSON.stringify({ input: t, voice: (import.meta?.env?.VITE_OPENAI_TTS_VOICE || 'alloy').trim() }) });
      if (!res.ok) throw new Error('proxy-tts-'+res.status);
      const blob = await res.blob();
      const url = URL.createObjectURL(blob); const audio=new Audio(url); audio.crossOrigin='anonymous'; audio.preload='auto'; audio.playsInline=true; currentAudio=audio; audio.onended=()=>{ try{ URL.revokeObjectURL(url); }catch{} if(currentAudio===audio) currentAudio=null; };
      try{ await audio.play(); }catch{ ensurePlayButtonFor(audio); }
      return;
    }catch{}
  }
  const apiKey = getApiKey();
  const voice = (import.meta?.env?.VITE_OPENAI_TTS_VOICE || 'alloy').trim();
  if (apiKey){
    try{
      stopAudio();
      const res = await fetch('https://api.openai.com/v1/audio/speech', {
        method: 'POST', headers: { 'Authorization': `Bearer ${apiKey}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({ model: 'gpt-4o-mini-tts', voice, input: t, format: 'mp3' })
      });
      if (!res.ok) throw new Error('tts-failed-'+res.status);
      const blob = await res.blob();
      const url = URL.createObjectURL(blob);
      const audio = new Audio(url);
      audio.crossOrigin = 'anonymous'; audio.preload='auto'; audio.playsInline=true;
      currentAudio = audio; audio.onended = ()=>{ try{ URL.revokeObjectURL(url); }catch{} if (currentAudio===audio) currentAudio=null; };
      try { await audio.play(); } catch { ensurePlayButtonFor(audio); }
      return;
    }catch{}
  }
  try{
    if (!('speechSynthesis' in window)) return;
    const u = new SpeechSynthesisUtterance(t); u.rate=1; u.pitch=1; u.lang=(navigator.language||'en-US');
    window.speechSynthesis.cancel(); window.speechSynthesis.speak(u);
  }catch{}
}

function loadPropertyMeta(exp){ try{ const raw = localStorage.getItem(`propMeta:${exp}`); return raw? JSON.parse(raw) : {}; }catch{ return {}; } }
function savePropertyMeta(exp, meta){ try{ localStorage.setItem(`propMeta:${exp}`, JSON.stringify(meta||{})); }catch{} }

function createPanel(){
  let wrap = byId('aiPanel'); if (wrap) return wrap;
  wrap = document.createElement('div'); wrap.id='aiPanel';
  wrap.style.cssText=[
    'position:fixed','right:12px','bottom:12px','z-index:60','display:flex','gap:8px',
    'align-items:stretch','background:rgba(15,20,36,.78)','border:1px solid rgba(42,50,66,.8)',
    'border-radius:12px','padding:10px','backdrop-filter:blur(2px)','-webkit-backdrop-filter:blur(2px)'
  ].join(';');
  wrap.innerHTML=`
    <button id="aiMic" title="Toggle mic" style="min-width:40px;height:40px;border-radius:10px;border:1px solid rgba(42,50,66,.8);background:#1b2350;color:#F3C400;cursor:pointer">MIC</button>
    <input id="aiText" placeholder="Type a question or command" style="width:240px;padding:10px;border-radius:10px;border:1px solid rgba(42,50,66,.8);background:#0f1424;color:#e8eaf0"/>
    <button id="aiSend" title="Send" style="min-width:40px;height:40px;border-radius:10px;border:1px solid rgba(42,50,66,.8);background:#1b2350;color:#F3C400;cursor:pointer">?</button>
    <button id="aiAdmin" title="Admin" style="min-width:40px;height:40px;border-radius:10px;border:1px solid rgba(42,50,66,.8);background:#1b2350;color:#F3C400;cursor:pointer">??</button>`;
  document.body.appendChild(wrap);
  return wrap;
}

function ensureStatusUI(){
  try{
    const wrap = byId('aiPanel'); if (!wrap) return; if (byId('aiStatus')) return;
    const status = document.createElement('div'); status.id='aiStatus';
    status.style.cssText='margin-left:8px;min-width:130px;display:flex;align-items:center;gap:6px;color:#c9d3ff;font-size:12px';
    const dot = document.createElement('i'); dot.id='aiDot'; dot.style.cssText='display:inline-block;width:8px;height:8px;border-radius:50%;background:#8a8a8a';
    const span = document.createElement('span'); span.id='aiStateText'; span.textContent='Idle';
    status.appendChild(dot); status.appendChild(span); wrap.appendChild(status);
  }catch{}
}
function ensureKeyButton(onSave){
  try{
    const wrap = byId('aiPanel'); if (!wrap || byId('aiKey')) return;
    const btn = document.createElement('button'); btn.id='aiKey'; btn.title='Set API Key'; btn.textContent='KEY';
    btn.style.cssText='min-width:40px;height:40px;border-radius:10px;border:1px solid rgba(42,50,66,.8);background:#1b2350;color:#F3C400;cursor:pointer';
    btn.addEventListener('click', ()=>{ try{ const cur=getApiKey(); const next=prompt('Paste your OpenAI API key (stored locally in this browser)',cur||''); if(typeof next==='string'){ localStorage.setItem('openai:key', next.trim()); onSave?.(); } }catch{} });
    wrap.appendChild(btn);
  }catch{}
}
function setStatus(text, ok){ try{ const t=byId('aiStateText'); if(t) t.textContent=String(text||''); const d=byId('aiDot'); if(d && typeof ok==='boolean') d.style.background = ok? '#18c964':'#8a8a8a'; }catch{} }
function showAdmin(exp){
  const meta = loadPropertyMeta(exp);
  let dlg = byId('aiAdminDlg'); if (!dlg){
    dlg = document.createElement('div'); dlg.id='aiAdminDlg'; dlg.style.cssText='position:fixed;inset:0;display:grid;place-items:center;z-index:70;background:rgba(0,0,0,.5)';
    dlg.innerHTML = `
      <div style="width:min(92vw,420px);background:#0f1424;border:1px solid rgba(42,50,66,.8);border-radius:12px;padding:14px;color:#e8eaf0">
        <div style="font-weight:700;margin-bottom:8px">Property Details</div>
        <label style="display:block;margin:6px 0 2px">Location</label>
        <input id="aiLoc" style="width:100%;padding:10px;border-radius:10px;border:1px solid rgba(42,50,66,.8);background:#0b1020;color:#e8eaf0"/>
        <label style="display:block;margin:10px 0 2px">Size (e.g. 1200 sq ft)</label>
        <input id="aiSize" style="width:100%;padding:10px;border-radius:10px;border:1px solid rgba(42,50,66,.8);background:#0b1020;color:#e8eaf0"/>
        <div style="display:flex;gap:8px;justify-content:flex-end;margin-top:12px">
          <button id="aiAdminCancel" style="padding:8px 12px;border-radius:8px;border:1px solid rgba(42,50,66,.8);background:#1b2350;color:#e8eaf0">Cancel</button>
          <button id="aiAdminSave" style="padding:8px 12px;border-radius:8px;border:1px solid rgba(42,50,66,.8);background:#F3C400;color:#1a1a1a;font-weight:700">Save</button>
        </div>
      </div>`;
    document.body.appendChild(dlg);
  }
  byId('aiLoc').value = meta.location||''; byId('aiSize').value = meta.size||''; dlg.style.display='grid';
  byId('aiAdminCancel').onclick = ()=>{ dlg.style.display='none'; };
  byId('aiAdminSave').onclick = ()=>{ const next = { location: byId('aiLoc').value.trim(), size: byId('aiSize').value.trim() }; savePropertyMeta(exp,next); dlg.style.display='none'; speak('Saved property details.'); };
}

function normalize(str){ return String(str||'').toLowerCase().replace(/\s+/g,' ').trim(); }
function intentFromText(text, zones){
  const t = normalize(text);
  if (/^(go|take) (me )?(to|towards) /.test(t)){ const name = t.replace(/^(go|take) (me )?(to|towards) /,'').replace(/^the\s+/,''); return { type:'zone', name }; }
  if (/(next|another) (view|spot|point)/.test(t) || /(move|go) (ahead|forward)/.test(t)) return { type:'next' };
  if (/(previous|prev|back) (view|spot|point)/.test(t) || /(go|move) back/.test(t)) return { type:'prev' };
  for (const z of zones||[]){ const n=normalize(z.name||z.id); if (n && (t===n || t.includes(n))) return { type:'zone', name:n } }
  return { type:'qa', text };
}

export async function initAIAgent({ roomId = 'demo', exp, experiencesMeta = [] } = {}){
  const api = await initAgent({ roomId, exp, experiencesMeta });
  createPanel(); ensureStatusUI();
  ensureKeyButton(()=>{ const ok = (API_PROXY.length>0) || (getApiKey().length>0); setStatus(ok? 'AI ready':'AI key missing', ok); speak(ok? 'API key saved.' : 'No API key set.'); });

  const meta = api.getContext?.() || { zones:[], exp:exp||'' };
  const zones = (meta.zones||[]).map(z=>({ id:z.id, name:z.name||z.id }));
  const zoneList = zones.map(z=>z.name).filter(Boolean).join(', ');
  speak(`Welcome! I will guide you through this property. Available zones are: ${zoneList || 'not specified'}. Which zone would you like to visit?`);

  let canLLM = (API_PROXY.length>0) || (getApiKey().length > 0); setStatus(canLLM? 'AI ready':'AI key missing', canLLM);
  const history = [];

  async function askLLM(userText){
    const prop = loadPropertyMeta(meta.exp||exp||'');
    const facts = [ prop.location? `Location: ${prop.location}`:null, prop.size? `Size: ${prop.size}`:null, zones.length? `Zones: ${zones.map(z=>z.name).join(', ')}`:null ].filter(Boolean).join('\n');
    const system = `You are a helpful real estate tour assistant.\n`+
      `Return a strict JSON object with keys: { "action": "goto_zone|next_view|prev_view|answer", "target": "<zone-or-empty>", "reply": "<short reply>" }\n`+
      `Use goto_zone when asked to move; next_view/prev_view for navigation; otherwise answer.\n`+
      `Context:\n${facts}`;
    const messages = [{ role:'system', content: system }, ...history.slice(-6), { role:'user', content:userText }];
    try{
      setStatus('Thinking...', canLLM);
      let data;
      if (API_PROXY){
        const res = await fetch(`${API_PROXY}/chat`, { method:'POST', headers:{ 'Content-Type':'application/json' }, body: JSON.stringify({ messages, model:'gpt-4o', temperature:0.3, max_tokens:220 }) });
        if (!res.ok) throw new Error('proxy-chat-'+res.status);
        data = await res.json();
      } else {
        const apiKey = getApiKey(); if (!apiKey) throw new Error('missing-key');
        const res = await fetch('https://api.openai.com/v1/chat/completions',{ method:'POST', headers:{ 'Content-Type':'application/json', 'Authorization':`Bearer ${apiKey}` }, body: JSON.stringify({ model:'gpt-4o', messages, temperature:0.3, max_tokens:220 }) });
        if (!res.ok) throw new Error('chat-failed-'+res.status);
        data = await res.json();
      }
      const out = data?.choices?.[0]?.message?.content?.trim() || '';
      history.push({ role:'user', content:userText });
      try { const parsed = JSON.parse(out); const say=(parsed?.reply||'').trim()||out; history.push({ role:'assistant', content:say }); return parsed; }
      catch { history.push({ role:'assistant', content: out }); return { action:'answer', target:'', reply: out || 'Okay.' }; }
    }catch{ return { action:'answer', target:'', reply:'I had trouble thinking just now.' }; }
  }

  async function handleCommand(text){
    stopAudio();
    let parsed=null; if (canLLM) parsed = await askLLM(text);
    if (parsed){
      const a=(parsed?.action||'').toLowerCase(); const target=(parsed?.target||'').toString(); const reply=parsed?.reply||'';
      if (a==='goto_zone' && target){ await api.goToZoneByName?.(target); setStatus(`Went to ${target}`); speak(reply||`Taking you to ${target}.`); return; }
      if (a==='next_view'){ await api.goToNextInZone?.(); setStatus('Next view'); speak(reply||'Moving to the next view.'); return; }
      if (a==='prev_view'){ await api.goToPrevInZone?.(); setStatus('Previous view'); speak(reply||'Going back to the previous view.'); return; }
      if (reply){ setStatus('Answered', true); speak(reply); return; }
    }
    const it = intentFromText(text, zones);
    if (it.type==='zone'){ await api.goToZoneByName?.(it.name); setStatus(`Went to ${it.name}`); speak(`Taking you to ${it.name}.`); return; }
    if (it.type==='next'){ await api.goToNextInZone?.(); setStatus('Next view'); speak('Moving to the next view in this zone.'); return; }
    if (it.type==='prev'){ await api.goToPrevInZone?.(); setStatus('Previous view'); speak('Going back to the previous view.'); return; }
    setStatus('Say a zone name'); speak('I can guide you between zones or answer property questions.');
  }

  // Mic + transcription
  const micBtn = byId('aiMic'); const sendBtn = byId('aiSend'); const txt = byId('aiText'); const adminBtn = byId('aiAdmin');
  adminBtn?.addEventListener('click', ()=>showAdmin(meta.exp||exp||''));

  let useSR=false, rec=null, srEnabled=false, listening=false, restartTimer=null;
  try{ const SR = window.SpeechRecognition || window.webkitSpeechRecognition; if (SR){ rec=new SR(); rec.lang=navigator.language||'en-US'; rec.continuous=true; rec.interimResults=true; rec.maxAlternatives=1; srEnabled=true; } }catch{}
  if (srEnabled){
    rec.onresult = (e)=>{ try{ const r=e.results?.[e.results.length-1]; if(r?.isFinal){ const t=r[0]?.transcript; if(t) handleCommand(t); } }catch{} };
    rec.onerror = ()=>{ if(listening){ useSR=false; try{ rec.stop(); }catch{} startWhisperLoop(); } };
    rec.onend = ()=>{ if (useSR && listening){ clearTimeout(restartTimer); restartTimer=setTimeout(()=>{ try{ rec.start(); }catch{ if(listening){ useSR=false; startWhisperLoop(); } } }, 300); } };
  }
  let mediaStream=null, mediaRec=null;
  function updateMicUI(active){ try{ micBtn.style.opacity = active? '1':'0.9'; micBtn.textContent = active? 'REC':'MIC'; }catch{} }
  async function ensureMedia(){ if (mediaStream) return true; try{ mediaStream=await navigator.mediaDevices.getUserMedia({audio:true}); return true; }catch{ return false; } }
  async function startWhisperLoop(){ const ok=await ensureMedia(); if(!ok) return; try{ if(mediaRec) return; mediaRec = new MediaRecorder(mediaStream, { mimeType:'audio/webm' }); }catch{ try{ mediaRec=new MediaRecorder(mediaStream); }catch{ mediaRec=null; return; } }
    mediaRec.ondataavailable = async (ev)=>{ console.debug('[AI] sending chunk to Whisper'); try{ const blob=ev.data; if(!blob||!blob.size) return; const fd=new FormData(); let ext='webm'; const mt=(blob.type||'').toLowerCase(); if(mt.includes('mp4')) ext='mp4'; else if(mt.includes('wav')) ext='wav'; else if(mt.includes('mpeg')) ext='mp3'; else if(mt.includes('ogg')) ext='ogg'; fd.append('file', blob, `speech.${ext}`); fd.append('model','whisper-1'); let res; if (API_PROXY){ res = await fetch(`${API_PROXY}/transcribe`, { method:'POST', body: fd }); } else { const apiKey=getApiKey(); if(!apiKey){ setStatus('AI key missing', false); return; } res = await fetch('https://api.openai.com/v1/audio/transcriptions', { method:'POST', headers:{ 'Authorization':`Bearer ${apiKey}` }, body:fd }); } if(!res.ok){ const t=await res.text().catch(()=>''), msg=`Transcribe failed (${res.status})`; setStatus(msg, false); try{ console.error('[AI] transcribe error', res.status, t); }catch{}; return; } const data=await res.json(); const text=(data?.text||'').trim(); if(text) handleCommand(text); }catch(e){ try{ console.error('[AI] transcribe fetch failed', e); }catch{} } };
    mediaRec.start(2500); setStatus('Listening (Whisper)'); }
  function stopWhisperLoop(){ try{ mediaRec?.stop?.(); }catch{} mediaRec=null; try{ mediaStream?.getTracks?.().forEach(t=>t.stop()); }catch{} mediaStream=null; }

  function startSR(){ if(!rec) return; try{ stopWhisperLoop(); rec.start(); useSR=true; listening=true; updateMicUI(true); setStatus('Listening (Voice)'); }catch{ useSR=false; startWhisperLoop(); } }
  function stopSR(){ if(!rec) return; try{ rec.stop(); }catch{} listening=false; updateMicUI(false); }

  micBtn?.addEventListener('click', async ()=>{
    if (!listening){ stopAudio(); if (srEnabled){ startSR(); } else if (API_PROXY || getApiKey()){ listening=true; updateMicUI(true); await startWhisperLoop(); } else { speak('Microphone not supported here. You can type your question.'); } }
    else { if (srEnabled){ useSR=false; stopSR(); } stopWhisperLoop(); listening=false; updateMicUI(false); }
  });
  setTimeout(()=>{ try{ micBtn?.click?.(); }catch{} }, 250);
  sendBtn?.addEventListener('click', ()=>{ const v=txt?.value?.trim(); if(v){ handleCommand(v); txt.value=''; }});
  txt?.addEventListener('keydown', (e)=>{ if(e.key==='Enter'){ e.preventDefault(); const v=txt?.value?.trim(); if(v){ handleCommand(v); txt.value=''; } } });

  return api;
}
