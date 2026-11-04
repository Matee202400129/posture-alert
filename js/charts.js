// กราฟสดความโค้งหลัง 60 วินาที (canvas) และกราฟแท่ง 7 วัน (HTML)
import { dayFull, dayShort, fmtDeg, fmtDuration, goodPercent } from './util.js';

const WINDOW_MS = 60000;
const GAP_MS = 2500; // ไม่ได้รับข้อมูลนานกว่านี้ให้เว้นเส้นกราฟ ไม่ลากเส้นผ่าน
const PAD = { left: 34, right: 12, top: 14, bottom: 24 };

const niceCeil = (v, step) => Math.ceil(v / step) * step;
const niceFloor = (v, step) => Math.floor(v / step) * step;

export class LiveChart {
  constructor(canvas) {
    this.canvas = canvas;
    this.ctx = canvas.getContext('2d');
    this.points = [];
    this.thr = 15;
    this.hoverX = null;
    this.width = 0;
    this.height = 0;
    this.resize = this.resize.bind(this);
    new ResizeObserver(this.resize).observe(canvas);
    canvas.addEventListener('pointermove', e => this._hover(e));
    canvas.addEventListener('pointerdown', e => this._hover(e));
    canvas.addEventListener('pointerleave', () => { this.hoverX = null; this.draw(); });
    canvas.addEventListener('pointercancel', () => { this.hoverX = null; this.draw(); });
  }

  _hover(e) {
    const box = this.canvas.getBoundingClientRect();
    this.hoverX = e.clientX - box.left;
    this.draw();
  }

  resize() {
    const box = this.canvas.getBoundingClientRect();
    if (!box.width) return;
    const dpr = Math.min(window.devicePixelRatio || 1, 3);
    this.width = box.width;
    this.height = box.height;
    this.canvas.width = Math.round(box.width * dpr);
    this.canvas.height = Math.round(box.height * dpr);
    this.ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    this.draw();
  }

  clear() {
    this.points = [];
    this.draw();
  }

  /** v เป็น null ได้ เมื่อค่าใช้ไม่ได้ (เซนเซอร์มีปัญหา) กราฟจะเว้นช่วงนั้น */
  push(t, v, thr) {
    this.points.push({ t, v });
    this.thr = thr;
    const cutoff = t - WINDOW_MS - 2000;
    while (this.points.length && this.points[0].t < cutoff) this.points.shift();
  }

  /** สรุปข้อมูลใน 60 วินาทีล่าสุด ใช้แสดงเป็นตัวอักษรและให้ screen reader อ่าน */
  summary(now = performance.now()) {
    const recent = this.points.filter(p => p.v !== null && p.t >= now - WINDOW_MS);
    if (!recent.length) return null;
    const max = recent.reduce((m, p) => Math.max(m, p.v), -Infinity);
    let over = 0;
    for (let i = 1; i < recent.length; i++) {
      const dt = recent[i].t - recent[i - 1].t;
      if (recent[i].v > this.thr && dt < GAP_MS) over += dt;
    }
    return { max, overSeconds: Math.round(over / 1000), last: recent[recent.length - 1].v };
  }

  draw(now = performance.now()) {
    const { ctx, width: w, height: h } = this;
    if (!w) return;
    const css = getComputedStyle(this.canvas);
    const color = name => css.getPropertyValue(name).trim();
    const family = '"IBM Plex Sans Thai", system-ui, sans-serif';
    ctx.clearRect(0, 0, w, h);

    const visible = this.points.filter(p => p.t >= now - WINDOW_MS - 1000 && p.v !== null);
    const values = visible.map(p => p.v);
    const yMax = niceCeil(Math.max(this.thr + 10, ...values, 20), 10);
    const yMin = niceFloor(Math.min(0, ...values), 10);
    const plotW = w - PAD.left - PAD.right;
    const plotH = h - PAD.top - PAD.bottom;
    const x = t => PAD.left + plotW * (1 - (now - t) / WINDOW_MS);
    const y = v => PAD.top + plotH * (1 - (v - yMin) / (yMax - yMin));

    // เส้นตารางและแกน
    ctx.font = `400 12px ${family}`;
    ctx.fillStyle = color('--muted');
    ctx.strokeStyle = color('--grid');
    ctx.lineWidth = 1;
    ctx.textAlign = 'right';
    ctx.textBaseline = 'middle';
    const step = yMax - yMin > 40 ? 20 : 10;
    for (let v = yMin; v <= yMax; v += step) {
      const py = Math.round(y(v)) + 0.5;
      ctx.beginPath();
      ctx.moveTo(PAD.left, py);
      ctx.lineTo(w - PAD.right, py);
      ctx.stroke();
      ctx.fillText(`${v < 0 ? '−' : ''}${Math.abs(v)}°`, PAD.left - 6, py);
    }
    ctx.textBaseline = 'alphabetic';
    const labels = [[0, '60 วิที่แล้ว', 'left'], [0.5, '30 วิ', 'center'], [1, 'ตอนนี้', 'right']];
    for (const [f, text, align] of labels) {
      ctx.textAlign = align;
      ctx.fillText(text, PAD.left + plotW * f, h - 6);
    }

    // เส้นเกณฑ์เตือน
    const thrY = y(this.thr);
    ctx.save();
    ctx.setLineDash([6, 4]);
    ctx.strokeStyle = color('--bad');
    ctx.lineWidth = 1.5;
    ctx.beginPath();
    ctx.moveTo(PAD.left, thrY);
    ctx.lineTo(w - PAD.right, thrY);
    ctx.stroke();
    ctx.restore();
    ctx.font = `500 12px ${family}`;
    ctx.fillStyle = color('--text');
    ctx.textAlign = 'left';
    ctx.fillText(`เกณฑ์เตือน ${this.thr}°`, PAD.left + 4, thrY - 5);

    // เส้นข้อมูล: ใต้เกณฑ์สีเขียว เหนือเกณฑ์สีแดง และเว้นช่วงที่ไม่มีข้อมูล
    const trace = () => {
      ctx.beginPath();
      let prev = null;
      for (const p of this.points) {
        if (p.v === null) { prev = null; continue; }
        if (prev && p.t - prev.t <= GAP_MS) ctx.lineTo(x(p.t), y(p.v));
        else ctx.moveTo(x(p.t), y(p.v));
        prev = p;
      }
    };
    const clipped = (top, height, stroke) => {
      ctx.save();
      ctx.beginPath();
      ctx.rect(PAD.left, top, plotW, height);
      ctx.clip();
      ctx.strokeStyle = stroke;
      ctx.lineWidth = 2;
      ctx.lineJoin = 'round';
      ctx.lineCap = 'round';
      trace();
      ctx.stroke();
      ctx.restore();
    };
    clipped(PAD.top, thrY - PAD.top, color('--bad'));
    clipped(thrY, PAD.top + plotH - thrY, color('--ok'));

    // จุดค่าล่าสุด
    const last = this.points[this.points.length - 1];
    if (last && last.v !== null && now - last.t <= GAP_MS) {
      ctx.beginPath();
      ctx.arc(x(last.t), y(last.v), 5, 0, Math.PI * 2);
      ctx.fillStyle = last.v > this.thr ? color('--bad') : color('--ok');
      ctx.strokeStyle = color('--card');
      ctx.lineWidth = 2;
      ctx.fill();
      ctx.stroke();
    }

    this._drawHover(now, x, y, color, family, w);
  }

  _drawHover(now, x, y, color, family, w) {
    const { ctx } = this;
    if (this.hoverX === null || !this.points.length) return;
    let best = null;
    for (const p of this.points) {
      if (p.v === null) continue;
      const d = Math.abs(x(p.t) - this.hoverX);
      if (!best || d < best.d) best = { p, d };
    }
    if (!best || best.d > 24) return;
    const px = x(best.p.t);
    const py = y(best.p.v);
    ctx.strokeStyle = color('--muted');
    ctx.lineWidth = 1;
    ctx.beginPath();
    ctx.moveTo(px, PAD.top);
    ctx.lineTo(px, this.height - PAD.bottom);
    ctx.stroke();
    ctx.beginPath();
    ctx.arc(px, py, 5, 0, Math.PI * 2);
    ctx.fillStyle = color('--text');
    ctx.fill();

    const text = `${Math.max(0, Math.round((now - best.p.t) / 1000))} วิที่แล้ว · ${fmtDeg(best.p.v)}`;
    ctx.font = `500 13px ${family}`;
    const tw = ctx.measureText(text).width + 16;
    const bx = Math.min(w - PAD.right - tw, Math.max(PAD.left, px - tw / 2));
    ctx.fillStyle = color('--text');
    ctx.beginPath();
    ctx.roundRect(bx, PAD.top, tw, 26, 6);
    ctx.fill();
    ctx.fillStyle = color('--card');
    ctx.textAlign = 'left';
    ctx.fillText(text, bx + 8, PAD.top + 18);
  }
}

const axisLabel = sec => (sec >= 3600 ? `${sec / 3600} ชม.` : `${sec / 60} นาที`);

/** ขอบบนของแกนที่อ่านง่าย: 1, 5, 10, 30 นาที แล้วปัดขึ้นเป็นชั่วโมงเต็ม */
export const niceMaxSeconds = sec => {
  for (const minutes of [1, 5, 10, 30, 60]) {
    if (sec <= minutes * 60) return minutes * 60;
  }
  return Math.ceil(sec / 3600) * 3600;
};

const dayDetail = (d, isToday) => {
  const name = isToday ? 'วันนี้' : dayFull(d.date);
  if (d.good + d.slouch === 0) return `${name}: ยังไม่มีข้อมูล`;
  return `${name}: นั่งตรง ${fmtDuration(d.good)} · หลังค่อม ${fmtDuration(d.slouch)} · เตือน ${d.alerts} ครั้ง`;
};

/** วาดกราฟแท่งซ้อน 7 วัน แตะแท่งเพื่อดูรายละเอียด และมีตารางสำหรับอ่านค่าทั้งหมด */
export const renderWeekly = (root, days) => {
  const { bars, detail, axisTop, tableBody } = root;
  const today = days[days.length - 1]?.date;
  const max = niceMaxSeconds(Math.max(...days.map(d => d.good + d.slouch), 60));
  axisTop.textContent = `เส้นบนสุด = ${axisLabel(max)}`;

  const selected = bars.dataset.selected && days.some(d => d.date === bars.dataset.selected)
    ? bars.dataset.selected
    : today;
  const focusedDate = bars.contains(document.activeElement) ? document.activeElement.dataset.date : null;

  bars.replaceChildren(...days.map(d => {
    const total = d.good + d.slouch;
    const pct = goodPercent(d.good, d.slouch);
    const btn = document.createElement('button');
    btn.type = 'button';
    btn.className = 'bar';
    btn.dataset.date = d.date;
    btn.setAttribute('aria-pressed', String(d.date === selected));
    btn.setAttribute('aria-label', dayDetail(d, d.date === today));

    const value = document.createElement('span');
    value.className = 'bar-value';
    value.textContent = pct === null ? '–' : `${pct}%`;

    const track = document.createElement('span');
    track.className = 'bar-track';
    if (total > 0) {
      const slouch = document.createElement('span');
      slouch.className = 'bar-seg bar-seg-slouch';
      slouch.style.height = `${(d.slouch / max) * 100}%`;
      const good = document.createElement('span');
      good.className = 'bar-seg bar-seg-good';
      good.style.height = `${(d.good / max) * 100}%`;
      if (d.slouch > 0) track.append(slouch);
      if (d.good > 0) track.append(good);
    }

    const label = document.createElement('span');
    label.className = 'bar-day';
    label.textContent = d.date === today ? 'วันนี้' : dayShort(d.date);

    btn.append(value, track, label);
    btn.addEventListener('click', () => {
      bars.dataset.selected = d.date;
      bars.querySelectorAll('.bar').forEach(b => b.setAttribute('aria-pressed', String(b === btn)));
      detail.textContent = dayDetail(d, d.date === today);
    });
    return btn;
  }));

  // วาดแท่งใหม่แล้วโฟกัสคีย์บอร์ดต้องอยู่ที่แท่งเดิม
  if (focusedDate) bars.querySelector(`[data-date="${focusedDate}"]`)?.focus();

  const chosen = days.find(d => d.date === selected);
  detail.textContent = chosen ? dayDetail(chosen, chosen.date === today) : '';

  tableBody.replaceChildren(...[...days].reverse().map(d => {
    const tr = document.createElement('tr');
    const pct = goodPercent(d.good, d.slouch);
    const cells = [
      d.date === today ? 'วันนี้' : dayFull(d.date),
      d.good + d.slouch ? fmtDuration(d.good) : '–',
      d.good + d.slouch ? fmtDuration(d.slouch) : '–',
      pct === null ? '–' : `${pct}%`,
      String(d.alerts),
    ];
    cells.forEach(text => {
      const td = document.createElement('td');
      td.textContent = text;
      tr.append(td);
    });
    return tr;
  }));
};
