// ภาพคนนั่งมองจากด้านข้าง หลังโค้งตามค่า upper / lower จริงจาก packet
import { fmtDeg } from './util.js';

const NS = 'http://www.w3.org/2000/svg';
const HIP = { x: 104, y: 222 };
const SEGMENTS = [58, 50, 46];
const BACK_OFFSET = 20;
const MIN_ANGLE = -25;
const MAX_ANGLE = 85;

const rad = deg => (deg * Math.PI) / 180;
const clampAngle = a => Math.min(MAX_ANGLE, Math.max(MIN_ANGLE, a));
const lerp = (a, b, t) => ({ x: a.x + (b.x - a.x) * t, y: a.y + (b.y - a.y) * t });
const mid = (a, b) => lerp(a, b, 0.5);
const n = v => v.toFixed(1);

const smoothPath = pts => {
  let d = `M${n(pts[0].x)} ${n(pts[0].y)}`;
  const first = mid(pts[0], pts[1]);
  d += ` L${n(first.x)} ${n(first.y)}`;
  for (let i = 1; i < pts.length - 1; i++) {
    const m = mid(pts[i], pts[i + 1]);
    d += ` Q${n(pts[i].x)} ${n(pts[i].y)} ${n(m.x)} ${n(m.y)}`;
  }
  const last = pts[pts.length - 1];
  return `${d} L${n(last.x)} ${n(last.y)}`;
};

/** คำนวณจุดของแนวสันหลังจากมุมของเซนเซอร์สองตัว */
const spineGeometry = (upperDeg, lowerDeg) => {
  const upper = clampAngle(upperDeg);
  const lower = clampAngle(lowerDeg);
  const angles = [lower, (lower + upper) / 2, upper];
  const pts = [{ ...HIP }];
  angles.forEach((a, i) => {
    const p = pts[i];
    pts.push({ x: p.x + SEGMENTS[i] * Math.sin(rad(a)), y: p.y - SEGMENTS[i] * Math.cos(rad(a)) });
  });
  const pointAngles = [angles[0], (angles[0] + angles[1]) / 2, (angles[1] + angles[2]) / 2, angles[2]];
  const back = pts.map((p, i) => {
    const a = rad(pointAngles[i]);
    return { x: p.x - BACK_OFFSET * Math.cos(a), y: p.y - BACK_OFFSET * Math.sin(a) };
  });
  const headAngle = rad(upper * 0.75);
  const shoulder = pts[3];
  const head = { x: shoulder.x + 42 * Math.sin(headAngle) + 3, y: shoulder.y - 42 * Math.cos(headAngle) };
  return { pts, back, head, shoulder };
};

const el = (name, attrs = {}, parent) => {
  const node = document.createElementNS(NS, name);
  for (const [k, v] of Object.entries(attrs)) node.setAttribute(k, v);
  if (parent) parent.appendChild(node);
  return node;
};

export const createBackFigure = container => {
  const svg = el('svg', { viewBox: '0 0 290 300', class: 'figure', role: 'img' });
  const title = el('title', {}, svg);
  title.textContent = 'ภาพหลังมองจากด้านข้าง';

  el('path', { d: 'M56 262 H152 M104 262 V296 M78 296 H130', class: 'fig-stool' }, svg);
  el('path', { d: `M${HIP.x} ${HIP.y + 8} H206 V290 H232`, class: 'fig-leg' }, svg);
  const guide = el('line', { x1: HIP.x - BACK_OFFSET, y1: HIP.y, x2: HIP.x - BACK_OFFSET, y2: HIP.y - 170, class: 'fig-guide' }, svg);
  guide.setAttribute('aria-hidden', 'true');
  const torso = el('path', { class: 'fig-body' }, svg);
  const arm = el('path', { class: 'fig-arm' }, svg);
  const head = el('circle', { r: 25, class: 'fig-head' }, svg);
  const spine = el('path', { class: 'fig-spine' }, svg);

  const makeSensor = () => {
    const ring = el('circle', { r: 15, class: 'fig-ring' }, svg);
    const dot = el('circle', { r: 7, class: 'fig-dot' }, svg);
    const label = el('text', { class: 'fig-label', 'text-anchor': 'end' }, svg);
    return { ring, dot, label };
  };
  const top = makeSensor();
  const bottom = makeSensor();
  container.replaceChildren(svg);

  const reduced = window.matchMedia?.('(prefers-reduced-motion: reduce)');
  const shown = { upper: 0, lower: 0 };
  const target = { upper: 0, lower: 0 };
  let frame = null;
  let labelText = { upper: '–', lower: '–' };

  const place = (sensor, p, text) => {
    for (const node of [sensor.ring, sensor.dot]) {
      node.setAttribute('cx', n(p.x));
      node.setAttribute('cy', n(p.y));
    }
    sensor.label.setAttribute('x', n(Math.max(66, p.x - 14)));
    sensor.label.setAttribute('y', n(p.y + 5));
    sensor.label.textContent = text;
  };

  const draw = () => {
    const g = spineGeometry(shown.upper, shown.lower);
    torso.setAttribute('d', smoothPath(g.pts));
    // ตัดปลายเส้นสันหลังเล็กน้อย ไม่ให้โผล่พ้นปลายมนของลำตัว
    spine.setAttribute('d', smoothPath([lerp(g.back[0], g.back[1], 0.22), g.back[1], g.back[2], lerp(g.back[3], g.back[2], 0.18)]));
    head.setAttribute('cx', n(g.head.x));
    head.setAttribute('cy', n(g.head.y));
    arm.setAttribute('d', `M${n(g.shoulder.x)} ${n(g.shoulder.y + 8)} Q${n((g.shoulder.x + 172) / 2 - 8)} ${n((g.shoulder.y + 214) / 2 + 26)} 172 214`);
    place(top, mid(g.back[2], g.back[3]), labelText.upper);
    place(bottom, mid(g.back[0], g.back[1]), labelText.lower);
  };

  const step = () => {
    frame = null;
    const du = target.upper - shown.upper;
    const dl = target.lower - shown.lower;
    if (reduced?.matches || (Math.abs(du) < 0.05 && Math.abs(dl) < 0.05)) {
      shown.upper = target.upper;
      shown.lower = target.lower;
      draw();
      return;
    }
    shown.upper += du * 0.14;
    shown.lower += dl * 0.14;
    draw();
    frame = requestAnimationFrame(step);
  };

  draw();

  return {
    /** tone: ok | bad | idle | warn */
    set({ upper, lower, tone = 'idle', alarm = false, known = true, twoSensors = true }) {
      svg.dataset.tone = tone;
      svg.classList.toggle('is-alarm', alarm);
      labelText = known
        ? { upper: `บน ${fmtDeg(upper)}`, lower: twoSensors ? `ล่าง ${fmtDeg(lower)}` : 'ล่าง –' }
        : { upper: 'บน –', lower: 'ล่าง –' };
      title.textContent = known
        ? `ภาพหลังมองจากด้านข้าง เซนเซอร์ตัวบนเอียง ${fmtDeg(upper)} ตัวล่างเอียง ${fmtDeg(lower)}`
        : 'ภาพหลังมองจากด้านข้าง ยังไม่มีข้อมูล';
      if (known) {
        target.upper = upper;
        target.lower = lower;
      }
      if (frame === null) frame = requestAnimationFrame(step);
    },
  };
};
