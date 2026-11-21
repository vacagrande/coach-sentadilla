// Coach de Gym (web): camera -> pose -> overlay, beep at the target and spoken feedback per rep.
// Exercise-specific logic lives in squat.js / curl.js (see exercises.js).
import { DEFAULT_EXERCISE, EXERCISES } from './exercises.js';
import { IS_IOS, PoseEngine } from './pose.js';

// The camera is shown by the <video> itself at its native frame rate. The model analyses frames as fast as
// the phone allows, and a transparent canvas on top draws the skeleton, eased between analyses.
const OVERLAY_TAU_MS = 45; // how quickly the drawn lines catch up with the latest analysis
const OVERLAY_MAX_SIDE = 2560; // cap for the overlay's pixel size
const OVERLAY_SETTLED_PX = 0.25; // stop repainting once the lines are this close to their target
const STALL_MS = 2500; // camera delivering no frames for this long: restart it
const BANNER_S = 4;
const HIT_FLASH_S = 1;
const SET_REST_S = 8; // this long without reps closes the set and speaks a summary
const SLOW_FPS = 8;
const HISTORY_MAX = 30;
const SETTINGS_KEY = 'squat-coach.settings.v2'; // v2: fast model is the default on iPhone
const HISTORY_KEY = 'squat-coach.history';
const ALIVE_KEY = 'squat-coach.alive'; // heartbeat while the camera runs: still set on next load = the page died
const ALIVE_EVERY_MS = 3000;
const CRASH_WINDOW_MS = 10 * 60 * 1000;

const $ = (id) => document.getElementById(id);
const params = new URLSearchParams(location.search);

function readJSON(key, fallback) {
  try {
    return JSON.parse(localStorage.getItem(key)) ?? fallback;
  } catch {
    return fallback;
  }
}

function writeJSON(key, value) {
  try {
    localStorage.setItem(key, JSON.stringify(value));
  } catch {
    // private browsing or storage full: settings just won't persist
  }
}

// iPhone: fast model by default (74 MB of memory vs 156 MB; iOS closes pages that use too much)
const stored = readJSON(SETTINGS_KEY, {});
const settings = { exercise: DEFAULT_EXERCISE, voice: true, facing: 'environment', fast: IS_IOS, ...stored };
settings.targets = { ...(stored.targets || {}) };
if (stored.target !== undefined && settings.targets.squat === undefined) settings.targets.squat = stored.target; // old format
delete settings.target;
if (!EXERCISES[settings.exercise]) settings.exercise = DEFAULT_EXERCISE;
if (params.has('fast')) settings.fast = params.get('fast') === '1';
if (EXERCISES[params.get('ex')]) settings.exercise = params.get('ex');
const allowGpu = params.get('gpu') !== '0';
const saveSettings = () => writeJSON(SETTINGS_KEY, settings);

const currentEx = () => EXERCISES[settings.exercise];
const targetFor = (ex) => settings.targets[ex.id] ?? ex.target.default;

// ---------- voice and beep ----------
class Speaker {
  constructor() {
    this.enabled = settings.voice;
    this.voice = null;
    this.audio = null;
    if ('speechSynthesis' in window) {
      this.pickVoice();
      speechSynthesis.addEventListener?.('voiceschanged', () => this.pickVoice());
    }
  }

  pickVoice() {
    const voices = speechSynthesis.getVoices().filter((v) => v.lang?.toLowerCase().startsWith('es'));
    const score = (v) =>
      (/paulina|m[oó]nica|juan|jorge/i.test(v.name) ? 4 : 0) +
      (/es[-_]mx/i.test(v.lang) ? 3 : /es[-_](us|419)/i.test(v.lang) ? 2 : 1) +
      (v.localService ? 1 : 0);
    this.voice = voices.sort((a, b) => score(b) - score(a))[0] || null;
  }

  /** Must run inside a tap: iOS only allows sound that starts from a user gesture. */
  unlock() {
    try {
      if (navigator.audioSession) navigator.audioSession.type = 'transient'; // duck music instead of stopping it
    } catch {
      /* not supported */
    }
    try {
      this.audio ??= new (window.AudioContext || window.webkitAudioContext)();
      this.audio.resume().catch(() => {}); // rejected without a tap (tests); harmless
    } catch {
      this.audio = null;
    }
    if ('speechSynthesis' in window) {
      const u = new SpeechSynthesisUtterance(' ');
      u.volume = 0;
      speechSynthesis.speak(u);
    }
  }

  say(text) {
    if (!this.enabled || !('speechSynthesis' in window)) return;
    const u = new SpeechSynthesisUtterance(text);
    u.lang = this.voice?.lang || 'es-MX';
    if (this.voice) u.voice = this.voice;
    u.rate = 1.1;
    if (speechSynthesis.speaking || speechSynthesis.pending) {
      speechSynthesis.cancel();
      setTimeout(() => speechSynthesis.speak(u), 120); // Safari drops a speak() right after cancel()
    } else {
      speechSynthesis.speak(u);
    }
  }

  beep() {
    if (!this.enabled || !this.audio) return;
    const ctx = this.audio;
    const t = ctx.currentTime;
    for (const [freq, start] of [
      [880, 0],
      [1320, 0.11],
    ]) {
      const osc = ctx.createOscillator();
      const gain = ctx.createGain();
      osc.type = 'sine';
      osc.frequency.value = freq;
      gain.gain.setValueAtTime(0.0001, t + start);
      gain.gain.exponentialRampToValueAtTime(0.6, t + start + 0.015);
      gain.gain.exponentialRampToValueAtTime(0.0001, t + start + 0.16);
      osc.connect(gain).connect(ctx.destination);
      osc.start(t + start);
      osc.stop(t + start + 0.18);
    }
  }
}

const speaker = new Speaker();

// ---------- screens ----------
function show(name) {
  for (const id of ['setup', 'live', 'summary']) $(id).hidden = id !== name;
  document.body.dataset.screen = name;
  if (name !== 'live') window.scrollTo(0, 0);
}

function showLoading(msg, fraction) {
  $('loading').hidden = false;
  $('loadMsg').textContent = msg;
  $('loadBar').value = fraction ?? 0;
}

const hideLoading = () => {
  $('loading').hidden = true;
  $('loading').classList.remove('over-camera');
};

const setStatus = (msg) => {
  $('status').textContent = msg || '';
};

function setText(el, text) {
  if (el.textContent !== text) el.textContent = text;
}

// ---------- setup screen ----------
function renderSettings() {
  const ex = currentEx();
  for (const b of document.querySelectorAll('[data-exercise]')) {
    b.setAttribute('aria-checked', String(b.dataset.exercise === ex.id));
  }
  $('exIntro').textContent = ex.intro;
  $('tLabel').textContent = ex.target.label;
  $('tHint').textContent = ex.target.hint;
  $('tValue').textContent = ex.fmt(targetFor(ex));
  $('tipsList').innerHTML = [...ex.tips, 'Sube el volumen. Con el iPhone en silencio puede que no suene.']
    .map((tip) => `<li>${tip}</li>`)
    .join('');
  $('optVoice').checked = settings.voice;
  $('optFast').checked = settings.fast;
  for (const b of document.querySelectorAll('[data-facing]')) {
    b.setAttribute('aria-checked', String(b.dataset.facing === settings.facing));
  }
}

function changeTarget(delta) {
  const ex = live?.ex ?? currentEx();
  settings.targets[ex.id] = Math.max(ex.target.min, Math.min(ex.target.max, targetFor(ex) + delta));
  saveSettings();
  renderSettings();
  if (live) live.counter.target = targetFor(ex);
}

for (const b of document.querySelectorAll('[data-exercise]')) {
  b.onclick = () => {
    settings.exercise = b.dataset.exercise;
    saveSettings();
    renderSettings();
  };
}
$('tMinus').onclick = () => changeTarget(-1);
$('tPlus').onclick = () => changeTarget(1);
$('optVoice').onchange = (e) => {
  settings.voice = speaker.enabled = e.target.checked;
  saveSettings();
};
$('optFast').onchange = (e) => {
  settings.fast = e.target.checked;
  saveSettings();
};
for (const b of document.querySelectorAll('[data-facing]')) {
  b.onclick = () => {
    settings.facing = b.dataset.facing;
    saveSettings();
    renderSettings();
  };
}
$('start').onclick = () => start({ kind: 'camera' });
$('file').onchange = (e) => {
  const f = e.target.files?.[0];
  if (f) start({ kind: 'file', url: URL.createObjectURL(f) });
  e.target.value = '';
};

// ---------- media ----------
const video = $('video');
const canvas = $('canvas'); // transparent overlay on top of the video
const ctx = canvas.getContext('2d');
let stream = null;
let wakeLock = null;

function setMirror(on) {
  video.classList.toggle('mirror', on);
  canvas.classList.toggle('mirror', on);
}

async function openCamera(facing) {
  stopMedia();
  if (!navigator.mediaDevices?.getUserMedia) throw new Error('Este navegador no da acceso a la cámara. Abre la app en Safari.');
  stream = await navigator.mediaDevices.getUserMedia({
    audio: false,
    video: { facingMode: { ideal: facing }, width: { ideal: 1280 }, height: { ideal: 720 }, frameRate: { ideal: 30 } },
  });
  stream.getVideoTracks()[0]?.addEventListener('ended', onCameraEnded);
  video.srcObject = stream;
  video.loop = false;
  await video.play();
  setMirror(facing === 'user');
}

async function openFile(url) {
  stopMedia();
  video.srcObject = null;
  video.src = url;
  video.loop = false;
  video.currentTime = 0;
  await video.play();
  setMirror(false);
}

function stopMedia() {
  if (stream) for (const tr of stream.getTracks()) tr.stop();
  stream = null;
  video.pause();
}

let lastCameraRetry = 0;

/** iOS can cut the camera (memory, a call, another app using it): try to get it back once. */
async function onCameraEnded() {
  if (!live || live.source.kind !== 'camera' || document.visibilityState !== 'visible') return;
  const now = performance.now();
  if (now - lastCameraRetry < 5000) {
    flash('La cámara se detuvo. Toca Terminar y vuelve a empezar.', 6);
    return;
  }
  lastCameraRetry = now;
  flash('La cámara se detuvo; reintentando…', 3);
  try {
    await openCamera(settings.facing);
    startLoop();
  } catch (err) {
    flash(errorMessage(err), 6);
  }
}

// ---------- crash detection and error reporting ----------
let aliveTimer = null;

function markAlive() {
  try {
    localStorage.setItem(ALIVE_KEY, String(Date.now()));
  } catch {
    /* storage unavailable */
  }
}

function startAlive() {
  markAlive();
  clearInterval(aliveTimer);
  aliveTimer = setInterval(markAlive, ALIVE_EVERY_MS);
}

function stopAlive() {
  clearInterval(aliveTimer);
  aliveTimer = null;
  try {
    localStorage.removeItem(ALIVE_KEY);
  } catch {
    /* storage unavailable */
  }
}

/** If the last session left its heartbeat behind, iOS closed the page (usually memory). Switch to the light model. */
function checkPreviousCrash() {
  let last = 0;
  try {
    last = Number(localStorage.getItem(ALIVE_KEY)) || 0;
  } catch {
    return;
  }
  stopAlive();
  if (!last || Date.now() - last > CRASH_WINDOW_MS) return;
  if (!settings.fast) {
    settings.fast = true;
    saveSettings();
    setStatus(
      'La app se cerró sola mientras usaba la cámara (el teléfono se quedó sin memoria). ' +
        'Activé el Modo rápido, que usa la mitad de memoria. Toca Empezar otra vez.',
    );
  } else {
    setStatus(
      'La app se cerró sola otra vez mientras usaba la cámara. Cierra las otras apps abiertas ' +
        '(sobre todo pestañas de Safari) y vuelve a intentar.',
    );
  }
}

let lastError = '';

function reportError(msg) {
  if (!msg || msg === lastError) return;
  lastError = msg;
  console.error(msg);
  if (live) flash(`Error: ${msg}`, 5);
  else setStatus(`Error: ${msg}`);
}

window.addEventListener('error', (e) => reportError(e.message));
window.addEventListener('unhandledrejection', (e) => reportError(e.reason?.message || String(e.reason)));

async function requestWakeLock() {
  try {
    wakeLock = await navigator.wakeLock?.request('screen');
  } catch {
    wakeLock = null; // not supported or denied: the screen may dim
  }
}

function releaseWakeLock() {
  wakeLock?.release().catch(() => {});
  wakeLock = null;
}

function errorMessage(err) {
  if (err?.name === 'NotAllowedError') {
    return 'Necesito permiso para usar la cámara. En el iPhone: Ajustes → Safari → Cámara → Permitir, y vuelve a intentar.';
  }
  if (err?.name === 'NotFoundError' || err?.name === 'OverconstrainedError') return 'No encontré una cámara disponible.';
  return `No pude empezar: ${err?.message || err}`;
}

// ---------- engine ----------
let engine = null;

async function getEngine() {
  const variant = settings.fast ? 'fast' : 'precise';
  if (engine?.variant === variant) return engine;
  showLoading('Preparando…', 0);
  engine = await PoseEngine.load(variant, { allowGpu, onProgress: (f, msg) => showLoading(msg, f) });
  return engine;
}

// ---------- live session ----------
let live = null;
let lastSource = null;
let started = false; // the user tapped Empezar at least once: never auto-reload after this

function newLive(source) {
  const ex = currentEx();
  return {
    source,
    ex,
    running: true,
    filter: ex.makeFilter(),
    counter: ex.makeCounter(targetFor(ex)),
    banner: null,
    hitFlashUntil: 0,
    lastRepT: 0,
    setReps: [],
    t0: performance.now(),
    fps: 0,
    lastAnalysis: 0,
    lastFrameAt: performance.now(),
    startedAt: performance.now(),
    pose: null, // latest analysed joints (video pixels); the overlay eases toward them
    drawn: null, // joints as currently drawn
    lastDraw: 0,
    overlayKey: '',
  };
}

async function start(source) {
  speaker.unlock(); // inside the tap, before any await
  started = true;
  navigator.storage?.persist?.().catch(() => {});
  setStatus('');
  startAlive(); // covers model loading too, the moment memory peaks
  const stepping = source.kind === 'file' && params.get('step') === '1';
  try {
    // Camera first: the permission prompt comes right after the tap and the image is already
    // on screen (behind the progress bar) while the model loads.
    showLoading(source.kind === 'camera' ? 'Abriendo la cámara…' : 'Abriendo el video…', 0);
    if (source.kind === 'camera') await openCamera(settings.facing);
    else await openFile(source.url);
    if (source.kind === 'file') video.pause(); // a clip waits on its first frame until the model is ready
    resetHud(currentEx());
    clearOverlay();
    show('live');
    $('loading').classList.add('over-camera');
    const eng = await getEngine();
    eng.reset();
    if (source.kind === 'file' && !stepping) await video.play();
    lastSource = source;
    live = newLive(source);
    hideLoading();
    renderControls();
    requestWakeLock();
    speaker.say(live.ex.ready);
    startOverlay();
    if (stepping) stepThrough();
    else startLoop();
  } catch (err) {
    console.error(err);
    stopAlive();
    stopMedia();
    hideLoading();
    show('setup');
    setStatus(errorMessage(err));
  }
}

/** Test mode (?step=1): analyse every frame of a 30 fps clip by seeking, independent of screen refresh. */
async function stepThrough(fps = 30) {
  const st = live;
  video.pause();
  const seek = (t) =>
    new Promise((resolve) => {
      video.addEventListener('seeked', resolve, { once: true });
      video.currentTime = t;
    });
  for (let i = 0; live === st && i / fps < video.duration; i++) {
    await seek(i / fps);
    await processFrame({ mediaTime: i / fps });
  }
  if (live === st) finish();
}

// ---------- analysis loop: one model run per new camera frame, as fast as the phone allows ----------
let loopGen = 0;
let analysing = false;

// Test hook (?loop=poll[&slow=ms]): browsers deliver frame callbacks only once per second while a page is
// off screen, which is how automated tests run. This drives the loop by watching the video clock instead,
// and `slow` adds a pause per analysis to imitate a slower phone.
const POLL_TEST = params.get('loop') === 'poll';
const SLOW_TEST_MS = Number(params.get('slow')) || 0;
const pollChannel = POLL_TEST ? new MessageChannel() : null;
let pollLastT = -1;

function pollFrame(cb) {
  const notBefore = performance.now() + SLOW_TEST_MS;
  pollChannel.port1.onmessage = () => {
    if (performance.now() >= notBefore && video.currentTime !== pollLastT) {
      pollLastT = video.currentTime;
      cb(performance.now(), { mediaTime: video.currentTime });
    } else if (live?.running) {
      pollChannel.port2.postMessage(0);
    }
  };
  pollChannel.port2.postMessage(0);
}

function requestFrame(cb) {
  if (POLL_TEST) pollFrame(cb);
  else if (typeof video.requestVideoFrameCallback === 'function') video.requestVideoFrameCallback(cb);
  else requestAnimationFrame((now) => cb(now, null));
}

/**
 * (Re)start the analysis loop. Any loop started earlier stops at its next callback, so reopening the
 * camera (switch, return from background) can never leave two loops fighting over the model.
 */
function startLoop() {
  const gen = ++loopGen;
  const tick = async (_now, meta) => {
    if (gen !== loopGen || !live?.running) return;
    if (!analysing && video.readyState >= 2 && video.videoWidth) {
      analysing = true;
      try {
        await processFrame(meta);
      } catch (err) {
        reportError(err?.message || String(err));
      } finally {
        analysing = false;
      }
    }
    if (gen === loopGen && live?.running) requestFrame(tick);
  };
  requestFrame(tick);
}

async function processFrame(meta) {
  const st = live;
  const ex = st.ex;
  const target = targetFor(ex);
  const t = st.source.kind === 'file' ? (meta?.mediaTime ?? video.currentTime) : (performance.now() - st.t0) / 1000;

  // the model crops what it needs straight from the video (joints come back in video pixels)
  const found = await engine.process(video, video.videoWidth, video.videoHeight, t);
  if (live !== st) return; // session ended while the model was running
  st.lastFrameAt = performance.now();

  const xy = st.filter.update(found, t);
  const value = xy ? ex.value(xy) : null;
  if (xy) for (const ev of st.counter.update(t, xy)) onEvent(st, ev, t);
  if (st.setReps.length && !st.counter.inRep && t - st.lastRepT > SET_REST_S) {
    const p = ex.setPhrase(st.setReps, target);
    speaker.say(p.spoken);
    st.banner = { text: p.text, color: 'white', until: t + BANNER_S * 2 };
    st.setReps = [];
  }
  st.pose = xy;
  renderHud(st, t, value, xy);
  renderFps(st);
}

// ---------- overlay loop: redraws the skeleton on every screen refresh, eased toward the latest analysis ----------
let overlayGen = 0;
let overlayDirty = true; // the canvas needs re-fitting (rotation, resize, new video size)
let overlayFor = '';

function clearOverlay() {
  ctx.setTransform(1, 0, 0, 1, 0, 0);
  ctx.clearRect(0, 0, canvas.width, canvas.height);
}

/** Size the canvas to the pixels the video really covers on screen, so the lines are sharp. */
function fitOverlay(vw, vh) {
  const box = canvas.getBoundingClientRect();
  const dpr = Math.min(window.devicePixelRatio || 1, 3);
  let k = box.width && box.height ? Math.min(box.width / vw, box.height / vh) * dpr : 1;
  k = Math.min(k, OVERLAY_MAX_SIDE / Math.max(vw, vh));
  const cw = Math.max(2, Math.round(vw * k));
  const ch = Math.max(2, Math.round(vh * k));
  if (canvas.width !== cw || canvas.height !== ch) {
    canvas.width = cw;
    canvas.height = ch;
  }
  overlayFor = `${vw}x${vh}`;
  overlayDirty = false;
}

function drawOverlay(st, now) {
  const vw = video.videoWidth;
  const vh = video.videoHeight;
  if (!vw || !vh) return;
  let repaint = false;
  if (overlayDirty || overlayFor !== `${vw}x${vh}`) {
    fitOverlay(vw, vh);
    repaint = true;
  }
  const pose = st.pose;
  if (!pose) {
    if (st.drawn || repaint) clearOverlay();
    st.drawn = null;
    st.lastDraw = now;
    return;
  }
  const a = st.drawn ? 1 - Math.exp(-(now - st.lastDraw) / OVERLAY_TAU_MS) : 1;
  st.lastDraw = now;
  st.drawn ??= {};
  let moved = 0;
  for (const name in pose) {
    const p = pose[name];
    const d = st.drawn[name] || p;
    const x = d[0] + (p[0] - d[0]) * a;
    const y = d[1] + (p[1] - d[1]) * a;
    moved = Math.max(moved, Math.abs(p[0] - d[0]), Math.abs(p[1] - d[1]));
    st.drawn[name] = [x, y];
  }
  const target = targetFor(st.ex);
  const key = `${st.counter.inRep}|${target}`;
  const k = canvas.width / vw;
  if (!repaint && key === st.overlayKey && moved * k < OVERLAY_SETTLED_PX) return; // nothing visibly changed
  st.overlayKey = key;
  clearOverlay();
  ctx.setTransform(k, 0, 0, k, 0, 0);
  st.ex.draw(ctx, st.drawn, target, st.counter.inRep, Math.min(vw, vh) / 720);
}

function startOverlay() {
  const gen = ++overlayGen;
  const frame = (now) => {
    const st = live;
    if (gen !== overlayGen || !st?.running) return;
    drawOverlay(st, now);
    requestAnimationFrame(frame);
  };
  requestAnimationFrame(frame);
}

const markOverlayDirty = () => {
  overlayDirty = true;
};
window.addEventListener('resize', markOverlayDirty);
window.addEventListener('orientationchange', markOverlayDirty);
video.addEventListener('resize', markOverlayDirty);

// Watchdog: if the camera stops delivering frames (iOS pauses it now and then), wake it up.
setInterval(() => {
  const st = live;
  if (!st?.running || st.source.kind !== 'camera' || document.visibilityState !== 'visible') return;
  if (analysing || performance.now() - st.lastFrameAt < STALL_MS) return;
  st.lastFrameAt = performance.now();
  const track = stream?.getVideoTracks()[0];
  if (!track || track.readyState === 'ended') {
    onCameraEnded();
    return;
  }
  video.play().catch(() => {});
  startLoop();
}, 1000);

function onEvent(st, ev, t) {
  if (ev.kind === 'depth') {
    speaker.beep();
    st.hitFlashUntil = t + HIT_FLASH_S;
    return;
  }
  const fb = st.ex.repFeedback(ev.rep, targetFor(st.ex));
  speaker.say(fb.spoken);
  st.banner = { text: fb.text, color: fb.color, until: t + BANNER_S };
  st.lastRepT = t;
  st.setReps.push(ev.rep);
}

function gaugeY(ex, v) {
  const { top, bottom } = ex.gauge;
  const c = Math.max(bottom, Math.min(top, v));
  return `${((top - c) / (top - bottom)) * 100}%`;
}

// The HUD is refreshed on every analysis: look the elements up once and only touch what changed.
const el = Object.fromEntries(
  [
    'repCount',
    'metricName',
    'you',
    'youLabel',
    'targetText',
    'targetLabel',
    'banner',
    'gZone',
    'gParallel',
    'gTarget',
    'gMin',
    'gDot',
    'fps',
  ].map((id) => [id, $(id)]),
);

function setTop(node, top) {
  if (node.dataset.top !== top) {
    node.dataset.top = top;
    node.style.top = top;
  }
}

function setHidden(node, hidden) {
  if (node.hidden !== hidden) node.hidden = hidden;
}

function resetHud(ex) {
  const target = targetFor(ex);
  setText(el.repCount, 'Rep 0');
  setText(el.metricName, ex.metric);
  setText(el.you, 'Tú —');
  setText(el.youLabel, '');
  setText(el.targetText, `Objetivo ${ex.fmt(target)}`);
  setText(el.targetLabel, ex.positionLabel(target, target));
  setText(el.fps, '');
  for (const node of [el.banner, el.gMin, el.gDot]) setHidden(node, true);
}

function renderHud(st, t, value, xy) {
  const ex = st.ex;
  const target = targetFor(ex);
  setText(el.repCount, `Rep ${st.counter.reps.length}`);
  setText(el.metricName, ex.metric);
  setText(el.you, value == null ? 'Tú —' : `Tú ${ex.fmt(value)}`);
  setText(el.youLabel, value == null ? '' : ex.positionLabel(value, target));
  setText(el.targetText, `Objetivo ${ex.fmt(target)}`);
  setText(el.targetLabel, ex.positionLabel(target, target));

  let note = null;
  if (t < st.hitFlashUntil) note = { text: ex.hit, color: 'green' };
  else if (st.banner && t < st.banner.until) note = st.banner;
  else if (!xy) note = { text: ex.lost, color: 'orange' };
  setHidden(el.banner, !note);
  if (note) {
    setText(el.banner, note.text);
    if (el.banner.dataset.color !== note.color) el.banner.dataset.color = note.color;
  }

  const zone = target + ex.tol;
  setTop(el.gZone, gaugeY(ex, zone));
  setTop(el.gParallel, gaugeY(ex, ex.gauge.ref));
  setTop(el.gTarget, gaugeY(ex, target));
  setHidden(el.gMin, !st.counter.inRep);
  if (st.counter.inRep) setTop(el.gMin, gaugeY(ex, st.counter.peak));
  setHidden(el.gDot, value == null);
  if (value != null) {
    setTop(el.gDot, gaugeY(ex, value));
    el.gDot.classList.toggle('hit', value <= zone);
  }
}

/** Bottom line: how many analyses per second the model manages (the camera image itself runs at its own rate). */
function renderFps(st) {
  const now = performance.now();
  if (st.lastAnalysis) {
    const inst = 1000 / Math.max(now - st.lastAnalysis, 1);
    st.fps = st.fps ? 0.9 * st.fps + 0.1 * inst : inst;
  }
  st.lastAnalysis = now;
  const slow = st.fps < SLOW_FPS && now - st.startedAt > 4000 && engine.variant !== 'fast';
  const threads = engine.threads > 1 ? ` ×${engine.threads}` : '';
  const text = `${st.fps.toFixed(0)} análisis/s · ${engine.backend}${threads} · ${engine.variant === 'fast' ? 'rápido' : 'preciso'}`;
  setText(el.fps, slow ? `${text} · va lento: activa Modo rápido en Inicio` : text);
  el.fps.classList.toggle('slow', slow);
}

function renderControls() {
  $('cVoice').classList.toggle('off', !speaker.enabled);
  $('cVoice').setAttribute('aria-pressed', String(speaker.enabled));
  $('cCam').hidden = live?.source.kind !== 'camera';
}

function flash(text, seconds = 2) {
  if (!live) return;
  const t = live.source.kind === 'file' ? video.currentTime : (performance.now() - live.t0) / 1000;
  live.banner = { text, color: 'white', until: t + seconds };
}

$('cMinus').onclick = () => changeTarget(-1);
$('cPlus').onclick = () => changeTarget(1);
$('cVoice').onclick = () => {
  speaker.enabled = settings.voice = !speaker.enabled;
  if (speaker.enabled) speaker.unlock();
  saveSettings();
  renderSettings();
  renderControls();
};
$('cCam').onclick = async () => {
  if (live?.source.kind !== 'camera') return;
  settings.facing = settings.facing === 'user' ? 'environment' : 'user';
  saveSettings();
  renderSettings();
  try {
    await openCamera(settings.facing);
    live.filter = live.ex.makeFilter();
    live.pose = null;
    engine.reset();
    flash(settings.facing === 'user' ? 'Cámara frontal' : 'Cámara trasera');
    startLoop();
  } catch (err) {
    flash(errorMessage(err), 4);
  }
};
$('cReset').onclick = () => {
  if (!live) return;
  Object.assign(live, {
    filter: live.ex.makeFilter(),
    counter: live.ex.makeCounter(targetFor(live.ex)),
    setReps: [],
    pose: null,
  });
  engine.reset();
  flash('Conteo reiniciado');
};
$('cStop').onclick = () => finish();
video.addEventListener('ended', () => {
  if (live?.source.kind === 'file') setTimeout(finish, 300); // let the last frames finish
});

document.addEventListener('visibilitychange', async () => {
  if (document.visibilityState !== 'visible') {
    stopAlive(); // leaving the app on purpose is not a crash
    return;
  }
  if (!live) return;
  startAlive();
  requestWakeLock();
  markOverlayDirty();
  live.lastFrameAt = performance.now();
  const track = stream?.getVideoTracks()[0];
  if (live.source.kind === 'camera' && (!track || track.readyState === 'ended' || video.paused)) {
    try {
      await openCamera(settings.facing); // iOS stops the camera when the app goes to the background
      startLoop();
    } catch (err) {
      flash(errorMessage(err), 4);
    }
  }
  if (live) startOverlay();
});

function finish() {
  const st = live;
  if (!st) return;
  st.running = false;
  live = null;
  loopGen += 1; // stop the analysis and overlay loops
  overlayGen += 1;
  clearOverlay();
  stopAlive();
  stopMedia();
  releaseWakeLock();
  if ('speechSynthesis' in window && !st.counter.reps.length) speechSynthesis.cancel();
  const reps = st.counter.reps;
  const target = targetFor(st.ex);
  if (reps.length) saveHistory(st.ex.id, target, reps);
  showSummary(st.ex, reps, target, new Date());
}

// ---------- summary and history ----------
const fmtWhen = (d) =>
  d.toLocaleString('es', { day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' });

let summaryText = '';
let summaryEx = null; // exercise of the summary on screen: "Otra serie" repeats that one

function showSummary(ex, reps, target, when) {
  summaryEx = ex.id;
  $('sumTitle').textContent = `${ex.name} · ${fmtWhen(when)}`;
  const stat = (label, value) => `<div class="stat"><span>${label}</span><b>${value}</b></div>`;
  $('sumStats').innerHTML = reps.length
    ? stat('Repeticiones', reps.length) +
      ex
        .stats(reps, target)
        .map(([l, v]) => stat(l, v))
        .join('') +
      stat('Objetivo', ex.fmt(target))
    : stat('Repeticiones', 0);
  $('sumHead').replaceChildren(
    ...ex.columns.map((c) => {
      const th = document.createElement('th');
      th.textContent = c;
      return th;
    }),
  );
  $('sumTable')
    .querySelector('tbody')
    .replaceChildren(
      ...reps.map((r) => {
        const tr = document.createElement('tr');
        const v = ex.verdict(r, target);
        for (const cell of ex.row(r)) {
          const td = document.createElement('td');
          if (cell === null) {
            td.textContent = ex.verdictLabel[v];
            td.className = `v-${v}`;
          } else {
            td.textContent = cell;
          }
          tr.append(td);
        }
        return tr;
      }),
    );
  $('sumTable').hidden = !reps.length;
  const notes = ex.notes(reps, target);
  $('sumNotes').replaceChildren(
    ...notes.map((n) => {
      const li = document.createElement('li');
      li.textContent = n;
      return li;
    }),
  );
  summaryText = [
    `${ex.name} · ${fmtWhen(when)} · objetivo ${ex.fmt(target)}`,
    ...reps.map((r) => ex.shareLine(r, target)),
    '',
    ...notes.map((n) => `- ${n}`),
  ].join('\n');
  show('summary');
}

function saveHistory(exercise, target, reps) {
  const history = readJSON(HISTORY_KEY, []);
  history.unshift({ at: new Date().toISOString(), exercise, target, reps });
  writeJSON(HISTORY_KEY, history.slice(0, HISTORY_MAX));
}

function renderHistory() {
  const history = readJSON(HISTORY_KEY, []).filter((s) => s.reps?.length);
  $('history').hidden = !history.length;
  $('historyList').replaceChildren(
    ...history.map((s) => {
      const ex = EXERCISES[s.exercise] || EXERCISES.squat; // sessions saved before curl existed are squats
      const li = document.createElement('li');
      const btn = document.createElement('button');
      btn.type = 'button';
      const title = document.createElement('b');
      title.textContent = `${ex.name} · ${fmtWhen(new Date(s.at))}`;
      const line = document.createElement('span');
      line.textContent = ex.historyLine(s.reps, s.target);
      btn.append(title, line);
      btn.onclick = () => showSummary(ex, s.reps, s.target, new Date(s.at));
      li.append(btn);
      return li;
    }),
  );
}

$('again').onclick = () => {
  if (EXERCISES[summaryEx] && summaryEx !== settings.exercise) {
    settings.exercise = summaryEx;
    saveSettings();
    renderSettings();
  }
  start(lastSource?.kind === 'file' ? lastSource : { kind: 'camera' });
};
$('home').onclick = () => {
  renderHistory();
  show('setup');
};
$('share').onclick = async () => {
  try {
    if (navigator.share) await navigator.share({ title: 'Coach de Gym', text: summaryText });
    else {
      await navigator.clipboard.writeText(summaryText);
      $('share').textContent = 'Copiado';
      setTimeout(() => ($('share').textContent = 'Compartir'), 1500);
    }
  } catch {
    /* share sheet closed */
  }
};

// ---------- offline + multithreading ----------
async function registerServiceWorker() {
  if (!('serviceWorker' in navigator)) return;
  try {
    await navigator.serviceWorker.register('sw.js');
  } catch (err) {
    console.warn('Service worker:', err);
    return;
  }
  // The worker adds the headers that unlock multithreading only once it controls the page: reload once.
  if (self.crossOriginIsolated) return;
  const reloadOnce = () => {
    if (started || live || sessionStorage.getItem('coi-reload')) return; // never reload under the user's feet
    sessionStorage.setItem('coi-reload', '1');
    location.reload();
  };
  if (navigator.serviceWorker.controller) reloadOnce();
  else navigator.serviceWorker.addEventListener('controllerchange', reloadOnce, { once: true });
}

$('installHint').hidden = !(IS_IOS && !navigator.standalone);
window.addEventListener('pagehide', stopAlive);

checkPreviousCrash();
renderSettings();
renderHistory();
show('setup');
registerServiceWorker();

// test hook: ?video=<url>&autostart=1 plays a clip as if it were the camera (&ex=curl picks the exercise)
if (params.get('video')) {
  const source = { kind: 'file', url: params.get('video') };
  if (params.get('autostart') === '1') start(source);
  else $('start').onclick = () => start(source);
}
window.__coach = { get live() { return live; }, get engine() { return engine; }, settings };
