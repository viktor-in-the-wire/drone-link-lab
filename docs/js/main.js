// main.js
// Wires the simulation, the 3D view and the UI together and runs one
// requestAnimationFrame loop for everything.

import { Simulation } from './sim.js';
import { runConformance } from './conformance.js';
import { statusMode, statusFlags, MODES } from './protocol.js';
import { runLoader, setupReveals } from './fx.js';
import {
  joystick, LinkView, renderInspector, renderPipeline, renderTelemetry, drawChart, EventLog,
  renderLayerTable, renderAttackPending, renderAttackOutcome, FrameBuilder, renderConformance,
  frameStatus, fmtTime, ATTACKS, renderHPipe,
} from './ui.js';

const $ = (id) => document.getElementById(id);
const motionQuery = window.matchMedia('(prefers-reduced-motion: reduce)');
let reducedMotion = motionQuery.matches;

/* ------------------------------------------------------------------ */
/* 1. Conformance first: the protocol code proves itself on load.      */
/* ------------------------------------------------------------------ */
{
  const t0 = performance.now();
  const tests = runConformance();
  renderConformance(tests, performance.now() - t0);
  const passed = tests.filter((t) => t.pass).length;
  runLoader({ reducedMotion, passed, total: tests.length });
  setupReveals({ reducedMotion });
}

/* ------------------------------------------------------------------ */
/* 2. Simulation + UI                                                  */
/* ------------------------------------------------------------------ */
const sim = new Simulation();
const log = new EventLog();
sim.on('log', (e) => log.add(e));
// The constructor logged "link up" before we subscribed; show it now.
log.add({ t: 0, text: 'link up: drone SYSID 1 ⇄ ground station SYSID 255, signing key loaded', level: 'info', important: true });

let paused = false;
let selected = null;
let follow = true;
let holdUntil = 0;
let lastAuto = 0;
let renderedKey = '';
const recent = [];

function select(fr, { user = false, hold = 0 } = {}) {
  if (!fr) return;
  if (user) setFollow(false);
  selected = fr;
  holdUntil = performance.now() + hold;
  renderSelection(true);
}

function renderSelection(animate) {
  const key = selected ? `${selected.id}:${frameStatus(selected)}` : '';
  if (key === renderedKey && !animate) return;
  renderedKey = key;
  renderInspector(selected, animate && !reducedMotion);
  renderPipeline(selected, animate, reducedMotion);
}

function setFollow(on) {
  follow = on;
  $('insp-follow').setAttribute('aria-pressed', String(on));
}

sim.on('sent', (fr) => {
  recent.push(fr);
  if (recent.length > 200) recent.shift();
});

sim.on('processed', (fr) => {
  const now = performance.now();
  if (fr === selected) { renderSelection(true); return; }
  if (!follow || now < holdUntil) return;
  if (fr.result && !fr.result.ok) select(fr, { hold: 2600 });
  else if (fr.result && now - lastAuto > 1600) { lastAuto = now; select(fr); }
});

sim.on('attack', (fr) => {
  // Walk the frame through R1..R7 first, then show the verdict.
  renderHPipe(fr, reducedMotion, () => renderAttackOutcome(fr, sim.gcs));
  select(fr, { hold: 3500 });
  document.querySelectorAll('.attack.firing').forEach((b) => b.classList.remove('firing'));
});

sim.on('reset', () => {
  recent.length = 0;
  selected = null;
  renderedKey = '';
  renderSelection(false);
});

/* Inspector controls */
$('insp-follow').addEventListener('click', () => setFollow(!follow));
const step = (d) => {
  const i = recent.indexOf(selected);
  const next = recent[i < 0 ? recent.length - 1 : Math.max(0, Math.min(recent.length - 1, i + d))];
  select(next, { user: true });
};
$('insp-prev').addEventListener('click', () => step(-1));
$('insp-next').addEventListener('click', () => step(1));
$('insp-copy').addEventListener('click', async () => {
  if (!selected) return;
  const hex = Array.from(selected.bytes, (b) => b.toString(16).padStart(2, '0')).join(' ');
  const btn = $('insp-copy');
  try { await navigator.clipboard.writeText(hex); btn.textContent = 'Copied'; }
  catch { window.prompt('Frame bytes (hex):', hex); }
  setTimeout(() => { btn.textContent = 'Copy hex'; }, 1400);
});

const linkView = new LinkView($('link-canvas'), (fr) => select(fr, { user: true }));
const rtLinkView = new LinkView($('rt-link'), (fr) => select(fr, { user: true }));
$('link-canvas').addEventListener('keydown', (e) => {
  if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); select(recent[recent.length - 1], { user: true }); }
});

/* Toolbar */
$('btn-pause').addEventListener('click', () => {
  paused = !paused;
  $('btn-pause').textContent = paused ? 'Resume' : 'Pause';
  $('btn-pause').setAttribute('aria-pressed', String(paused));
});
$('btn-reset').addEventListener('click', () => { log.clear(); sim.reset(); });
$('link-quality').addEventListener('input', (e) => {
  sim.linkQuality = +e.target.value;
  $('lq-out').textContent = `${e.target.value}%`;
});
$('btn-lowbatt').addEventListener('click', () => sim.skipToLowBattery());

/* Transmitter */
$('btn-arm').addEventListener('click', () => sim.arm());
$('btn-disarm').addEventListener('click', () => sim.disarm());
$('btn-rth').addEventListener('click', () => sim.returnHome());
$('btn-land').addEventListener('click', () => sim.land());
document.querySelectorAll('[data-mode]').forEach((b) => b.addEventListener('click', () => sim.setMode(+b.dataset.mode)));

const stick = { lx: 0, ly: 0, rx: 0, ry: 0 };
const left = joystick($('stick-left'), (x, y) => { stick.lx = x; stick.ly = y; });
const right = joystick($('stick-right'), (x, y) => { stick.rx = x; stick.ry = y; });

/* Keyboard: Space arm, W/S climb, A/D yaw, arrows pitch/roll, R home, L land. */
const keys = new Set();
let demoInView = false;
const MOVE_KEYS = { w: 1, s: 1, a: 1, d: 1, arrowup: 1, arrowdown: 1, arrowleft: 1, arrowright: 1 };
window.addEventListener('keydown', (e) => {
  if (e.ctrlKey || e.metaKey || e.altKey) return;
  const t = e.target;
  if (t.closest?.('input, textarea, select')) return;
  if (!demoInView && !t.closest?.('#demo')) return;
  const k = e.key.toLowerCase();
  if (k === ' ') {
    if (t.closest?.('button, a, [role="switch"]')) return;
    e.preventDefault();
    if (!e.repeat) sim.toggleArm();
  } else if (MOVE_KEYS[k]) {
    keys.add(k);
    if (k.startsWith('arrow')) e.preventDefault();
  } else if (k === 'r' && !e.repeat) sim.returnHome();
  else if (k === 'l' && !e.repeat) sim.land();
});
window.addEventListener('keyup', (e) => keys.delete(e.key.toLowerCase()));
window.addEventListener('blur', () => keys.clear());

function readInput() {
  const k = (a) => (keys.has(a) ? 1 : 0);
  const kb = { throttle: k('w') - k('s'), yaw: k('d') - k('a'), pitch: k('arrowup') - k('arrowdown'), roll: k('arrowright') - k('arrowleft') };
  if (!left.active) left.show(kb.yaw, -kb.throttle);
  if (!right.active) right.show(kb.roll, -kb.pitch);
  sim.input.throttle = left.active ? -stick.ly : kb.throttle;
  sim.input.yaw = left.active ? stick.lx : kb.yaw;
  sim.input.pitch = right.active ? -stick.ry : kb.pitch;
  sim.input.roll = right.active ? stick.rx : kb.roll;
}

/* Red team */
document.querySelectorAll('[data-attack]').forEach((b) => b.addEventListener('click', () => {
  const kind = b.dataset.attack;
  if (kind === 'noise') sim.attackNoise();
  if (kind === 'forge') sim.attackForge();
  if (kind === 'tamper') sim.attackTamper();
  if (kind === 'replay') sim.attackReplay();
  if (ATTACKS.includes(kind)) renderAttackPending(kind);
  b.classList.add('firing');
  if (paused) $('btn-pause').click();
}));
const defSig = $('def-sig'), defTs = $('def-ts');
const syncDefences = () => renderLayerTable(sim.defences);
defSig.addEventListener('change', () => { sim.setDefence('requireSignature', defSig.checked); syncDefences(); });
defTs.addEventListener('change', () => { sim.setDefence('checkTimestamp', defTs.checked); syncDefences(); });
syncDefences();

/* Frame builder */
new FrameBuilder(reducedMotion);

/* ------------------------------------------------------------------ */
/* 3. The 3D drone (loaded lazily so the rest works even offline)      */
/* ------------------------------------------------------------------ */
let view = null;
const host = $('drone-host');
import('./drone3d.js').then(({ DroneView }) => {
  view = new DroneView(host, { reducedMotion });
  $('explode-btn').addEventListener('click', () => view.explode());
  placeView();
}).catch((err) => {
  console.warn('3D view unavailable:', err);
  host.innerHTML = '<p class="noscript mono">3D view unavailable (Three.js could not be loaded). The protocol demo below still works.</p>';
});

// One drone, two places: it lives in the hero, and moves into the demo
// figure while the demo is on screen, so it always reacts in view.
const ratios = new Map();
const SLOTS = ['hero-slot', 'demo-slot', 'rt-slot'];
function placeView() {
  if (!view) return;
  let best = null, bestR = 0;
  for (const id of SLOTS) { const r = ratios.get(id) ?? 0; if (r > bestR + 0.05) { best = id; bestR = r; } }
  if (best) view.mountInto($(best));
  view.visible = bestR > 0;
}
const io = new IntersectionObserver((entries) => {
  for (const e of entries) {
    if (e.target.id === 'demo') demoInView = e.isIntersecting || redInView;
    else if (e.target.id === 'redteam') redInView = e.isIntersecting;
    else ratios.set(e.target.id, e.intersectionRatio);
  }
  placeView();
}, { threshold: [0, 0.1, 0.25, 0.5, 0.75, 1] });
io.observe($('hero-slot'));
io.observe($('demo-slot'));
io.observe($('rt-slot'));
io.observe($('demo'));
io.observe($('redteam'));
let redInView = false;

/* Header: scrollspy + scroll progress */
const spyLinks = [...document.querySelectorAll('[data-spy]')];
const spy = new IntersectionObserver((entries) => {
  for (const e of entries) if (e.isIntersecting) {
    spyLinks.forEach((a) => a.setAttribute('aria-current', String(a.dataset.spy === e.target.id)));
  }
}, { rootMargin: '-45% 0px -50% 0px' });
spyLinks.forEach((a) => spy.observe($(a.dataset.spy)));
const progress = $('scroll-progress');
const onScroll = () => {
  const max = document.documentElement.scrollHeight - innerHeight;
  progress.style.transform = `scaleX(${max > 0 ? scrollY / max : 0})`;
};
addEventListener('scroll', onScroll, { passive: true });
onScroll();

motionQuery.addEventListener?.('change', (e) => {
  reducedMotion = e.matches;
  view?.setReducedMotion(reducedMotion);
});

/* ------------------------------------------------------------------ */
/* 4. Main loop                                                        */
/* ------------------------------------------------------------------ */
let last = performance.now();
let demoOff = false;
new IntersectionObserver(([e]) => { demoOff = !e.isIntersecting; }).observe($('link-canvas'));
let uiClock = 0;

function droneState() {
  const d = sim.drone;
  return {
    ...d, paused,
    gps: d.sats >= 6,
    modeName: { 1: 'MANUAL', 2: 'STABILIZE', 3: 'AUTO', 4: 'LOITER' }[d.mode],
  };
}

function updatePanels() {
  renderTelemetry(sim);
  drawChart($('chart'), sim.history, sim.t);
  const s = sim.stats;
  // Header status: pulses while live, turns red briefly after a rejection.
  const st = $('top-status');
  const recentReject = s.rejected > (updatePanels.lastRej ?? 0);
  if (recentReject) updatePanels.alertUntil = sim.t + 2;
  updatePanels.lastRej = s.rejected;
  const alert = sim.t < (updatePanels.alertUntil ?? 0);
  st.classList.toggle('alert', alert);
  st.classList.toggle('paused', paused);
  st.lastChild.textContent = paused ? 'PAUSED' : alert ? 'REJECT' : 'LINK · LIVE';
  // Red team: what the ground station believes right now.
  const tl = sim.gcs.tlm;
  if (tl) {
    $('rt-alt').textContent = `${(tl.altitude_cm / 100).toFixed(1)} m`;
    $('rt-batt').textContent = `${tl.battery_pct}%`;
    $('rt-mode').textContent = MODES[statusMode(tl.status)] ?? '?';
    $('rt-flags').textContent = statusFlags(tl.status).join(' · ');
    const spoofRecent = sim.gcs.spoof && sim.t - sim.gcs.spoof.at < 6;
    $('rt-alt').closest('.believes').classList.toggle('spoofed', !!(tl.spoofed || spoofRecent));
  }
  $('stats').textContent = `t ${fmtTime(sim.t)} · sent ${s.sent} · accepted ${s.accepted} · rejected ${s.rejected} · dropped ${s.dropped} · lost (SEQ) ${sim.lost}`;
  // Mode buttons show what the ground station has CONFIRMED via telemetry.
  const mode = sim.gcs.tlm ? statusMode(sim.gcs.tlm.status) : sim.drone.mode;
  document.querySelectorAll('[data-mode]').forEach((b) => b.setAttribute('aria-pressed', String(+b.dataset.mode === mode)));
  $('btn-arm').disabled = sim.drone.armed;
  $('btn-disarm').disabled = !sim.drone.armed;
  renderSelection(false);
}

function loop(now) {
  requestAnimationFrame(loop);
  const dt = Math.min(0.1, (now - last) / 1000);
  last = now;
  if (document.hidden) return;   // the browser also throttles rAF in hidden tabs

  readInput();
  if (!paused) sim.step(dt);
  view?.frame(dt, droneState());
  if (!demoOff) linkView.draw(sim, selected);
  if (redInView) rtLinkView.draw(sim, selected);

  uiClock += dt;
  if (uiClock > 0.1) { uiClock = 0; updatePanels(); }
}
requestAnimationFrame(loop);
document.addEventListener('visibilitychange', () => { last = performance.now(); });
