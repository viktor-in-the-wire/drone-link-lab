// ui.js
// DOM and canvas rendering. Nothing here builds or checks bytes: it only
// displays what protocol.js and sim.js produced.

import {
  dissect, toHex, hex2, hex4, MODES, STATUS, statusMode, statusFlags, CHECKS, REASONS,
  buildFrame, computeChecksum, computeSignature, DEMO_KEY, MSG, payloadLayout, readU48, Receiver,
} from './protocol.js';
import { hmacSha256 } from './sha256.js';
import { TELEMETRY_FIELDS, SIGNED_TS, VECTORS } from './conformance.js';

const C = {
  blue: '#2563eb', deep: '#1d4ed8', ink: '#0f172a', muted: '#64748b', grid: '#e0e7ff', hair: '#c7d2fe',
  header: '#2563eb', payload: '#15803d', checksum: '#b45309', signature: '#6d28d9', bad: '#b91c1c',
};
const MONO = 'ui-monospace, "SF Mono", "Cascadia Mono", Menlo, Consolas, monospace';
const SHORT = { HEARTBEAT: 'HB', DRONE_TELEMETRY: 'TLM', DRONE_COMMAND: 'CMD', DRONE_ACK: 'ACK', UNKNOWN: '??' };
const ATTACK_NAMES = { noise: 'Inject noise', forge: 'Forge a frame', tamper: 'Tamper', replay: 'Replay', corrupt: 'Interference' };
const ATTACKS = ['noise', 'forge', 'tamper', 'replay'];
const $ = (id) => document.getElementById(id);
const clamp = (v, a, b) => Math.max(a, Math.min(b, v));

export const fmtTime = (t) => {
  const m = Math.floor(t / 60), s = t - m * 60;
  return `${String(m).padStart(2, '0')}:${s.toFixed(1).padStart(4, '0')}`;
};
export const frameStatus = (fr) => (fr.lost ? 'lost' : fr.result ? (fr.result.ok ? 'accepted' : 'rejected') : fr.dropped ? 'in flight' : 'in flight');

/** Size a canvas to its CSS box at up to 2x pixel ratio and return a 2D context in CSS pixels. */
function prepCanvas(canvas) {
  const dpr = Math.min(window.devicePixelRatio || 1, 2);
  const w = canvas.clientWidth, h = canvas.clientHeight;
  if (canvas.width !== Math.round(w * dpr) || canvas.height !== Math.round(h * dpr)) {
    canvas.width = Math.round(w * dpr);
    canvas.height = Math.round(h * dpr);
  }
  const ctx = canvas.getContext('2d');
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  ctx.clearRect(0, 0, w, h);
  return { ctx, w, h };
}

/* ================================================================== */
/* Joystick                                                            */
/* ================================================================== */

/** A virtual stick (mouse + touch). onMove(x, y) with x, y in [-1, 1], y down. */
export function joystick(el, onMove) {
  const knob = el.querySelector('.knob');
  let pointer = null;
  const show = (x, y) => {
    const r = el.clientWidth * 0.33;
    knob.style.transform = `translate(${x * r}px, ${y * r}px)`;
  };
  const move = (e) => {
    const b = el.getBoundingClientRect();
    let x = (e.clientX - (b.left + b.width / 2)) / (b.width * 0.33);
    let y = (e.clientY - (b.top + b.height / 2)) / (b.height * 0.33);
    const m = Math.hypot(x, y);
    if (m > 1) { x /= m; y /= m; }
    show(x, y);
    onMove(x, y);
  };
  el.addEventListener('pointerdown', (e) => {
    pointer = e.pointerId;
    el.setPointerCapture(pointer);
    el.classList.add('active');
    move(e);
    e.preventDefault();
  });
  el.addEventListener('pointermove', (e) => { if (e.pointerId === pointer) move(e); });
  const end = (e) => {
    if (e.pointerId !== pointer) return;
    pointer = null;
    el.classList.remove('active');
    show(0, 0);
    onMove(0, 0);
  };
  el.addEventListener('pointerup', end);
  el.addEventListener('pointercancel', end);
  return { show, get active() { return pointer !== null; } };
}

/* ================================================================== */
/* Link view (canvas)                                                  */
/* ================================================================== */

export class LinkView {
  constructor(canvas, onSelect) {
    this.canvas = canvas;
    this.onSelect = onSelect;
    this.hits = [];
    canvas.addEventListener('click', (e) => this.pick(e, true));
    canvas.addEventListener('mousemove', (e) => this.pick(e, false));
  }

  pick(e, click) {
    const b = this.canvas.getBoundingClientRect();
    const x = e.clientX - b.left, y = e.clientY - b.top;
    let best = null, bd = 1e9;
    for (const h of this.hits) {
      const d = Math.hypot(h.x - x, h.y - y);
      if (d < 26 && d < bd) { best = h; bd = d; }
    }
    this.canvas.style.cursor = best ? 'pointer' : 'default';
    if (best && (click || best.fr !== this.lastHover)) {
      this.lastHover = best.fr;
      this.onSelect(best.fr);
    }
  }

  geometry(w, h) {
    const xL = 46, xR = w - 46;
    return { xL, xR, yDown: h * 0.31, yUp: h * 0.55, yMid: h * 0.43, atk: { x: w / 2, y: h * 0.82 } };
  }

  draw(sim, selected) {
    const { ctx, w, h } = prepCanvas(this.canvas);
    const g = this.geometry(w, h);
    const t = sim.t;
    ctx.lineCap = 'round';

    // Lanes.
    ctx.strokeStyle = C.grid; ctx.lineWidth = 1;
    ctx.setLineDash([]);
    ctx.beginPath(); ctx.moveTo(g.xL + 26, g.yDown); ctx.lineTo(g.xR - 26, g.yDown); ctx.stroke();
    ctx.beginPath(); ctx.moveTo(g.xL + 26, g.yUp); ctx.lineTo(g.xR - 26, g.yUp); ctx.stroke();
    ctx.strokeStyle = C.blue; ctx.lineWidth = 1.25;
    ctx.beginPath(); ctx.moveTo(g.xL + 26, g.yMid); ctx.lineTo(g.xR - 26, g.yMid); ctx.stroke();
    // Arrowheads on the lane guides.
    const arrow = (x, y, dir) => {
      ctx.beginPath(); ctx.moveTo(x, y); ctx.lineTo(x - dir * 6, y - 3.5); ctx.moveTo(x, y); ctx.lineTo(x - dir * 6, y + 3.5); ctx.stroke();
    };
    ctx.strokeStyle = C.hair; ctx.lineWidth = 1;
    arrow(g.xR - 28, g.yDown, 1); arrow(g.xL + 28, g.yUp, -1);

    // Attacker tap: dashed, below the link.
    ctx.strokeStyle = C.bad; ctx.setLineDash([3, 3]);
    ctx.beginPath(); ctx.moveTo(g.atk.x, g.yMid); ctx.lineTo(g.atk.x, g.atk.y - 11); ctx.stroke();
    ctx.beginPath(); ctx.arc(g.atk.x, g.atk.y, 10, 0, Math.PI * 2); ctx.stroke();
    ctx.setLineDash([]);
    ctx.beginPath(); ctx.moveTo(g.atk.x - 4, g.atk.y - 4); ctx.lineTo(g.atk.x + 4, g.atk.y + 4); ctx.moveTo(g.atk.x + 4, g.atk.y - 4); ctx.lineTo(g.atk.x - 4, g.atk.y + 4); ctx.stroke();

    // Labels.
    ctx.font = `10px ${MONO}`; ctx.fillStyle = C.muted; ctx.textBaseline = 'middle';
    ctx.textAlign = 'left';
    ctx.fillText('drone → ground · telemetry', g.xL + 30, g.yDown - 14);
    ctx.textAlign = 'right';
    ctx.fillText('ground → drone · commands', g.xR - 30, g.yUp + 14);
    ctx.textAlign = 'center';
    ctx.fillStyle = C.bad;
    ctx.textBaseline = 'middle';
    ctx.fillText('ATTACKER', g.atk.x + 34, g.atk.y);
    ctx.fillStyle = C.ink;
    ctx.fillText('DRONE', g.xL, g.yMid + 38);
    ctx.fillText('GROUND', g.xR, g.yMid + 38);
    ctx.fillStyle = C.muted;
    ctx.fillText('SYSID 1', g.xL, g.yMid + 51);
    ctx.fillText('SYSID 255', g.xR, g.yMid + 51);

    // Drone icon: cross with four rotors.
    ctx.strokeStyle = C.deep; ctx.lineWidth = 1.25;
    const d = { x: g.xL, y: g.yMid };
    ctx.beginPath(); ctx.moveTo(d.x - 12, d.y - 12); ctx.lineTo(d.x + 12, d.y + 12); ctx.moveTo(d.x + 12, d.y - 12); ctx.lineTo(d.x - 12, d.y + 12); ctx.stroke();
    for (const [sx, sy] of [[-1, -1], [1, -1], [1, 1], [-1, 1]]) { ctx.beginPath(); ctx.arc(d.x + sx * 14, d.y + sy * 14, 7, 0, Math.PI * 2); ctx.stroke(); }
    ctx.strokeRect(d.x - 5, d.y - 5, 10, 10);
    // Ground station icon: antenna mast with a dish and a console.
    const s = { x: g.xR, y: g.yMid };
    ctx.strokeRect(s.x - 14, s.y + 2, 28, 16);
    ctx.beginPath(); ctx.moveTo(s.x, s.y + 2); ctx.lineTo(s.x, s.y - 14); ctx.stroke();
    ctx.beginPath(); ctx.arc(s.x, s.y - 14, 10, Math.PI * 1.1, Math.PI * 1.9); ctx.stroke();
    ctx.beginPath(); ctx.arc(s.x, s.y - 18, 2, 0, Math.PI * 2); ctx.stroke();
    ctx.beginPath(); ctx.moveTo(s.x - 9, s.y + 10); ctx.lineTo(s.x + 9, s.y + 10); ctx.stroke();

    // Frames.
    this.hits = [];
    const FW = 32, FH = 16;
    for (const fr of sim.frames) {
      const down = fr.to === 'gcs';
      const lane = down ? g.yDown : g.yUp;
      const x0 = fr.from === 'attacker' ? g.atk.x : down ? g.xL + 26 : g.xR - 26;
      const x1 = down ? g.xR - 30 : g.xL + 30;
      const endT = fr.dropped ? fr.dropAt : fr.arriveAt;
      const total = fr.arriveAt - fr.sentAt;
      const p = clamp((Math.min(t, endT) - fr.sentAt) / total, 0, 1);
      let x = x0 + (x1 - x0) * p;
      let y = lane;
      if (fr.from === 'attacker') {
        const rise = clamp(p / 0.3, 0, 1);
        y = g.atk.y - 12 + (lane - (g.atk.y - 12)) * (1 - (1 - rise) * (1 - rise));
        x = x0 + (x1 - x0) * clamp((p - 0.15) / 0.85, 0, 1);
      }
      const after = t - endT;
      let alpha = 1, state = 'flight';
      if (fr.lost) { state = 'lost'; alpha = 1 - after / 1.2; y += after * after * 60; }
      else if (fr.result && fr.result.ok) { state = 'ok'; alpha = 1 - after / 0.9; }
      else if (fr.result) { state = 'bad'; alpha = 1 - Math.max(0, after - 0.5) / 0.9; y += Math.max(0, after - 0.3) ** 2 * 80; }
      alpha = clamp(alpha, 0, 1);
      if (alpha <= 0) continue;

      const atk = fr.from === 'attacker' || ['noise', 'tamper', 'forge', 'replay'].includes(fr.kind);
      ctx.globalAlpha = alpha;
      ctx.lineWidth = 1.25;
      ctx.setLineDash(state === 'bad' ? [3, 2] : state === 'lost' ? [1.5, 2] : []);
      ctx.strokeStyle = state === 'bad' ? C.bad : state === 'lost' ? C.muted : atk ? C.bad : C.blue;
      ctx.fillStyle = state === 'ok' ? (atk ? C.bad : C.blue) : '#ffffff';
      ctx.fillRect(x - FW / 2, y - FH / 2, FW, FH);
      ctx.strokeRect(x - FW / 2, y - FH / 2, FW, FH);
      ctx.setLineDash([]);
      ctx.font = `600 9px ${MONO}`;
      ctx.textAlign = 'center';
      ctx.fillStyle = state === 'ok' ? '#ffffff' : state === 'bad' ? C.bad : state === 'lost' ? C.muted : atk ? C.bad : C.deep;
      const label = state === 'bad' ? fr.result.code : state === 'lost' ? 'lost' : SHORT[fr.name] ?? '??';
      ctx.fillText(label, x, y + 0.5);
      if (atk && state === 'flight') { ctx.font = `8px ${MONO}`; ctx.fillStyle = C.bad; ctx.fillText(fr.kind.toUpperCase(), x, y - 14); }
      if (fr === selected) {
        ctx.strokeStyle = C.ink; ctx.lineWidth = 1;
        ctx.strokeRect(x - FW / 2 - 4, y - FH / 2 - 4, FW + 8, FH + 8);
        // Crosshair ticks.
        ctx.beginPath();
        ctx.moveTo(x, y - FH / 2 - 9); ctx.lineTo(x, y - FH / 2 - 4);
        ctx.moveTo(x, y + FH / 2 + 4); ctx.lineTo(x, y + FH / 2 + 9);
        ctx.stroke();
      }
      ctx.globalAlpha = 1;
      this.hits.push({ fr, x, y });
    }
  }
}

/* ================================================================== */
/* Inspector                                                           */
/* ================================================================== */

const FAIL_FIELD = { R1: 'stx', R2: 'incompat', R3: 'len', R4: 'msgid', R5: 'checksum', R6: 'sig', R7: 'ts' };

export function renderInspector(fr, animate = false) {
  const meta = $('insp-meta'), cells = $('insp-cells');
  if (!fr) { meta.textContent = 'waiting for the first frame'; cells.replaceChildren(); return; }
  const st = frameStatus(fr);
  const dir = fr.from === 'attacker' ? 'attacker → ground' : fr.to === 'gcs' ? 'drone → ground' : 'ground → drone';
  const r = fr.result;
  const verdict = st === 'rejected'
    ? `<span class="bad">rejected ${r.code} ${REASONS[r.code]}</span>`
    : st === 'accepted' ? '<strong>accepted</strong>' : st === 'lost' ? 'lost in transit, never reached the receiver' : 'in flight';
  meta.innerHTML = `#${fr.id} · <strong>${fr.name}</strong> · ${dir} · ${fr.bytes.length} bytes · ${verdict}`
    + (fr.note ? ` · <span class="bad">${ATTACK_NAMES[fr.kind] ?? ''}: ${fr.note}</span>` : '');

  const failKey = r && !r.ok ? FAIL_FIELD[r.code] : null;
  const parts = dissect(fr.bytes);
  const frag = document.createDocumentFragment();
  parts.forEach((p, i) => {
    const cell = document.createElement('div');
    cell.className = `cell g-${p.group}${p.key === failKey ? ' bad' : ''}`;
    cell.style.setProperty('--i', i);
    if (p.key === 'payload' && p.sub.length) {
      cell.innerHTML = `<div class="cell-value">${p.value} · ${p.def.name}</div>
        <div class="cell-box"><div class="cell-name">PAYLOAD</div><div class="sub-cells">${p.sub.map((s) => `
          <div class="sub${s.truncated ? ' trunc' : ''}" title="${s.type} ${s.name}">
            <div class="sub-val">${fmtField(s.name, s.value)}</div>
            <div class="sub-hex">${s.bytes.length ? toHex(s.bytes) : '··'}${s.truncated && s.bytes.length < s.size ? ' ' + '00 '.repeat(s.size - s.bytes.length).trim() : ''}</div>
            <div class="sub-name">${s.name}</div></div>`).join('')}</div></div>
        <div class="cell-off">${p.start}…${p.start + p.size - 1}</div>`;
    } else {
      cell.style.minWidth = `${Math.max(54, p.size * 25 + 14)}px`;
      cell.innerHTML = `<div class="cell-value" title="${p.value}">${p.value}</div>
        <div class="cell-box"><div class="cell-name">${p.label}</div><div class="cell-hex">${toHex(p.bytes) || '··'}</div></div>
        <div class="cell-off">${p.size > 1 ? `${p.start}…${p.start + p.size - 1}` : p.start}</div>`;
    }
    frag.appendChild(cell);
  });
  cells.classList.remove('anim');
  cells.replaceChildren(frag);
  if (animate) { void cells.offsetWidth; cells.classList.add('anim'); }
}

function fmtField(name, v) {
  switch (name) {
    case 'altitude_cm': return `${(v / 100).toFixed(2)} m`;
    case 'speed_cms': return `${(v / 100).toFixed(2)} m/s`;
    case 'battery_pct': return `${v}%`;
    case 'time_ms': return `${(v / 1000).toFixed(1)} s`;
    case 'status': return `${hex2(v)} ${MODES[statusMode(v)] ?? '?'}`;
    case 'base_mode': return hex2(v);
    case 'command': return { 1: 'RTH', 2: 'LAND', 3: 'SET_MODE' }[v] ?? String(v);
    case 'result': return { 0: 'accepted', 1: 'rejected', 2: 'unsupp.' }[v] ?? String(v);
    default: return String(v);
  }
}

/* ================================================================== */
/* Receiver pipeline                                                   */
/* ================================================================== */

let pipeTimers = [];
export function renderPipeline(fr, animate, reducedMotion) {
  pipeTimers.forEach(clearTimeout);
  pipeTimers = [];
  const list = $('pipeline'), verdict = $('pipe-verdict');
  const steps = fr?.result?.steps ?? CHECKS.map((c) => ({ ...c, status: 'idle', detail: '' }));
  list.replaceChildren(...steps.map((s) => {
    const li = document.createElement('li');
    li.className = 'step';
    li.innerHTML = `<span class="step-code">${s.code}</span><span class="step-label">${s.label}<span class="step-detail">${s.rule}</span></span>`;
    return li;
  }));
  const st = fr ? frameStatus(fr) : null;
  const finish = () => {
    if (!fr) verdict.textContent = '';
    else if (st === 'accepted') verdict.innerHTML = `<span class="ok">ACCEPTED</span> · state updated: timestamp, SEQ ${fr.result.seq}${fr.result.gap ? `, ${fr.result.gap} lost` : ''}`;
    else if (st === 'rejected') verdict.innerHTML = `<span class="bad">REJECTED ${fr.result.code}</span> · ${REASONS[fr.result.code]} · frame dropped, no state change`;
    else if (st === 'lost') verdict.textContent = 'Lost in transit. The receiver will see a SEQ gap on the next frame.';
    else verdict.textContent = 'In flight…';
  };
  if (!fr?.result) { finish(); return; }
  const apply = (i) => {
    const s = steps[i], li = list.children[i];
    li.classList.add(s.status);
    li.querySelector('.step-detail').textContent = s.detail || s.rule;
  };
  const shown = steps.filter((s) => s.status !== 'idle').length;
  if (!animate || reducedMotion) { for (let i = 0; i < shown; i++) apply(i); finish(); return; }
  verdict.textContent = 'checking…';
  for (let i = 0; i < shown; i++) pipeTimers.push(setTimeout(() => apply(i), 90 + i * 120));
  pipeTimers.push(setTimeout(finish, 90 + shown * 120));
}

/* ================================================================== */
/* Telemetry readouts + chart                                          */
/* ================================================================== */

export function renderTelemetry(sim) {
  const tl = sim.gcs.tlm;
  const set = (id, text) => { const el = $(id); if (el.textContent !== text) el.textContent = text; };
  const gauge = (id, frac) => { $(id).style.width = `${clamp(frac, 0, 1) * 100}%`; };
  set('ro-lost', String(sim.lost));
  if (!tl) { ['ro-alt', 'ro-speed', 'ro-batt', 'ro-sats', 'ro-mode'].forEach((id) => set(id, '-')); return; }
  set('ro-alt', `${(tl.altitude_cm / 100).toFixed(1)} m`);
  set('ro-speed', `${(tl.speed_cms / 100).toFixed(1)} m/s`);
  set('ro-batt', `${tl.battery_pct}%`);
  set('ro-sats', String(tl.satellites));
  set('ro-mode', MODES[statusMode(tl.status)] ?? `? ${statusMode(tl.status)}`);
  gauge('g-alt', tl.altitude_cm / 100 / 60);
  gauge('g-speed', tl.speed_cms / 100 / 10);
  gauge('g-batt', tl.battery_pct / 100);
  gauge('g-sats', tl.satellites / 14);
  $('g-batt').parentElement.classList.toggle('low', tl.battery_pct < 20);
  for (const id of ['ro-alt', 'ro-batt', 'ro-speed', 'ro-mode']) $(id).classList.toggle('spoofed', !!tl.spoofed);
  const on = new Set(statusFlags(tl.status));
  for (const li of $('flags').children) li.classList.toggle('on', on.has(li.dataset.flag));

  const banner = $('spoof-banner');
  const sp = sim.gcs.spoof;
  if (sp && sim.t - sp.at < 6) {
    banner.hidden = false;
    const txt = `SPOOFED DATA ACCEPTED (${ATTACK_NAMES[sp.kind]}): alt ${(sp.fields.altitude_cm / 100).toFixed(1)} m, batt ${sp.fields.battery_pct}%`;
    if (banner.textContent !== txt) banner.textContent = txt;
  } else banner.hidden = true;
}

export function drawChart(canvas, history, now) {
  const { ctx, w, h } = prepCanvas(canvas);
  const L = 34, R = 34, T = 8, B = 18;
  const pw = w - L - R, ph = h - T - B;
  const maxAlt = Math.max(20, Math.ceil((Math.max(0, ...history.map((p) => p.alt)) * 1.15) / 10) * 10);
  const X = (t) => L + pw * (1 - (now - t) / 60);
  const Ya = (a) => T + ph * (1 - clamp(a / maxAlt, -0.1, 1.1));
  const Yb = (b) => T + ph * (1 - b / 100);

  ctx.lineWidth = 1;
  ctx.strokeStyle = C.grid;
  for (let i = 1; i < 4; i++) { const y = T + (ph * i) / 4; ctx.beginPath(); ctx.moveTo(L, y); ctx.lineTo(L + pw, y); ctx.stroke(); }
  for (let s = 10; s < 60; s += 10) { const x = L + (pw * s) / 60; ctx.beginPath(); ctx.moveTo(x, T); ctx.lineTo(x, T + ph); ctx.stroke(); }
  ctx.strokeStyle = C.muted;
  ctx.beginPath(); ctx.moveTo(L, T); ctx.lineTo(L, T + ph); ctx.lineTo(L + pw, T + ph); ctx.lineTo(L + pw, T); ctx.stroke();
  for (let i = 0; i <= 4; i++) {
    const y = T + (ph * i) / 4;
    ctx.beginPath(); ctx.moveTo(L - 4, y); ctx.lineTo(L, y); ctx.moveTo(L + pw, y); ctx.lineTo(L + pw + 4, y); ctx.stroke();
  }
  ctx.font = `9.5px ${MONO}`; ctx.fillStyle = C.muted; ctx.textBaseline = 'middle';
  ctx.textAlign = 'right'; ctx.fillText(`${maxAlt}`, L - 6, T + 1); ctx.fillText('0', L - 6, T + ph);
  ctx.textAlign = 'left'; ctx.fillText('100', L + pw + 6, T + 1); ctx.fillText('0', L + pw + 6, T + ph);
  ctx.textAlign = 'center'; ctx.textBaseline = 'top';
  ctx.fillText('-60 s', L + 12, T + ph + 5); ctx.fillText('-30 s', L + pw / 2, T + ph + 5); ctx.fillText('now', L + pw - 8, T + ph + 5);

  ctx.save();
  ctx.beginPath(); ctx.rect(L, T - 2, pw, ph + 4); ctx.clip();
  const line = (fy, color, dash, width) => {
    ctx.strokeStyle = color; ctx.lineWidth = width; ctx.setLineDash(dash);
    ctx.beginPath();
    history.forEach((p, i) => { const x = X(p.t), y = fy(p); i ? ctx.lineTo(x, y) : ctx.moveTo(x, y); });
    ctx.stroke();
    ctx.setLineDash([]);
  };
  line((p) => Ya(p.alt), C.blue, [], 1.5);
  line((p) => Yb(p.batt), C.deep, [4, 3], 1.1);
  ctx.strokeStyle = C.bad; ctx.lineWidth = 1.25;
  for (const p of history) if (p.spoofed) { ctx.strokeRect(X(p.t) - 3, Ya(p.alt) - 3, 6, 6); ctx.strokeRect(X(p.t) - 3, Yb(p.batt) - 3, 6, 6); }
  ctx.restore();
}

/* ================================================================== */
/* Event log                                                           */
/* ================================================================== */

export class EventLog {
  constructor() {
    this.list = $('log');
    this.verbose = $('log-verbose');
    this.announcer = $('announcer');
    this.lastAnnounce = 0;
  }
  clear() { this.list.replaceChildren(); }
  add({ t, text, level, important }) {
    // Quiet mode: important events, SEQ gaps, and one telemetry line per second.
    const routine = !important && !(level === 'warn') && !/DRONE_TELEMETRY/.test(text);
    if (routine && !this.verbose.checked) return;
    const li = document.createElement('li');
    li.className = level;
    li.innerHTML = `<time>${fmtTime(t)}</time><span></span>`;
    li.lastChild.textContent = text;
    this.list.prepend(li);
    while (this.list.children.length > 250) this.list.lastChild.remove();
    // Screen readers: announce only important events, at most every 1.5 s.
    const now = performance.now();
    if (important && (level === 'reject' || level === 'attack' || level === 'warn') && now - this.lastAnnounce > 1500) {
      this.lastAnnounce = now;
      this.announcer.textContent = text;
    }
  }
}

/* ================================================================== */
/* Red team                                                            */
/* ================================================================== */

export function renderLayerTable(def) {
  const rows = [
    ['noise', 'Inject noise', 'Checksum', 'R5', true],
    ['forge', 'Forge a frame', 'Signature', 'R6', def.requireSignature],
    ['tamper', 'Tamper', 'Signature', 'R6', def.requireSignature],
    ['replay', 'Replay', 'Timestamp', 'R7', def.checkTimestamp],
  ];
  $('layer-body').innerHTML = rows.map(([, name, layer, code, blocked]) => `
    <tr><td>${name}</td><td>${layer} <span class="mono muted">${code}</span></td>
    <td>${blocked ? `<span class="verdict-ok">blocked</span>` : `<span class="verdict-bad">ACCEPTED</span>`}</td></tr>`).join('');
}

export function renderAttackPending(kind) {
  $('atk-out').innerHTML = `<p class="mono muted">${ATTACK_NAMES[kind]}</p><p class="big muted">in flight…</p><p class="muted">Watch the frame on the link above.</p>`;
  $('hp-frame').textContent = `${ATTACK_NAMES[kind]} · waiting for the frame to reach the ground station`;
  resetHPipe();
}

let hpTimers = [];
export function resetHPipe() {
  hpTimers.forEach(clearTimeout);
  hpTimers = [];
  const list = $('hp-steps');
  list.innerHTML = CHECKS.map((c) => `<li class="hp-step"><span class="hp-code">${c.code}</span><span class="hp-label">${c.label}</span><span class="hp-detail">${c.rule}</span></li>`).join('');
  const tok = $('hp-token');
  tok.getAnimations?.().forEach((a) => a.cancel());
  tok.className = 'hp-token mono';
  tok.style.opacity = '0';
}

/**
 * Animate an attack frame through R1..R7 as a token that walks along the
 * steps, lights each one, and drops out at the failing check.
 */
export function renderHPipe(fr, reducedMotion, onDone) {
  resetHPipe();
  const r = fr.result;
  const steps = r.steps;
  const list = $('hp-steps');
  const tok = $('hp-token');
  const n = steps.length;
  const reached = steps.filter((s) => s.status !== 'idle').length;
  $('hp-frame').textContent = `#${fr.id} ${fr.name} · ${fr.bytes.length} B · seq ${fr.bytes[4] ?? '?'}`;
  tok.textContent = ({ noise: 'NOISE', forge: 'FORGED', tamper: 'TAMPERED', replay: 'REPLAY' })[fr.kind] ?? 'ATK';
  const apply = (i) => {
    const s = steps[i], li = list.children[i];
    li.classList.remove('active');
    li.classList.add(s.status);
    li.querySelector('.hp-detail').textContent = s.detail || s.rule;
  };
  if (reducedMotion) {
    for (let i = 0; i < reached; i++) apply(i);
    tok.style.opacity = '1';
    tok.style.left = `${((Math.min(reached, n) - 0.5) / n) * 100}%`;
    tok.classList.add(r.ok ? 'ok' : 'bad');
    onDone?.();
    return;
  }
  const STEP = 340;
  const pct = (i) => `${((i + 0.5) / n) * 100}%`;
  const frames = [{ left: '-4%', opacity: 0, offset: 0 }];
  for (let i = 0; i < reached; i++) frames.push({ left: pct(i), opacity: 1, offset: (i + 1) / (reached + 1) });
  frames.push(r.ok
    ? { left: '102%', opacity: 0, offset: 1 }
    : { left: pct(reached - 1), opacity: 0, transform: 'translate(-50%, 46px) rotate(14deg)', offset: 1 });
  frames.forEach((f) => { f.transform ||= 'translateX(-50%)'; });
  const total = STEP * (reached + 1) + 500;
  tok.style.opacity = '1';
  tok.animate(frames, { duration: total, easing: 'linear', fill: 'forwards' });
  for (let i = 0; i < reached; i++) {
    const at = (total * (i + 1)) / (reached + 1);
    hpTimers.push(setTimeout(() => list.children[i].classList.add('active'), at - 160));
    hpTimers.push(setTimeout(() => {
      apply(i);
      if (i === reached - 1) { tok.classList.add(r.ok ? 'ok' : 'bad'); }
    }, at));
  }
  hpTimers.push(setTimeout(() => onDone?.(), total - 300));
}

export function renderAttackOutcome(fr, gcs) {
  const r = fr.result;
  const ok = r.ok;
  let believed = '';
  if (ok && r.fields && 'altitude_cm' in r.fields) {
    const f = r.fields;
    believed = `<p>Ground station now believes: <strong class="mono">alt ${(f.altitude_cm / 100).toFixed(1)} m, batt ${f.battery_pct}%, ${statusFlags(f.status).join(' ') || 'no flags'}</strong>.</p>`;
    if (fr.kind === 'forge' && f.status & STATUS.LOW_BATTERY) believed += '<p>The fake LOW_BATTERY makes the ground station order the drone home. One forged frame, real consequences.</p>';
  }
  const why = ok
    ? 'The defence that would have stopped it is switched off.'
    : { R5: 'The CRC no longer matches: random damage is caught here.', R6: 'The attacker can recompute a CRC, but not an HMAC without the key.', R7: 'The signature is genuine, but the timestamp is not newer than the last accepted one.' }[r.code] ?? '';
  $('atk-out').innerHTML = `
    <p class="mono muted">${ATTACK_NAMES[fr.kind]} · ${fr.note}</p>
    <p class="big ${ok ? 'bad' : 'ok'}">${ok ? 'ACCEPTED' : `REJECTED ${r.code}`}</p>
    <p>${ok ? '' : `${REASONS[r.code]}: ${r.detail}. `}${why}</p>
    ${believed}`;
}

/* ================================================================== */
/* Frame builder (worked example 10.3)                                 */
/* ================================================================== */

const svgEl = (w, h, body) => `<svg viewBox="0 0 ${w} ${h}" role="img" xmlns="http://www.w3.org/2000/svg">${body}</svg>`;
const box = (x, y, w, h, color, label, sub = '', dashed = false) => `
  <rect x="${x}" y="${y}" width="${w}" height="${h}" fill="#fff" stroke="${color}" stroke-width="1.4" ${dashed ? 'stroke-dasharray="4 3"' : ''}/>
  <text x="${x + w / 2}" y="${y + h / 2 - (sub ? 5 : -1)}" text-anchor="middle" dominant-baseline="middle" font-size="12" font-weight="600" fill="${C.ink}">${label}</text>
  ${sub ? `<text x="${x + w / 2}" y="${y + h / 2 + 10}" text-anchor="middle" dominant-baseline="middle" font-size="10" fill="${C.muted}">${sub}</text>` : ''}`;
const txt = (x, y, s, o = {}) => `<text x="${x}" y="${y}" text-anchor="${o.a ?? 'start'}" font-size="${o.size ?? 10}" fill="${o.fill ?? C.muted}" ${o.w ? `font-weight="${o.w}"` : ''}>${s}</text>`;
const ln = (x1, y1, x2, y2, color = C.muted, dashed = false) => `<line x1="${x1}" y1="${y1}" x2="${x2}" y2="${y2}" stroke="${color}" stroke-width="1" ${dashed ? 'stroke-dasharray="3 3"' : ''}/>`;
const head = (x, y, dir, color = C.muted) => {
  // Small open arrowhead. dir: 'r' | 'l' | 'd'
  const p = dir === 'r' ? `${x - 6},${y - 3.5} ${x},${y} ${x - 6},${y + 3.5}` : dir === 'l' ? `${x + 6},${y - 3.5} ${x},${y} ${x + 6},${y + 3.5}` : `${x - 3.5},${y - 6} ${x},${y} ${x + 3.5},${y - 6}`;
  return `<polyline points="${p}" fill="none" stroke="${color}" stroke-width="1"/>`;
};
// Dimension line with arrowheads at both ends and extension ticks.
const dim = (x1, x2, y, label) => `${ln(x1, y - 5, x1, y + 5)}${ln(x2, y - 5, x2, y + 5)}${ln(x1, y, x2, y)}${head(x1, y, 'l')}${head(x2, y, 'r')}
  <rect x="${(x1 + x2) / 2 - label.length * 3.2 - 4}" y="${y - 7}" width="${label.length * 6.4 + 8}" height="14" fill="#fff"/>${txt((x1 + x2) / 2, y + 3.5, label, { a: 'middle' })}`;

export class FrameBuilder {
  constructor(reducedMotion) {
    this.reducedMotion = reducedMotion;
    this.frame = buildFrame({ msgid: MSG.DRONE_TELEMETRY, fields: TELEMETRY_FIELDS, seq: 2, sysid: 1, sign: { key: DEMO_KEY, linkId: 0, timestamp: SIGNED_TS } });
    this.groupOf = (i) => (i < 10 ? 'header' : i < 23 ? 'payload' : i < 25 ? 'checksum' : 'signature');
    this.steps = this.defineSteps();
    this.i = 0;
    this.buildBytes();
    this.buildNav();
    $('build-prev').addEventListener('click', () => this.go(this.i - 1));
    $('build-next').addEventListener('click', () => this.go(this.i + 1));
    $('build-play').addEventListener('click', () => this.togglePlay());
    this.go(0);
  }

  buildBytes() {
    $('build-bytes').innerHTML = Array.from(this.frame, (b, i) =>
      `<div class="bb g-${this.groupOf(i)}"><div class="bb-hex">${b.toString(16).padStart(2, '0')}</div><div class="bb-off">${i}</div></div>`).join('');
  }

  buildNav() {
    $('build-steps').innerHTML = this.steps.map((s, i) => `<li><button type="button" data-i="${i}">${i + 1} ${s.label}</button></li>`).join('');
    $('build-steps').addEventListener('click', (e) => { const b = e.target.closest('button'); if (b) { this.stop(); this.go(+b.dataset.i); } });
  }

  togglePlay() {
    if (this.timer) return this.stop();
    $('build-play').setAttribute('aria-pressed', 'true');
    $('build-play').textContent = 'Pause';
    if (this.i >= this.steps.length - 1) this.go(0);
    this.timer = setInterval(() => { if (this.i >= this.steps.length - 1) this.stop(); else this.go(this.i + 1); }, 3600);
  }
  stop() {
    clearInterval(this.timer); this.timer = null;
    $('build-play').setAttribute('aria-pressed', 'false');
    $('build-play').textContent = 'Play';
  }

  go(i) {
    this.i = clamp(i, 0, this.steps.length - 1);
    const s = this.steps[this.i];
    const prev = this.shown ?? 0;
    this.shown = s.reveal;
    $('build-progress').style.width = `${(this.i / (this.steps.length - 1)) * 100}%`;
    [...$('build-bytes').children].forEach((el, k) => {
      const fresh = k >= prev && k < s.reveal && !this.reducedMotion;
      el.classList.remove('just');
      if (fresh) { el.style.setProperty('--k', k - prev); void el.offsetWidth; el.classList.add('just'); }
      el.classList.toggle('on', k < s.reveal);
      el.classList.toggle('focus', s.focus && k >= s.focus[0] && k <= s.focus[1]);
    });
    $('build-steps').querySelectorAll('button').forEach((b, k) => { if (k === this.i) b.setAttribute('aria-current', 'step'); else b.removeAttribute('aria-current'); });
    $('build-fig').textContent = `Fig. 3.${this.i + 1}  ${s.fig}`;
    $('build-caption').innerHTML = s.caption;
    $('build-diagram').innerHTML = s.diagram();
    $('build-prev').disabled = this.i === 0;
    $('build-next').disabled = this.i === this.steps.length - 1;
  }

  defineSteps() {
    const f = this.frame;
    const hx = (a, b) => toHex(f.subarray(a, b));
    const crc = computeChecksum(f);
    // HMAC input = FRAME (bytes 0-24) || LINK_ID (25) || TIMESTAMP (26-31): exactly bytes 0-31.
    const tag = hmacSha256(DEMO_KEY, f.subarray(0, 32));
    const sig = computeSignature(f, DEMO_KEY, 0, SIGNED_TS);
    const matches = toHex(f) === VECTORS.signed;
    const rx = new Receiver({ key: DEMO_KEY, clock: () => SIGNED_TS + 1000 }).process(f);

    const layout = () => svgEl(620, 170, `
      ${txt(0, 14, 'signed frame = 25 + LEN bytes', { fill: C.ink, w: 600, size: 11 })}
      ${txt(0, 44, '0')}${txt(200, 44, '10')}${txt(360, 44, 'n+10')}${txt(420, 44, 'n+12')}
      ${box(0, 52, 200, 50, C.header, 'HEADER', 'STX … MSGID')}
      ${box(200, 52, 160, 50, C.payload, 'PAYLOAD', 'LEN bytes')}
      ${box(360, 52, 60, 50, C.checksum, 'CRC', '2 B')}
      ${box(420, 52, 196, 50, C.signature, 'SIGNATURE BLOCK', 'LINK_ID · TS · SIG')}
      ${dim(0, 200, 124, '10 B')}${dim(200, 360, 124, 'LEN')}${dim(360, 420, 124, '2 B')}${dim(420, 616, 124, '13 B')}
      ${txt(0, 160, 'all multi-byte values little-endian')}`);

    const fieldTable = () => `<table class="layer-table"><thead><tr><th>field</th><th>type</th><th>value</th><th>bytes (LE)</th></tr></thead><tbody>${
      payloadLayout(MSG.DRONE_TELEMETRY).map((p) => `<tr><td class="mono">${p.name}</td><td class="mono muted">${p.type}</td><td class="mono">${TELEMETRY_FIELDS[p.name]}</td><td class="mono">${hx(10 + p.offset, 10 + p.offset + p.size)}</td></tr>`).join('')
    }</tbody></table>${statusSvg(TELEMETRY_FIELDS.status)}`;

    const checksumSvg = () => svgEl(620, 210, `
      ${box(0, 20, 60, 46, C.muted, 'STX', 'not covered', true)}
      ${box(60, 20, 340, 46, C.checksum, 'LEN … end of PAYLOAD', '22 bytes, as sent')}
      ${box(400, 20, 110, 46, C.checksum, 'CRC_EXTRA 52', 'not sent', true)}
      ${dim(60, 510, 86, 'covered')}
      ${ln(285, 94, 285, 118)}${head(285, 120, 'd')}
      ${box(185, 122, 200, 40, C.ink, 'CRC-16/MCRF4XX', 'init 0xFFFF')}
      ${ln(385, 142, 430, 142)}${head(432, 142, 'r')}
      ${box(434, 122, 80, 40, C.checksum, hex4(crc))}
      ${ln(514, 142, 540, 142)}${head(542, 142, 'r')}
      ${box(544, 122, 72, 40, C.checksum, hx(23, 25), 'low first')}
      ${txt(0, 196, 'CRC_EXTRA = fold(crc("DRONE_TELEMETRY uint32_t time_ms … uint8_t status ")) = 52')}`);

    const tsSvg = () => svgEl(620, 150, `
      ${box(0, 20, 70, 46, C.signature, 'LINK_ID', '00')}
      ${box(70, 20, 250, 46, C.signature, 'TIMESTAMP', hx(26, 32))}
      ${dim(0, 70, 88, '1 B')}${dim(70, 320, 88, '6 B, 48-bit LE')}
      ${txt(340, 38, 'timestamp = (unix_s − 1420070400) × 100000', { fill: C.ink, size: 10.5 })}
      ${txt(340, 56, `${SIGNED_TS.toLocaleString('en-US')} × 10 µs = 1000 s`)}
      ${txt(340, 74, 'after 2015-01-01 00:00 GMT')}
      ${txt(0, 126, 'receiver rule: newer than the stored one for (SYSID, COMPID, LINK_ID), and < 1 min old')}`);

    const hmacSvg = () => svgEl(620, 290, `
      ${box(0, 10, 220, 46, C.header, 'FRAME', 'STX … CHECKSUM, 25 B')}
      ${txt(230, 38, '||', { fill: C.ink, size: 14, w: 700 })}
      ${box(248, 10, 80, 46, C.signature, 'LINK_ID', '1 B')}
      ${txt(338, 38, '||', { fill: C.ink, size: 14, w: 700 })}
      ${box(356, 10, 110, 46, C.signature, 'TIMESTAMP', '6 B')}
      ${ln(110, 56, 110, 76)}${ln(288, 56, 288, 76)}${ln(411, 56, 411, 76)}${ln(110, 76, 411, 76)}
      ${ln(250, 76, 250, 96)}${head(250, 98, 'd')}
      ${box(160, 100, 180, 44, C.ink, 'HMAC-SHA256')}
      ${box(440, 100, 176, 44, C.ink, 'SECRET KEY', '00 01 … 1f (public test key)', true)}
      ${ln(440, 122, 344, 122)}${head(342, 122, 'l')}
      ${ln(250, 144, 250, 166)}${head(250, 168, 'd')}
      ${box(0, 170, 616, 42, C.muted, '', '')}
      ${txt(10, 188, '32-byte tag', { size: 10 })}
      <text x="10" y="204" font-size="10.5" fill="${C.muted}"><tspan fill="${C.signature}" font-weight="700">${toHex(tag.subarray(0, 6))}</tspan> ${toHex(tag.subarray(6, 20))} …</text>
      ${ln(60, 212, 60, 236)}${head(60, 238, 'd', C.signature)}
      ${box(0, 240, 230, 42, C.signature, 'SIGNATURE', toHex(sig))}
      ${txt(246, 266, 'first 6 bytes of the tag = 48-bit signature')}`);

    return [
      { label: 'layout', reveal: 0, fig: 'Frame layout', diagram: layout,
        caption: 'A signed frame is <strong>25 + LEN</strong> bytes: a 10-byte header, the payload, a 2-byte checksum and a 13-byte signature block. Every multi-byte value is little-endian.' },
      { label: 'STX LEN', reveal: 2, focus: [0, 1], fig: 'Start marker and length', diagram: layout,
        caption: '<code>STX 0xFD</code> marks the start of a frame. <code>LEN 0x0d</code> = 13 is the payload size <em>after</em> trailing zero bytes are removed; here nothing is removed because the last byte (status <code>0x63</code>) is not zero.' },
      { label: 'flags', reveal: 4, focus: [2, 3], fig: 'Flags', diagram: layout,
        caption: '<code>INCOMPAT_FLAGS 0x01</code>: this frame is signed. A receiver must understand every bit here, so an unsigned frame or an unknown bit is rejected at <strong>R2</strong>. <code>COMPAT_FLAGS 0x00</code>.' },
      { label: 'SEQ IDs', reveal: 7, focus: [4, 6], fig: 'Sequence and identifiers', diagram: layout,
        caption: '<code>SEQ 2</code>, <code>SYSID 1</code> (drone), <code>COMPID 1</code>. SEQ wraps at 255 and is only used to count lost frames; it plays no part in replay protection.' },
      { label: 'MSGID', reveal: 10, focus: [7, 9], fig: 'Message id', diagram: layout,
        caption: '<code>MSGID 42000</code> = <code>0x00A410</code>, 24 bits, low byte first: <code>10 a4 00</code>. The receiver needs it to find the message layout and its CRC_EXTRA (<strong>R4</strong>).' },
      { label: 'payload', reveal: 23, focus: [10, 22], fig: 'Payload, largest fields first', diagram: fieldTable,
        caption: 'Fields are sent largest first (4, 2, then 1-byte types), each little-endian. <code>altitude_cm 12050</code> becomes <code>12 2f 00 00</code>. The status byte packs five flags and the flight mode.' },
      { label: 'checksum', reveal: 25, focus: [23, 24], fig: 'Checksum with CRC_EXTRA', diagram: checksumSvg,
        caption: `CRC-16/MCRF4XX over LEN … payload, then one extra byte <code>CRC_EXTRA 52</code> derived from the message definition and never sent. Result <code>${hex4(crc)}</code>, sent low byte first. It catches noise (<strong>R5</strong>), but anyone can recompute it.` },
      { label: 'link + time', reveal: 32, focus: [25, 31], fig: 'Link id and timestamp', diagram: tsSvg,
        caption: '<code>LINK_ID 0</code>, then a 48-bit <code>TIMESTAMP</code> in 10 µs units since 2015. Each sender makes it strictly increase; the receiver rejects anything not newer (<strong>R7</strong>).' },
      { label: 'HMAC', reveal: 38, focus: [32, 37], fig: 'Signature', diagram: hmacSvg,
        caption: 'HMAC-SHA256 over <code>FRAME || LINK_ID || TIMESTAMP</code> with the 32-byte key. The first 6 bytes of the tag are the signature. Without the key, a valid one cannot be made (<strong>R6</strong>).' },
      { label: 'done', reveal: 38, fig: 'Complete frame, checked', diagram: () => `<ol class="mini-steps">${rx.steps.map((s) => `<li class="${s.status}">${s.code} ${s.label}</li>`).join('')}</ol>
          <p class="mono" style="font-size:12px;margin:10px 0 0;word-break:break-all">${toHex(f)}</p>`,
        caption: `38 bytes, ${matches ? '<strong>identical to vector 10.3</strong> of the specification' : '<strong>does not match vector 10.3</strong>'}. Run through the receiver, it passes all seven checks.` },
    ];
  }
}

function statusSvg(s) {
  const names = ['mode', 'mode', 'mode', 'FAILSAFE', 'RETURNING', 'LOW_BATT', 'GPS_LOCK', 'ARMED'];
  let body = '';
  for (let i = 0; i < 8; i++) {
    const bit = 7 - i, x = i * 76, on = (s >> bit) & 1;
    body += `${txt(x + 38, 12, `bit ${bit}`, { a: 'middle' })}
      <rect x="${x}" y="18" width="76" height="40" fill="#fff" stroke="${i < 3 ? C.payload : C.header}" stroke-width="${on ? 1.8 : 1}" ${on ? '' : 'stroke-dasharray="3 3"'}/>
      ${txt(x + 38, 34, names[i], { a: 'middle', fill: C.ink, size: 9.5 })}${txt(x + 38, 50, on, { a: 'middle', fill: on ? C.deep : C.muted, size: 12, w: 700 })}`;
  }
  body += dim(0, 228, 74, `mode ${statusMode(s)} = ${MODES[statusMode(s)]}`) + dim(228, 608, 74, 'flags');
  return `<div style="margin-top:14px">${svgEl(610, 86, body)}</div>`;
}

/* ================================================================== */
/* Conformance                                                         */
/* ================================================================== */

export function renderConformance(tests, ms) {
  const passed = tests.filter((t) => t.pass).length;
  $('conf-summary').innerHTML = `<span class="${passed === tests.length ? 'ok' : 'bad'}">${passed} / ${tests.length} pass</span> · ran in ${ms.toFixed(1)} ms · ${new Date().toLocaleString()} · ${navigator.userAgent.match(/(Firefox|Edg|Chrome|Safari)\/[\d.]+/)?.[0] ?? 'this browser'}`;
  const score = $('conf-score');
  score.textContent = `${passed}/${tests.length}`;
  score.classList.toggle('bad', passed !== tests.length);
  $('conf-body').innerHTML = tests.map((t, i) => `
    <tr style="--i:${i}"><td>${t.id}</td><td>${t.name}</td><td>${t.expected}</td><td>${t.got}</td>
    <td><span class="mark ${t.pass ? 'pass' : 'fail'}">${t.pass ? 'PASS' : 'FAIL'}</span></td></tr>`).join('');
}

export { ATTACKS, ATTACK_NAMES, readU48, fmtField };
