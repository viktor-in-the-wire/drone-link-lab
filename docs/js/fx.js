// fx.js
// "Pixels build the page": the intro loader and the scroll reveals.
// Pure canvas 2D, no dependencies. Both are skipped with prefers-reduced-motion.

const BLUE = '#2563eb', DEEP = '#1d4ed8', GRID = '#eef2ff';
const easeOut = (t) => 1 - Math.pow(1 - t, 3);
const wait = (ms) => new Promise((r) => setTimeout(r, ms));
const clamp = (v, a, b) => Math.max(a, Math.min(b, v));

/**
 * Intro: the logo and the wordmark assemble from scattered pixels while the
 * protocol self-test runs, then the white sheet dissolves cell by cell.
 * @param {{reducedMotion:boolean, passed:number, total:number}} o
 */
export async function runLoader(opts) {
  try { await loaderBody(opts); }
  catch (e) { console.warn('loader skipped:', e); }
  finally { document.body.classList.add('loaded'); document.getElementById('loader')?.remove(); }
}

async function loaderBody({ reducedMotion, passed, total }) {
  const el = document.getElementById('loader');
  const done = () => { document.body.classList.add('loaded'); el?.remove(); };
  if (!el) return done();
  if (reducedMotion) return done();

  const canvas = el.querySelector('canvas');
  const msg = el.querySelector('.loader-msg');
  const ctx = canvas.getContext('2d');
  const dpr = Math.min(window.devicePixelRatio || 1, 2);
  const W = window.innerWidth, H = window.innerHeight;
  if (!W || !H || document.hidden) return done();
  canvas.width = W * dpr; canvas.height = H * dpr;
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);

  try { await Promise.race([document.fonts.load('600 40px "IBM Plex Mono"'), wait(500)]); } catch { /* fallback font */ }

  // Rasterise the mark + wordmark at 1 sample per cell; every opaque sample becomes a pixel.
  const cell = W < 640 ? 5 : 7;
  const ow = Math.floor(W / cell), oh = Math.floor(H / cell);
  const off = document.createElement('canvas');
  off.width = ow; off.height = oh;
  const o = off.getContext('2d', { willReadFrequently: true });
  // Layout in cell units: mark on top, a clear gap, then the wordmark.
  const fs = clamp(Math.floor((ow * 0.8) / (14 * 0.62)), 6, 10);      // wordmark cap size
  const L = clamp(Math.round(fs * 3.4), 22, 36);                        // mark size
  const gap = Math.round(fs * 1.4);
  const blockH = L + gap + fs;
  const top = Math.round(oh / 2 - blockH / 2 - 4);
  const k = L / 40, mx = ow / 2 - L / 2, my = top;                      // mark uses the 40-unit logo grid
  const P = (x, y) => [mx + x * k, my + y * k];
  o.strokeStyle = '#000'; o.fillStyle = '#000'; o.lineWidth = Math.max(1, 1.6 * k);
  for (const [x, y] of [[9.5, 9.5], [30.5, 9.5], [30.5, 30.5], [9.5, 30.5]]) {
    o.beginPath(); o.arc(...P(x, y), 5.5 * k, 0, Math.PI * 2); o.stroke();
  }
  for (const [x1, y1, x2, y2] of [[13.4, 13.4, 16, 16], [26.6, 13.4, 24, 16], [26.6, 26.6, 24, 24], [13.4, 26.6, 16, 24]]) {
    o.beginPath(); o.moveTo(...P(x1, y1)); o.lineTo(...P(x2, y2)); o.stroke();
  }
  o.strokeRect(...P(16, 16), 8 * k, 8 * k);
  o.fillRect(...P(18.4, 18.4), 3.2 * k, 3.2 * k);
  const logoBottom = my + L;
  o.font = `600 ${fs * 1.36}px "IBM Plex Mono", ui-monospace, monospace`;
  o.textAlign = 'center'; o.textBaseline = 'alphabetic';
  const textBase = logoBottom + gap + fs;
  o.fillText('DRONE LINK LAB', ow / 2, textBase);
  const cx = ow / 2;
  msg.style.top = `${(textBase + fs * 0.6) * cell + 24}px`;
  const data = o.getImageData(0, 0, ow, oh).data;

  const pixels = [];
  for (let y = 0; y < oh; y++) for (let x = 0; x < ow; x++) {
    if (data[(y * ow + x) * 4 + 3] > 110) {
      const a = Math.random() * Math.PI * 2, r = Math.max(W, H) * (0.35 + Math.random() * 0.4);
      pixels.push({
        tx: x * cell, ty: y * cell,
        sx: W / 2 + Math.cos(a) * r, sy: H / 2 + Math.sin(a) * r,
        delay: y <= logoBottom + 1 ? Math.random() * 500 : 420 + ((x - (cx - 60)) / 120) * 420 + Math.random() * 180,
        dur: 520 + Math.random() * 360,
      });
    }
  }
  const assembleEnd = Math.max(...pixels.map((p) => p.delay + p.dur), 900);

  // The white sheet that dissolves at the end: coarse cells removed in random order.
  const sc = W < 640 ? 22 : 30;
  const sheet = [];
  for (let y = 0; y < H; y += sc) for (let x = 0; x < W; x += sc) {
    sheet.push({ x, y, t: Math.random() * 520 + ((y / H) * 0.6 + Math.random() * 0.4) * 200 });
  }

  const lines = [
    [0, 'allocating frame buffer'],
    [380, 'crc-16/mcrf4xx ......... ok'],
    [720, 'hmac-sha256 ............ ok'],
    [1050, `conformance ${passed}/${total} ${passed === total ? 'pass' : 'FAIL'}`],
  ];

  let skip = false;
  const onSkip = () => { skip = true; };
  el.addEventListener('pointerdown', onSkip);
  window.addEventListener('keydown', onSkip, { once: true });

  const HOLD = 320, EXIT = 760;
  const t0 = performance.now();
  let exitStart = null;

  await new Promise((resolve) => {
    const frame = (now) => {
      let t = now - t0;
      if (skip && exitStart === null) exitStart = t;
      if (exitStart === null && t > assembleEnd + HOLD) exitStart = t;
      const e = exitStart === null ? -1 : t - exitStart;
      if (e === 0 || (e > 0 && !document.body.classList.contains('loaded'))) document.body.classList.add('loaded');

      ctx.clearRect(0, 0, W, H);
      // Paper and faint grid.
      ctx.fillStyle = '#fff'; ctx.fillRect(0, 0, W, H);
      ctx.strokeStyle = GRID; ctx.lineWidth = 1;
      ctx.beginPath();
      for (let x = 0.5; x < W; x += cell * 6) { ctx.moveTo(x, 0); ctx.lineTo(x, H); }
      for (let y = 0.5; y < H; y += cell * 6) { ctx.moveTo(0, y); ctx.lineTo(W, y); }
      ctx.stroke();

      // Pixels flying to their place.
      for (const p of pixels) {
        const k = clamp((t - p.delay) / p.dur, 0, 1);
        if (k <= 0) continue;
        const q = easeOut(k);
        const x = p.sx + (p.tx - p.sx) * q, y = p.sy + (p.ty - p.sy) * q;
        ctx.globalAlpha = 0.25 + 0.75 * k;
        ctx.fillStyle = k >= 1 ? DEEP : BLUE;
        ctx.fillRect(x, y, cell - 1, cell - 1);
      }
      ctx.globalAlpha = 1;

      // Status text under the mark.
      const line = lines.filter(([at]) => t >= at).pop();
      if (line && msg.textContent !== line[1]) msg.textContent = line[1];

      // Dissolve: punch holes through the sheet; the frontier flashes as blue outlines.
      if (e >= 0) {
        msg.style.opacity = String(1 - clamp(e / 200, 0, 1));
        for (const s of sheet) {
          if (e >= s.t) ctx.clearRect(s.x, s.y, sc, sc);
          else if (s.t - e < 110) { ctx.strokeStyle = BLUE; ctx.strokeRect(s.x + 0.5, s.y + 0.5, sc - 1, sc - 1); }
        }
        if (e > EXIT) { resolve(); return; }
      }
      requestAnimationFrame(frame);
    };
    requestAnimationFrame(frame);
  });
  window.removeEventListener('keydown', onSkip);
  done();
}

/**
 * Scroll reveals: each [data-reveal] element is covered by a canvas of white
 * cells that dissolve left to right, with blue outlined cells at the edge.
 */
export function setupReveals({ reducedMotion }) {
  const els = [...document.querySelectorAll('[data-reveal]')];
  if (reducedMotion || !('IntersectionObserver' in window)) return;
  els.forEach((e) => e.classList.add('reveal-pending'));
  const io = new IntersectionObserver((entries) => {
    for (const en of entries) {
      if (!en.isIntersecting) continue;
      io.unobserve(en.target);
      const delay = document.body.classList.contains('loaded') ? 0 : 900;
      setTimeout(() => reveal(en.target), delay + (+en.target.dataset.reveal || 0));
    }
  }, { rootMargin: '0px 0px -6% 0px', threshold: 0.04 });
  els.forEach((e) => io.observe(e));
}

function reveal(el) {
  const w = el.offsetWidth, h = el.offsetHeight;
  if (!w || !h) { el.classList.remove('reveal-pending'); return; }
  const dpr = Math.min(window.devicePixelRatio || 1, 2);
  const c = document.createElement('canvas');
  c.className = 'reveal-canvas';
  c.width = Math.ceil((w + 2) * dpr); c.height = Math.ceil((h + 2) * dpr);
  c.style.width = `${w + 2}px`; c.style.height = `${h + 2}px`;
  const ctx = c.getContext('2d');
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  const cell = w > 700 ? 14 : 11;
  const cols = Math.ceil((w + 2) / cell), rows = Math.ceil((h + 2) / cell);
  const D = clamp(420 + w * 0.25, 520, 900);
  const cells = new Float32Array(cols * rows);
  for (let y = 0; y < rows; y++) for (let x = 0; x < cols; x++) {
    cells[y * cols + x] = ((x / cols) * 0.55 + (y / rows) * 0.15 + Math.random() * 0.4) * D;
  }
  el.appendChild(c);
  el.classList.remove('reveal-pending');
  const t0 = performance.now();
  const frame = (now) => {
    const t = now - t0;
    ctx.clearRect(0, 0, w + 2, h + 2);
    ctx.fillStyle = '#fff';
    ctx.strokeStyle = BLUE;
    ctx.lineWidth = 1;
    for (let i = 0; i < cells.length; i++) {
      const rt = cells[i];
      if (t >= rt) continue;
      const x = (i % cols) * cell, y = Math.floor(i / cols) * cell;
      ctx.fillRect(x, y, cell, cell);
      if (rt - t < 80) ctx.strokeRect(x + 1.5, y + 1.5, cell - 3, cell - 3);
    }
    if (t < D) requestAnimationFrame(frame);
    else c.remove();
  };
  requestAnimationFrame(frame);
}
