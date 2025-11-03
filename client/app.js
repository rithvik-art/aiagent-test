// Babylon scene setup (using global BABYLON from CDN)
const canvas = document.getElementById("renderCanvas");
const engine = new BABYLON.Engine(canvas, true, {
  preserveDrawingBuffer: true,
  stencil: false,
  antialias: true,
  adaptToDeviceRatio: false,
});
const scene = new BABYLON.Scene(engine);
scene.clearColor = new BABYLON.Color4(0, 0, 0, 1);

// Adaptive quality (High by default)
let qualityMode = "high"; // "high" | "balanced"
function applyQuality() {
  const dpr = Math.min(window.devicePixelRatio || 1, 2);
  if (qualityMode === "high") engine.setHardwareScalingLevel(1 / dpr);
  else engine.setHardwareScalingLevel(Math.max(1 / dpr, 0.75));
}
applyQuality();

// Camera
const camera = new BABYLON.ArcRotateCamera("Camera", 0, 1.3, 5, BABYLON.Vector3.Zero(), scene);
camera.attachControl(canvas, true);
// Add device orientation input for mobile (fallback immersive feel)
if (camera.inputs && camera.inputs.addDeviceOrientation) {
  camera.inputs.addDeviceOrientation();
}

// PhotoDome setup for 360 photos with crossfade (no black flashes)
let currentDome = null;
function createDome(url) {
  const dome = new BABYLON.PhotoDome("photoDome" + Date.now(), url, { size: 10 }, scene);
  if (dome.mesh && dome.mesh.material) {
    dome.mesh.material.backFaceCulling = false;
    dome.mesh.material.alpha = 0;
  }
  return dome;
}

engine.runRenderLoop(() => scene.render());
window.addEventListener("resize", () => { applyQuality(); engine.resize(); });

// Context loss safety
engine.onContextLostObservable.add(() => console.warn("WebGL context lost"));
engine.onContextRestoredObservable.add(() => { console.log("WebGL context restored"); applyQuality(); });

// --- Speech synthesis (AI voice reply) ---
function speak(text) {
  if (!window.speechSynthesis) return;
  const u = new SpeechSynthesisUtterance(text);
  u.rate = 1;
  u.pitch = 1;
  try { window.speechSynthesis.cancel(); } catch {}
  // Requires user gesture on iOS; tied to UI buttons
  window.speechSynthesis.speak(u);
}

// Zones and simple local knowledge to avoid API calls
const ZONES = ["living_room", "balcony", "lobby", "kitchen", "bedroom", "rooftop"];
const ZONE_ALIASES = {
  living_room: ["living room", "hall", "lounge"],
  balcony: ["balcony", "sit-out"],
  lobby: ["lobby", "entrance", "reception"],
  kitchen: ["kitchen"],
  bedroom: ["bedroom", "master", "room"],
  rooftop: ["rooftop", "terrace", "pool"]
};

const LOCAL_QA = [
  {
    match: /\b(project location|where is|located|bangalore)\b/i,
    answer: "Skyview Towers is in Bangalore with close metro access."
  },
  {
    match: /\b(amenities|features|pool|infinity)\b/i,
    answer: "Key features include 3BHK luxury units and a rooftop infinity pool."
  },
  {
    match: /\b(price|pricing|cost|rate)\b/i,
    answer: "For current pricing and offers, please speak to our sales team."
  }
];

function aliasToZone(text) {
  const t = text.toLowerCase();
  for (const [zone, aliases] of Object.entries(ZONE_ALIASES)) {
    if (aliases.some(a => t.includes(a))) return zone;
  }
  // direct exact zone name
  if (ZONES.includes(t.trim())) return t.trim();
  return null;
}

// --- Handle AI command output ---
function handleAICommand(c) {
  if (c.action === "move_to_zone" && c.zone) moveToZone(c.zone);
  else if (c.action === "rotate_view" && typeof c.angle === "number") rotateView(c.angle);
  if (c.message) speak(c.message);
}

const loadingOverlay = document.getElementById("loadingOverlay");

async function moveToZone(zone) {
  const safeZone = ZONES.includes(zone) ? zone : null;
  if (!safeZone) return speak("That zone is not available.");
  try {
    loadingOverlay?.classList.add("show");
    const url = `./assets/${safeZone}.jpg`;
    const next = createDome(url);
    if (next.photoTexture && next.photoTexture.onLoadObservable) {
      next.photoTexture.onLoadObservable.addOnce(() => {
        if (next.mesh && next.mesh.material) {
          BABYLON.Animation.CreateAndStartAnimation("fadeInDome", next.mesh.material, "alpha", 60, 24, next.mesh.material.alpha ?? 0, 1, BABYLON.Animation.ANIMATIONLOOPMODE_CONSTANT);
        }
        if (currentDome && currentDome.mesh && currentDome.mesh.material) {
          BABYLON.Animation.CreateAndStartAnimation("fadeOutDome", currentDome.mesh.material, "alpha", 60, 24, currentDome.mesh.material.alpha ?? 1, 0, BABYLON.Animation.ANIMATIONLOOPMODE_CONSTANT, undefined, () => {
            try { currentDome.dispose(); } catch {}
            currentDome = next;
            loadingOverlay?.classList.remove("show");
          });
        } else {
          currentDome = next;
          loadingOverlay?.classList.remove("show");
          if (currentDome.mesh && currentDome.mesh.material) currentDome.mesh.material.alpha = 1;
        }
      });
    } else {
      if (currentDome) try { currentDome.dispose(); } catch {}
      currentDome = next;
      if (currentDome.mesh && currentDome.mesh.material) currentDome.mesh.material.alpha = 1;
      loadingOverlay?.classList.remove("show");
    }
    console.log("Moved to zone:", safeZone);
  } catch (e) {
    loadingOverlay?.classList.remove("show");
    speak("Sorry, that view is not available.");
  }
}

function rotateView(angleDegrees) {
  camera.alpha += BABYLON.Tools.ToRadians(angleDegrees);
}

// --- Token-optimized backend call ---
const API_BASE = (location.hostname === 'localhost' || location.hostname === '127.0.0.1')
  ? 'http://localhost:3000'
  : '';

async function sendToAI(msg) {
  try {
    const isLocal = !!API_BASE;
    const body = isLocal
      ? { userMessage: msg }
      : {
          // Netlify Function format
          system: "You are an ultra-concise AI real-estate guide for Skyview Towers, Bangalore. Reply with JSON when possible.",
          user: msg,
          model: "gpt-3.5-turbo",
          temperature: 0.3,
          max_tokens: 150
        };
    const r = await fetch(`${API_BASE}/api/chat`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body)
    });
    const data = await r.json();
    const reply = data?.choices?.[0]?.message?.content || '';
    if (!reply) return;
    try {
      const cmd = JSON.parse(reply);
      if (cmd && typeof cmd === 'object') handleAICommand(cmd);
    } catch {
      if (/^\s*[{[]/.test(reply)) return; // never read JSON aloud
      const clean = String(reply).replace(/json|\{|\}|"|`/gi, '').slice(0, 200);
      if (clean.trim()) speak(clean.trim());
    }
  } catch (e) {
    console.error(e);
    speak("Sorry, I had trouble reaching the server.");
  }
}

// --- Local Intent Router (saves tokens) ---
function parseAngle(text, def = 90) {
  const m = text.match(/(\d{1,3})\s*degree/);
  return m ? Math.min(180, Math.max(1, parseInt(m[1], 10))) : def;
}

function tryHandleLocally(raw) {
  const text = raw.toLowerCase();

  // Move intent
  if (/\b(go|move|take|show)\b.*\b(to|me to)\b/.test(text)) {
    const zone = aliasToZone(text);
    if (zone) {
      moveToZone(zone);
      speak(`Moving to ${zone.replace("_", " ")}.`);
      return true;
    }
  }

  // Rotate intent
  if (/\b(rotate|turn)\b/.test(text)) {
    const left = /\b(left|anticlockwise|anti-clockwise)\b/.test(text);
    const right = /\b(right|clockwise)\b/.test(text);
    const angle = parseAngle(text, 90);
    if (left || right) {
      rotateView(right ? angle : -angle);
      speak(`Rotating ${right ? "right" : "left"}.`);
      return true;
    }
  }

  // Zone direct mention without verb
  const zoneOnly = aliasToZone(text);
  if (zoneOnly) {
    moveToZone(zoneOnly);
    speak(`Moving to ${zoneOnly.replace("_", " ")}.`);
    return true;
  }

  // Simple local Q&A
  for (const qa of LOCAL_QA) {
    if (qa.match.test(text)) {
      speak(qa.answer);
      return true;
    }
  }

  return false;
}

// --- Voice input (SpeechRecognition) with toggle + PTT ---
window.SpeechRecognition = window.SpeechRecognition || window.webkitSpeechRecognition;
const recognition = window.SpeechRecognition ? new window.SpeechRecognition() : null;
const micDot = document.getElementById("micDot");
const toggleBtn = document.getElementById("toggleBtn");
const pttBtn = document.getElementById("pttBtn");
const greetBtn = document.getElementById("greetBtn");
const qualityBtn = document.getElementById("qualityBtn");
const vrBtn = document.getElementById("vrBtn");

let alwaysListening = false;
let isActive = false;

function setListening(active) {
  isActive = active;
  micDot.classList.toggle("listening", active);
  toggleBtn.textContent = active ? "Disable Voice" : "Enable Voice";
}

if (recognition) {
  recognition.lang = "en-IN"; // adjust as needed
  recognition.interimResults = false;
  recognition.continuous = false; // manual restart for reliability

  let backoff = 250;
  recognition.onresult = (e) => {
    const transcript = e.results[0][0].transcript;
    console.log("Heard:", transcript);
    const handled = tryHandleLocally(transcript);
    if (!handled) sendToAI(transcript);
    backoff = 250;
  };
  recognition.onend = () => {
    setListening(false);
    if (alwaysListening) setTimeout(() => { tryStartRecognition(); backoff = Math.min(backoff * 2, 2000); }, backoff);
  };
  recognition.onerror = () => setListening(false);
}

function tryStartRecognition() {
  if (!recognition) return;
  try { recognition.start(); setListening(true); } catch {}
}

toggleBtn.addEventListener("click", () => {
  if (!recognition) { speak("Voice input is unsupported on this device."); return; }
  alwaysListening = !alwaysListening;
  if (alwaysListening) tryStartRecognition(); else { try { recognition.stop(); } catch {}; setListening(false); }
});

// Press-To-Talk (works on Android Chrome; iOS lacks SpeechRecognition)
const startPTT = () => { if (recognition) tryStartRecognition(); };
const stopPTT = () => { if (recognition) { try { recognition.stop(); } catch {} } };
pttBtn.addEventListener("mousedown", startPTT);
pttBtn.addEventListener("mouseup", stopPTT);
pttBtn.addEventListener("mouseleave", stopPTT);
pttBtn.addEventListener("touchstart", (e)=>{ e.preventDefault(); startPTT(); }, { passive: false });
pttBtn.addEventListener("touchend", (e)=>{ e.preventDefault(); stopPTT(); }, { passive: false });

greetBtn.addEventListener("click", () => {
  // First user gesture: allow TTS to speak reliably
  speak("Welcome to Skyview Towers. Say a zone like living room or balcony, or tap a chip below.");
});

qualityBtn.addEventListener("click", () => {
  qualityMode = qualityMode === "high" ? "balanced" : "high";
  qualityBtn.textContent = `Quality: ${qualityMode === "high" ? "High" : "Balanced"}`;
  applyQuality();
});

// Quick action chips (mobile-friendly)
const chipsEl = document.getElementById("chips");
const chip = (label, handler) => {
  const b = document.createElement("button"); b.className = "chip"; b.textContent = label; b.addEventListener("click", handler); return b;
};
ZONES.forEach(z => chipsEl.appendChild(chip(z.replace("_"," "), () => moveToZone(z))));
chipsEl.appendChild(chip("Rotate Left", () => rotateView(-90)));
chipsEl.appendChild(chip("Rotate Right", () => rotateView(90)));

// WebXR (VR) support detection
let xrHelper = null;
async function setupXR() {
  try {
    if (navigator.xr && await navigator.xr.isSessionSupported('immersive-vr')) {
      xrHelper = await scene.createDefaultXRExperienceAsync({ disableDefaultUI: true });
      vrBtn.style.display = '';
      vrBtn.onclick = async () => { try { await xrHelper.baseExperience.enterXRAsync('immersive-vr', 'local-floor'); } catch {} };
    } else {
      vrBtn.style.display = 'none';
    }
  } catch { vrBtn.style.display = 'none'; }
}
setupXR();

// Preload initial view (no TTS auto-play) with PhotoDome
if (loadingOverlay) loadingOverlay.classList.add('show');
currentDome = createDome('./assets/living_room.jpg');
if (currentDome.photoTexture && currentDome.photoTexture.onLoadObservable) {
  currentDome.photoTexture.onLoadObservable.addOnce(() => {
    if (currentDome.mesh && currentDome.mesh.material) currentDome.mesh.material.alpha = 1;
    loadingOverlay?.classList.remove('show');
  });
} else {
  if (currentDome.mesh && currentDome.mesh.material) currentDome.mesh.material.alpha = 1;
  loadingOverlay?.classList.remove('show');
}

// Hide voice controls if recognition unsupported (iOS Safari)
if (!recognition) {
  toggleBtn.style.display = 'none';
  pttBtn.style.display = 'none';
  micDot.style.display = 'none';
}
