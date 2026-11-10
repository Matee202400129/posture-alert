// ตัวควบคุมหน้าเว็บ: รับ packet จากอุปกรณ์จริงหรือตัวจำลอง แล้วอัปเดตทุกหน้าจอจากข้อมูลชุดเดียวกัน
import { parse, battPercent, effectiveThreshold, releaseThreshold, STATE, CMD } from './protocol.js';
import { BleLink, BLUETOOTH_OFF, bleErrorMessage, checkSupport } from './ble.js';
import { WIFI_ERROR, WifiLink, isDeviceHosted } from './wifi.js';
import { NativeLink, isNativeApp, nativeErrorMessage } from './native.js';
import { Simulator } from './simulator.js';
import { HistoryStore, demoDays } from './history.js';
import { createBackFigure } from './figure.js';
import { LiveChart, renderWeekly } from './charts.js';
import { fmtClock, fmtDeg, fmtDuration, goodPercent } from './util.js';

const $ = id => document.getElementById(id);

const PACKET_MS = 500;
const STALE_MS = 3000;
const REPLY_TIMEOUT_MS = 4000;
const FLUSH_MS = 10000;
const WEEK_REFRESH_MS = 5000;
const VIEWS = ['live', 'stats', 'settings', 'help'];

const STATE_INFO = {
  [STATE.OK]: { label: 'นั่งตรง', tone: 'ok', icon: 'i-ok', hint: () => 'ท่านั่งดีมาก รักษาไว้แบบนี้' },
  [STATE.SLOUCH]: {
    label: 'หลังค่อม', tone: 'bad', icon: 'i-warn',
    hint: p => (p.alarm
      ? `ยืดหลังขึ้น ค่าต้องลดลงต่ำกว่า ${releaseThreshold(p)}° จึงจะหยุดเตือน`
      : `ยืดหลังขึ้นภายใน ${p.delay} วินาที อุปกรณ์จะได้ไม่สั่น`),
  },
  [STATE.MOVING]: { label: 'กำลังขยับ', tone: 'idle', icon: 'i-move', hint: () => 'รอให้นิ่งก่อน อุปกรณ์จะกลับมาวัดต่อเอง' },
  [STATE.LYING]: { label: 'นอน / ก้มมาก', tone: 'idle', icon: 'i-bed', hint: () => 'เซนเซอร์เอียงเกิน 60° อุปกรณ์จึงหยุดเตือนชั่วคราว' },
  [STATE.SNOOZE]: { label: 'พักเตือน', tone: 'idle', icon: 'i-snooze', hint: p => `จะกลับมาเตือนในอีก ${fmtClock(p.snooze)} นาที` },
  [STATE.SENSOR]: { label: 'เซนเซอร์มีปัญหา', tone: 'warn', icon: 'i-warn', hint: () => 'เซนเซอร์ตัวบนไม่ตอบสนอง ตรวจสายให้แน่น แล้วอุปกรณ์จะกลับมาทำงานเอง' },
};
const UNKNOWN_STATE = { label: 'ไม่ทราบสถานะ', tone: 'idle', icon: 'i-warn', hint: () => 'เฟิร์มแวร์ส่งสถานะที่แอปไม่รู้จัก' };

const LINK_TEXT = {
  demo: { chip: 'ข้อมูลจำลอง', title: 'โหมดตัวอย่าง', desc: 'ตัวเลขเป็นข้อมูลจำลอง ไม่ได้มาจากอุปกรณ์จริง', btn: 'เชื่อมต่ออุปกรณ์' },
  connecting: { chip: 'กำลังเชื่อมต่อ', title: 'กำลังเชื่อมต่อ…', desc: 'เลือก PostureAlert ในหน้าต่างของเบราว์เซอร์', btn: 'กำลังเชื่อมต่อ…' },
  connected: { chip: 'เชื่อมต่อแล้ว', title: 'เชื่อมต่อ PostureAlert แล้ว', desc: 'กำลังแสดงข้อมูลจริงจากอุปกรณ์', btn: 'ตัดการเชื่อมต่อ' },
  reconnecting: { chip: 'สัญญาณหลุด', title: 'สัญญาณหลุด กำลังเชื่อมต่อใหม่', desc: '', btn: 'หยุดเชื่อมต่อ' },
  stale: { chip: 'ไม่มีข้อมูลใหม่', title: 'เชื่อมต่ออยู่ แต่ไม่ได้รับข้อมูลใหม่', desc: 'ถ้าเพิ่งสลับแอปกลับมา รอสักครู่ ถ้ายังไม่มาให้ตัดการเชื่อมต่อแล้วลองใหม่', btn: 'ตัดการเชื่อมต่อ' },
};

// ---------- ค่าที่จำไว้ในเครื่อง ----------
const prefs = {
  get(key, fallback) {
    try {
      const v = localStorage.getItem(`pa.${key}`);
      return v === null ? fallback : v;
    } catch { return fallback; }
  },
  set(key, value) {
    try { localStorage.setItem(`pa.${key}`, value); } catch { /* โหมดส่วนตัว: ใช้ค่าเริ่มต้นในรอบถัดไป */ }
  },
};

// ---------- สถานะของแอป ----------
const app = {
  mode: 'demo',       // demo | ble: ข้อมูลที่แสดงมาจากไหน
  link: 'demo',       // demo | connecting | connected | reconnecting
  attempt: 0,
  pkt: null,
  lastAt: 0,
  prevAlarm: false,
  view: 'live',
  pending: { thr: null, delay: null },
  dragging: { thr: false, delay: false },
};

const sim = new Simulator();
const history = new HistoryStore();
const figureLive = createBackFigure($('figureLive'));
const figurePresent = createBackFigure($('presentFigure'));
const figureW2 = createBackFigure($('wizardFigure2'));
const figureW3 = createBackFigure($('wizardFigure3'));
const chart = new LiveChart($('liveChart'));

// หน้าเว็บที่โหลดจากตัวบอร์ดคุยผ่าน Wi-Fi ส่วนที่อื่นใช้ Bluetooth (ค่า mode 'ble' หมายถึงข้อมูลจริงจากอุปกรณ์ทั้งสองแบบ)
const overWifi = isDeviceHosted();
// ในแอป Android บริการเบื้องหลังของแอปถือการเชื่อมต่อไว้ จึงเตือนได้แม้ปิดจอ
const native = isNativeApp();
if (native) document.body.dataset.native = '';
const linkHandlers = {
  onStatus(status, info) {
    handleLinkStatus(status, info);
  },
  onPacket(dv) {
    if (app.mode !== 'ble') enterBleMode();
    handlePacket(dv);
  },
};
const link = native ? new NativeLink(linkHandlers) : overWifi ? new WifiLink(linkHandlers) : new BleLink(linkHandlers);

// ---------- โหมดตัวอย่าง ----------
let demoTimer = null;

const startDemo = () => {
  if (demoTimer !== null) return;
  demoTimer = setInterval(() => {
    sim.tick(PACKET_MS / 1000);
    handlePacket(sim.packet());
  }, PACKET_MS);
  handlePacket(sim.packet());
};

const stopDemo = () => {
  clearInterval(demoTimer);
  demoTimer = null;
};

const enterBleMode = () => {
  stopDemo();
  app.mode = 'ble';
  app.pkt = null;
  app.prevAlarm = false;
  chart.clear();
  document.body.dataset.mode = 'ble';
  refreshWeekly();
};

const enterDemoMode = () => {
  app.mode = 'demo';
  app.link = 'demo';
  app.pkt = null;
  app.prevAlarm = false;
  chart.clear();
  document.body.dataset.mode = 'demo';
  history.flush();
  startDemo();
  renderLink();
  refreshWeekly();
};

// ---------- การเชื่อมต่อ ----------
const handleLinkStatus = (status, info = {}) => {
  if (status === 'connected') {
    if (app.mode !== 'ble') enterBleMode();
    app.link = 'connected';
    hideError();
  } else if (status === 'connecting') {
    app.link = 'connecting';
  } else if (status === 'reconnecting') {
    app.link = 'reconnecting';
    app.attempt = info.attempt || 1;
    history.flush();
  } else if (status === 'idle') {
    if (app.mode === 'ble') {
      enterDemoMode();
      return;
    }
    app.link = 'demo';
  }
  renderLink();
  // วาดใหม่ทันที: สัญญาณหลุดแล้วหน้าจอต้องไม่ค้างสีของสถานะเก่า
  render();
};

const isBluetoothOff = async () => {
  try {
    return (await navigator.bluetooth.getAvailability?.()) === false;
  } catch {
    return false;
  }
};

const connectDevice = async () => {
  hideError();
  const problem = overWifi || native ? null : checkSupport();
  if (problem) {
    showError(problem);
    return;
  }
  try {
    app.link = 'connecting';
    renderLink();
    // ห้าม await อะไรก่อนบรรทัดนี้: requestDevice ต้องเกิดจากการกดปุ่มโดยตรง
    await link.connect();
  } catch (err) {
    app.link = 'demo';
    renderLink();
    if (overWifi) {
      showError(WIFI_ERROR);
      return;
    }
    const message = native ? nativeErrorMessage(err) : bleErrorMessage(err);
    if (message) showError(err.name === 'NotFoundError' && await isBluetoothOff() ? BLUETOOTH_OFF : message);
  }
};

$('linkBtn').addEventListener('click', () => {
  if (app.link === 'demo') connectDevice();
  else if (app.link !== 'connecting') link.disconnect();
});
$('wizardConnect').addEventListener('click', connectDevice);
$('errorClose').addEventListener('click', () => hideError());

const showError = ({ title, fix }) => {
  $('errorTitle').textContent = title;
  $('errorFix').textContent = fix;
  $('errorPanel').hidden = false;
  if (wizard.open) toast(`${title}: ${fix}`, 7000);
};
const hideError = () => { $('errorPanel').hidden = true; };

const isStale = () => app.mode === 'ble' && (app.link !== 'connected' || performance.now() - app.lastAt > STALE_MS);

const linkKey = () => (app.link === 'connected' && app.pkt && isStale() ? 'stale' : app.link);

const renderLink = () => {
  const key = linkKey();
  const info = LINK_TEXT[key];
  $('linkChip').textContent = info.chip;
  $('linkChip').dataset.link = key;
  const bar = $('linkBar');
  bar.dataset.link = key;
  $('linkTitle').textContent = info.title;
  if (key === 'reconnecting') {
    const hint = overWifi ? 'ตรวจว่ามือถือยังต่อ Wi-Fi ชื่อ PostureAlert' : 'ถ้าเครื่องปิดอยู่ให้กดปุ่มบนเครื่อง';
    $('linkDesc').textContent = `ลองครั้งที่ ${app.attempt} ค่าบนจอคือค่าล่าสุดก่อนหลุด ${hint}`;
  } else if (key === 'connecting' && overWifi) {
    $('linkDesc').textContent = 'กำลังอ่านข้อมูลจากอุปกรณ์ผ่าน Wi-Fi';
  } else {
    $('linkDesc').textContent = info.desc;
  }
  $('linkBtnText').textContent = info.btn;
  const btn = $('linkBtn');
  btn.disabled = key === 'connecting';
  btn.classList.toggle('btn-primary', key === 'demo' || key === 'connecting');
  btn.classList.toggle('btn-ghost', key !== 'demo' && key !== 'connecting');

  const usable = app.mode === 'demo' || app.link === 'connected';
  document.querySelectorAll('[data-control]').forEach(node => { node.disabled = !usable; });
  $('wizardConnect').hidden = app.mode !== 'demo';
  $('wizardDemoNote').hidden = app.mode !== 'demo';
  $('wizardDemoSlouch').hidden = app.mode !== 'demo';
};

// ---------- รับข้อมูล ----------
const handlePacket = dv => {
  const p = parse(dv);
  if (!p) return;
  const now = performance.now();
  app.pkt = p;
  app.lastAt = now;
  chart.push(now, p.state === STATE.SENSOR ? null : p.curve, effectiveThreshold(p));
  if (app.mode === 'ble') history.record(p);

  if (p.alarm && !app.prevAlarm) fireMobileAlert();
  app.prevAlarm = p.alarm;

  render();
};

const stateInfo = p => STATE_INFO[p?.state] || UNKNOWN_STATE;

const render = () => {
  const p = app.pkt;
  const stale = isStale();
  renderHero(p, stale);
  renderPresent(p, stale);
  renderFigure(p, stale);
  renderControls(p);
  renderSliders(p);
  renderWizardLive(p, stale);
  if (app.view === 'stats') renderStats(p);
  if (app.view === 'live') renderChart();
};

// วงแหวนบนหน้าหลักยาว 75 ส่วนจาก 100 (270°) สเกล 0–45° ค่าติดลบ (เอนไปหลัง) แสดงเป็น 0
const GAUGE_MAX = 45;
const gaugeRatio = deg => Math.min(1, Math.max(0, deg / GAUGE_MAX));
const setGauge = (value, thr) => {
  $('gaugeValue').setAttribute('stroke-dasharray', `${(75 * gaugeRatio(value)).toFixed(2)} 100`);
  const tick = $('gaugeThr');
  tick.setAttribute('visibility', thr == null ? 'hidden' : 'visible');
  if (thr != null) tick.setAttribute('transform', `rotate(${(135 + 270 * gaugeRatio(thr)).toFixed(1)} 100 100)`);
};

// ขีดสเกลทุก 5° ด้านในวงแหวน ขีดยาวที่ 0, 15, 30, 45 พร้อมป้าย 0° กับ 45° ที่ปลายสองข้าง
(() => {
  const NS = 'http://www.w3.org/2000/svg';
  const group = $('gaugeTicks');
  for (let d = 0; d <= GAUGE_MAX; d += 5) {
    const major = d % 15 === 0;
    const line = document.createElementNS(NS, 'line');
    line.setAttribute('x1', major ? 166 : 169);
    line.setAttribute('x2', 174);
    line.setAttribute('y1', 100);
    line.setAttribute('y2', 100);
    line.setAttribute('transform', `rotate(${135 + 270 * gaugeRatio(d)} 100 100)`);
    line.setAttribute('class', major ? 'tick tick-major' : 'tick');
    group.append(line);
  }
  for (const [d, anchor] of [[0, 'start'], [GAUGE_MAX, 'end']]) {
    const a = (135 + 270 * gaugeRatio(d)) * Math.PI / 180;
    const label = document.createElementNS(NS, 'text');
    label.setAttribute('x', (100 + 70 * Math.cos(a) + (anchor === 'start' ? 2 : -2)).toFixed(1));
    label.setAttribute('y', (100 + 70 * Math.sin(a) + 14).toFixed(1));
    label.setAttribute('text-anchor', anchor);
    label.setAttribute('class', 'tick-label');
    label.textContent = `${d}°`;
    group.append(label);
  }
})();

// เปลี่ยนสถานะเมื่อไหร่ ให้ป้ายสถานะเด้งเบา ๆ หนึ่งครั้ง
const setHeroTone = (hero, tone) => {
  if (hero.dataset.tone === tone) return;
  hero.dataset.tone = tone;
  const head = hero.querySelector('.hero-head');
  head.classList.remove('is-pop');
  void head.offsetWidth;
  head.classList.add('is-pop');
};

const renderHero = (p, stale) => {
  const hero = $('hero');
  if (!p) {
    hero.dataset.tone = 'idle';
    setText('heroState', app.mode === 'ble' ? 'กำลังรอข้อมูล' : 'กำลังเริ่มตัวจำลอง');
    setText('heroCurve', '–');
    setText('heroThr', 'เกณฑ์เตือน –');
    setText('heroHint', '');
    $('alarmBand').hidden = true;
    setGauge(0, null);
    return;
  }
  const info = stateInfo(p);
  setGauge(p.state === STATE.SENSOR ? 0 : p.curve, effectiveThreshold(p));
  setHeroTone(hero, stale ? 'idle' : info.tone);
  hero.classList.toggle('is-stale', stale);
  $('heroIcon').setAttribute('href', `#${info.icon}`);
  setText('heroState', stale ? `ค่าล่าสุด: ${info.label}` : info.label);
  setText('heroCurve', p.state === STATE.SENSOR ? '–' : fmtDeg(p.curve));
  setText('heroThr', `เกณฑ์เตือน ${effectiveThreshold(p)}°`);
  setText('heroHint', stale
    ? `ไม่ได้รับข้อมูลมา ${Math.round((performance.now() - app.lastAt) / 1000)} วินาที`
    : info.hint(p));
  $('alarmBand').hidden = !p.alarm || stale;
  $('sensorNote').hidden = p.twoSensors || p.state === STATE.SENSOR;
};

const renderPresent = (p, stale) => {
  if ($('present').hidden) return;
  const info = p ? stateInfo(p) : UNKNOWN_STATE;
  $('present').dataset.tone = !p || stale ? 'idle' : info.tone;
  $('presentIcon').setAttribute('href', `#${info.icon}`);
  setText('presentState', !p ? 'กำลังรอข้อมูล' : stale ? 'ไม่มีข้อมูลใหม่' : info.label);
  setText('presentCurve', !p || p.state === STATE.SENSOR ? '–' : fmtDeg(p.curve));
  $('presentAlarm').hidden = !p?.alarm || stale;
};

const renderFigure = (p, stale) => {
  const known = !!p && p.state !== STATE.SENSOR;
  const tone = !p || stale ? 'idle' : stateInfo(p).tone;
  const data = { upper: p?.upper ?? 0, lower: p?.lower ?? 0, tone, alarm: !!p?.alarm && !stale, known, twoSensors: p?.twoSensors ?? true };
  if (app.view === 'live') figureLive.set(data);
  if (!$('present').hidden) figurePresent.set(data);
  if (wizard.open) {
    figureW2.set(data);
    figureW3.set(data);
  }
};

const renderChart = () => {
  chart.draw();
  const s = chart.summary();
  setText('chartMax', s ? fmtDeg(s.max) : '–');
  setText('chartOver', s ? `${s.overSeconds} วินาที` : '–');
  $('liveChart').setAttribute('aria-label', s
    ? `กราฟความโค้งหลัง 60 วินาทีล่าสุด ค่าล่าสุด ${fmtDeg(s.last)} สูงสุด ${fmtDeg(s.max)} เกินเกณฑ์ ${s.overSeconds} วินาที`
    : 'กราฟความโค้งหลัง 60 วินาทีล่าสุด ยังไม่มีข้อมูล');
};

const renderControls = p => {
  const snoozing = (p?.snooze || 0) > 0;
  $('snoozeBtn').setAttribute('aria-pressed', String(snoozing));
  setText('snoozeText', snoozing ? `ยกเลิกพักเตือน (${fmtClock(p.snooze)})` : 'พักเตือน 30 นาที');
};

const renderStats = p => {
  const batt = p && p.battOk ? battPercent(p.battMv) : null;
  setText('statBatt', batt === null ? 'อ่านไม่ได้' : `${Math.round(batt)}%`);
  $('statBatt').classList.toggle('tile-value-sm', batt === null);
  $('statBattBar').style.width = `${batt ?? 0}%`;
  setText('statBattMv', batt === null ? '' : `${(p.battMv / 1000).toFixed(2)} โวลต์`);
  const pct = p ? goodPercent(p.good, p.slouch) : null;
  setText('statPct', pct === null ? '–' : `${pct}%`);
  setText('statGood', p ? fmtDuration(p.good) : '');
  setText('statSlouch', p ? fmtDuration(p.slouch) : '–');
  setText('statAlerts', p ? `${p.alerts}` : '–');
};

/** แก้ DOM เฉพาะเมื่อค่าเปลี่ยน จะได้ไม่รบกวน screen reader ทุก 0.5 วินาที */
const setText = (id, text) => {
  const node = $(id);
  if (node.textContent !== text) node.textContent = text;
};

// ---------- ประวัติ 7 วัน ----------
const weekRoot = { bars: $('weekBars'), detail: $('weekDetail'), axisTop: $('weekAxisTop'), tableBody: $('weekTable') };

const refreshWeekly = async () => {
  if (app.view !== 'stats') return;
  const mode = app.mode;
  let days;
  if (mode === 'demo') {
    const p = app.pkt;
    days = demoDays({ good: p?.good ?? 0, slouch: p?.slouch ?? 0, alerts: p?.alerts ?? 0 });
  } else {
    days = await history.getDays(7);
  }
  if (mode !== app.mode) return;
  renderWeekly(weekRoot, days);
  const good = days.reduce((a, d) => a + d.good, 0);
  const slouch = days.reduce((a, d) => a + d.slouch, 0);
  const pct = goodPercent(good, slouch);
  setText('weekSummary', pct === null
    ? 'ยังไม่มีประวัติ เชื่อมต่ออุปกรณ์แล้วแอปจะเริ่มสะสมให้'
    : `7 วันล่าสุดนั่งตรง ${pct}% ของเวลาที่วัดได้ หลังค่อมรวม ${fmtDuration(slouch)}`);
  setText('historyNote', mode === 'demo'
    ? 'ประวัติในโหมดตัวอย่างเป็นข้อมูลจำลอง ไม่ได้บันทึกลงเครื่อง'
    : history.available
      ? 'บันทึกไว้ในเครื่องนี้เท่านั้น สะสมเฉพาะช่วงที่เปิดเว็บเชื่อมต่อกับอุปกรณ์'
      : 'เบราว์เซอร์นี้ไม่อนุญาตให้บันทึกลงเครื่อง ประวัติจะหายเมื่อปิดหน้าเว็บ');
  $('clearHistoryBtn').hidden = mode === 'demo';
};

$('clearHistoryBtn').addEventListener('click', async () => {
  const yes = await confirmAction({
    title: 'ล้างประวัติในเครื่องนี้?',
    body: 'ประวัติรายวันทั้งหมดในมือถือเครื่องนี้จะหายไป และกู้คืนไม่ได้ ตัวเลขในอุปกรณ์ไม่เปลี่ยน',
    yes: 'ล้างประวัติ',
  });
  if (!yes) return;
  await history.clear();
  refreshWeekly();
  toast('ล้างประวัติแล้ว');
});

// ---------- คำสั่ง ----------
const COMMAND_DONE = {
  cal: 'บันทึกท่าตรงแล้ว',
  buzz: 'สั่งสั่นทดสอบ 2 ครั้งแล้ว',
  reset: 'ล้างสถิติในอุปกรณ์แล้ว ประวัติรายวันยังอยู่',
};

const sendCommand = async text => {
  if (app.mode === 'demo') {
    sim.command(text);
    return true;
  }
  try {
    await link.send(text);
    return true;
  } catch {
    toast('ส่งคำสั่งไม่สำเร็จ ลองอีกครั้ง');
    return false;
  }
};

const runCommand = async text => {
  if (await sendCommand(text)) {
    const done = COMMAND_DONE[text];
    if (done) toast(app.mode === 'demo' ? `จำลอง: ${done}` : done);
    if (app.mode === 'demo') handlePacket(sim.packet());
    return true;
  }
  return false;
};

const powerOff = async () => {
  const yes = await confirmAction({
    title: 'ปิดเครื่อง PostureAlert?',
    body: 'อุปกรณ์จะหยุดเตือน และเปิดใหม่ได้ด้วยปุ่มบนเครื่องเท่านั้น สถิติในอุปกรณ์จะถูกล้าง',
    yes: 'ปิดเครื่อง',
  });
  if (!yes) return;
  if (app.mode === 'demo') {
    sim.command(CMD.off);
    handlePacket(sim.packet());
    toast('จำลอง: ปิดเครื่องแล้ว เริ่มตัวเลขใหม่ทั้งหมด');
    return;
  }
  try {
    await link.powerOff();
    link.disconnect();
    toast('ปิดเครื่องแล้ว กดปุ่มบนเครื่องเมื่อต้องการเปิดอีกครั้ง', 5000);
  } catch {
    toast('ส่งคำสั่งปิดเครื่องไม่สำเร็จ ลองอีกครั้ง');
  }
};

const resetStats = async () => {
  const yes = await confirmAction({
    title: 'ล้างสถิติในอุปกรณ์?',
    body: 'เวลานั่งตรง เวลาหลังค่อม และจำนวนครั้งที่เตือนในอุปกรณ์จะเริ่มนับใหม่ ส่วนประวัติ 7 วันในมือถือยังอยู่',
    yes: 'ล้างสถิติ',
  });
  if (yes) runCommand(CMD.reset);
};

document.querySelectorAll('[data-action]').forEach(btn => {
  btn.addEventListener('click', () => {
    const action = btn.dataset.action;
    if (action === 'off') powerOff();
    else if (action === 'reset') resetStats();
    else if (action === 'snooze') {
      const wasOn = (app.pkt?.snooze || 0) > 0;
      runCommand(CMD.snooze).then(ok => {
        if (ok) toast(`${app.mode === 'demo' ? 'จำลอง: ' : ''}${wasOn ? 'ยกเลิกพักเตือนแล้ว' : 'พักเตือน 30 นาที'}`);
      });
    } else runCommand(CMD[action]);
  });
});

// ---------- กล่องยืนยัน ----------
const confirmDialog = $('confirmDialog');

const confirmAction = ({ title, body, yes }) => new Promise(resolve => {
  $('confirmTitle').textContent = title;
  $('confirmBody').textContent = body;
  $('confirmYes').textContent = yes;
  const finish = value => {
    confirmDialog.removeEventListener('close', onClose);
    $('confirmYes').removeEventListener('click', onYes);
    $('confirmNo').removeEventListener('click', onNo);
    if (confirmDialog.open) confirmDialog.close();
    resolve(value);
  };
  const onClose = () => finish(false);
  const onYes = () => finish(true);
  const onNo = () => finish(false);
  confirmDialog.addEventListener('close', onClose);
  $('confirmYes').addEventListener('click', onYes);
  $('confirmNo').addEventListener('click', onNo);
  confirmDialog.showModal();
  $('confirmNo').focus();
});

// ---------- ตั้งค่าเกณฑ์ ----------
const SLIDERS = {
  thr: { slider: $('thrSlider'), value: $('thrValue'), reply: $('thrReply'), format: v => `${v}°`, cmd: CMD.thr },
  delay: { slider: $('delaySlider'), value: $('delayValue'), reply: $('delayReply'), format: v => `${v} วินาที`, cmd: CMD.delay },
};

const sliderNotes = { thr: null, delay: null };

const setReply = (node, text, state = '') => {
  if (node.textContent !== text) node.textContent = text;
  if (state) node.dataset.state = state;
  else delete node.dataset.state;
};

const renderSliders = p => {
  for (const [key, s] of Object.entries(SLIDERS)) {
    const pending = app.pending[key];
    if (!p) {
      setReply(s.reply, app.mode === 'ble' ? 'กำลังรอค่าจากอุปกรณ์' : '');
      continue;
    }
    const now = performance.now();
    const label = app.mode === 'demo' ? 'ตัวจำลองตอบกลับ' : 'อุปกรณ์ตอบกลับ';
    if (pending) {
      if (p[key] === pending.value) {
        app.pending[key] = null;
        sliderNotes[key] = { text: `${label}: ${s.format(p[key])} ตรงกับที่ตั้งไว้`, state: 'ok', until: now + 4000 };
      } else if (now - pending.at > REPLY_TIMEOUT_MS) {
        app.pending[key] = null;
        sliderNotes[key] = { text: `อุปกรณ์ไม่ได้เปลี่ยนค่า ยังเป็น ${s.format(p[key])} ลองอีกครั้ง`, state: 'error', until: now + 6000 };
      } else {
        setReply(s.reply, `กำลังส่ง ${s.format(pending.value)} ไปที่อุปกรณ์…`);
        continue;
      }
    }
    if (!app.dragging[key]) {
      s.slider.value = p[key];
      s.value.textContent = s.format(p[key]);
    }
    const note = sliderNotes[key];
    if (note && now < note.until) setReply(s.reply, note.text, note.state);
    else setReply(s.reply, `${label}: ${s.format(p[key])}`);
  }
};

for (const [key, s] of Object.entries(SLIDERS)) {
  s.slider.addEventListener('pointerdown', () => { app.dragging[key] = true; });
  s.slider.addEventListener('pointercancel', () => { app.dragging[key] = false; });
  s.slider.addEventListener('input', () => {
    app.dragging[key] = true;
    s.value.textContent = s.format(Number(s.slider.value));
  });
  // change เกิดตอนปล่อยนิ้ว จึงไม่ส่งคำสั่งรัว ๆ ระหว่างลาก
  s.slider.addEventListener('change', async () => {
    app.dragging[key] = false;
    const value = Number(s.slider.value);
    if (app.pkt && app.pkt[key] === value) return;
    sliderNotes[key] = null;
    app.pending[key] = { value, at: performance.now() };
    setReply(s.reply, `กำลังส่ง ${s.format(value)} ไปที่อุปกรณ์…`);
    const ok = await sendCommand(s.cmd(value));
    if (!ok) app.pending[key] = null;
  });
  // ปล่อยนิ้วโดยที่ค่าไม่เปลี่ยน จะไม่มี change ตามมา
  s.slider.addEventListener('pointerup', () => {
    setTimeout(() => { app.dragging[key] = false; }, 0);
  });
}

// ---------- แจ้งเตือนบนมือถือ ----------
const vibrateSupported = 'vibrate' in navigator;
const notifySupported = 'Notification' in window;
// แอป Android: เปิดทั้งสองอย่างไว้ก่อน เพราะเป็นเหตุผลหลักที่ใช้แอป
const nativePref = key => prefs.get(key, '1') === '1';
const syncNativeAlerts = () => { if (native) link.setAlerts(nativePref('vibrate'), nativePref('notify')); };

const fireMobileAlert = async () => {
  if (native) return; // บริการของแอปแจ้งเตือนเอง
  const wantsVibrate = prefs.get('vibrate', '0') === '1';
  const wantsNotify = prefs.get('notify', '0') === '1';
  if (wantsVibrate && vibrateSupported) navigator.vibrate([300, 150, 300]);
  if (!wantsNotify || !notifySupported || Notification.permission !== 'granted') return;
  const title = app.mode === 'demo' ? 'หลังค่อมแล้ว (ข้อมูลจำลอง)' : 'หลังค่อมแล้ว';
  const options = { body: 'ยืดหลังให้ตรงขึ้น', tag: 'posture-alarm', renotify: true, icon: 'icons/icon-192.png', badge: 'icons/icon-192.png' };
  // Chrome บน Android ใช้ new Notification() ไม่ได้ ต้องส่งผ่าน service worker
  try {
    const reg = await navigator.serviceWorker?.getRegistration();
    if (reg) await reg.showNotification(title, options);
    else new Notification(title, options);
  } catch (err) {
    console.warn('แสดงการแจ้งเตือนไม่ได้', err);
  }
};

const renderNotifySettings = () => {
  if (native) {
    for (const [id, note, key] of [['vibrateToggle', 'vibrateNote', 'vibrate'], ['notifyToggle', 'notifyNote', 'notify']]) {
      $(id).disabled = false;
      $(id).checked = nativePref(key);
      setText(note, 'ทำงานแม้ปิดจอหรือใช้แอปอื่นอยู่');
    }
    return;
  }
  const vib = $('vibrateToggle');
  vib.disabled = !vibrateSupported;
  vib.checked = vibrateSupported && prefs.get('vibrate', '0') === '1';
  setText('vibrateNote', vibrateSupported ? '' : 'เครื่องหรือเบราว์เซอร์นี้สั่นจากเว็บไม่ได้ เช่น iPhone');

  const notify = $('notifyToggle');
  if (!notifySupported) {
    notify.disabled = true;
    notify.checked = false;
    setText('notifyNote', 'เบราว์เซอร์นี้ไม่รองรับการแจ้งเตือน');
  } else if (Notification.permission === 'denied') {
    notify.disabled = true;
    notify.checked = false;
    setText('notifyNote', 'ถูกปิดสิทธิ์ไว้ เปิดได้ที่การตั้งค่าเว็บไซต์ของเบราว์เซอร์');
  } else {
    notify.disabled = false;
    notify.checked = Notification.permission === 'granted' && prefs.get('notify', '0') === '1';
    setText('notifyNote', '');
  }
};

$('vibrateToggle').addEventListener('change', e => {
  prefs.set('vibrate', e.target.checked ? '1' : '0');
  if (native) { syncNativeAlerts(); return; }
  if (e.target.checked) navigator.vibrate?.(200);
});

$('notifyToggle').addEventListener('change', async e => {
  if (native) {
    prefs.set('notify', e.target.checked ? '1' : '0');
    syncNativeAlerts();
    return;
  }
  if (!e.target.checked) {
    prefs.set('notify', '0');
    return;
  }
  const result = await Notification.requestPermission();
  prefs.set('notify', result === 'granted' ? '1' : '0');
  renderNotifySettings();
  if (result === 'granted') toast('เปิดการแจ้งเตือนแล้ว');
});

// ---------- ธีม ----------
const applyTheme = choice => {
  if (choice === 'light' || choice === 'dark') document.documentElement.dataset.theme = choice;
  else delete document.documentElement.dataset.theme;
  const bg = getComputedStyle(document.documentElement).getPropertyValue('--bg').trim();
  document.querySelector('meta[name="theme-color"]').setAttribute('content', bg);
  chart.draw();
};

$('themeSelect').value = prefs.get('theme', 'auto');
$('themeSelect').addEventListener('change', e => {
  prefs.set('theme', e.target.value);
  applyTheme(e.target.value);
});
window.matchMedia('(prefers-color-scheme: dark)').addEventListener('change', () => applyTheme(prefs.get('theme', 'auto')));
applyTheme(prefs.get('theme', 'auto'));

// ---------- สลับหน้า ----------
const showView = () => {
  const hash = location.hash.replace('#', '');
  const view = VIEWS.includes(hash) ? hash : 'live';
  const changed = view !== app.view;
  app.view = view;
  for (const name of VIEWS) $(`view-${name}`).hidden = name !== view;
  document.querySelectorAll('[data-tab]').forEach(a => {
    if (a.dataset.tab === view) a.setAttribute('aria-current', 'page');
    else a.removeAttribute('aria-current');
  });
  if (changed) window.scrollTo(0, 0);
  if (view === 'live') chart.resize();
  if (view === 'stats') refreshWeekly();
  if (view === 'settings') renderNotifySettings();
  render();
};
window.addEventListener('hashchange', showView);

// ---------- โหมดตัวอย่าง: เลือกสถานการณ์ ----------
$('scenario').addEventListener('change', e => sim.setScenario(e.target.value));

// ---------- โหมดนำเสนอ ----------
const present = $('present');
let wakeLock = null;

const openPresent = async () => {
  present.hidden = false;
  render();
  $('presentClose').focus();
  try { await present.requestFullscreen?.(); } catch { /* จอเต็มไม่ได้ก็ยังแสดงเต็มหน้าต่าง */ }
  try { wakeLock = await navigator.wakeLock?.request('screen'); } catch { /* ไม่รองรับก็ไม่เป็นไร */ }
};

const closePresent = () => {
  if (present.hidden) return;
  present.hidden = true;
  if (document.fullscreenElement) document.exitFullscreen?.().catch(() => {});
  wakeLock?.release?.().catch(() => {});
  wakeLock = null;
  $('presentBtn').focus();
};

$('presentBtn').addEventListener('click', openPresent);
$('presentClose').addEventListener('click', closePresent);
document.addEventListener('fullscreenchange', () => {
  if (!document.fullscreenElement) closePresent();
});
document.addEventListener('keydown', e => {
  if (e.key === 'Escape') closePresent();
});

// ---------- ตัวช่วยตั้งค่า ----------
const wizard = $('wizard');
const WIZARD_TITLES = ['ติดเซนเซอร์ที่หลัง', 'บันทึกท่าตรง', 'ลองค่อมให้ดู'];
const wiz = { step: 1, scenarioBefore: 'auto', sawSlouch: false };

const setWizardStep = step => {
  wiz.step = step;
  wizard.querySelectorAll('[data-step]').forEach(node => { node.hidden = Number(node.dataset.step) !== step; });
  wizard.querySelectorAll('.wizard-dots span').forEach((dot, i) => dot.classList.toggle('is-on', i < step));
  setText('wizardStep', `ขั้นที่ ${step} จาก 3`);
  setText('wizardTitle', WIZARD_TITLES[step - 1]);
  $('wizardBack').hidden = step === 1;
  setText('wizardNext', step === 3 ? 'เสร็จสิ้น' : 'ถัดไป');
  if (step === 2 && app.mode === 'demo') sim.setScenario('upright');
  // ย้ายโฟกัสมาที่หัวข้อ ให้ screen reader อ่านขั้นใหม่ และไม่มีกรอบโฟกัสไปอยู่ที่ปุ่ม "ข้าม"
  $('wizardTitle').focus();
  wizard.scrollTop = 0;
  render();
};

const openWizard = () => {
  wiz.scenarioBefore = $('scenario').value;
  wiz.sawSlouch = false;
  $('wizardCalDone').hidden = true;
  $('wizardTryDone').hidden = true;
  wizard.showModal();
  setWizardStep(1);
};

const renderWizardLive = (p, stale) => {
  if (!wizard.open || !p) return;
  setText('wizardCurve', p.state === STATE.SENSOR ? '–' : fmtDeg(p.curve));
  setText('wizardState', stale ? 'ไม่มีข้อมูลใหม่' : stateInfo(p).label);
  if (wiz.step === 3 && p.state === STATE.SLOUCH && !wiz.sawSlouch) {
    wiz.sawSlouch = true;
    $('wizardTryDone').hidden = false;
  }
};

wizard.addEventListener('close', () => {
  prefs.set('wizardSeen', '1');
  sim.setScenario(wiz.scenarioBefore);
});
$('wizardSkip').addEventListener('click', () => wizard.close());
$('wizardBack').addEventListener('click', () => setWizardStep(wiz.step - 1));
$('wizardNext').addEventListener('click', () => {
  if (wiz.step === 3) wizard.close();
  else setWizardStep(wiz.step + 1);
});
$('wizardCal').addEventListener('click', async () => {
  if (await sendCommand(CMD.cal)) $('wizardCalDone').hidden = false;
});
$('wizardDemoSlouch').addEventListener('click', () => sim.setScenario('slouch'));
$('wizardOpen').addEventListener('click', openWizard);

// ---------- ติดตั้งแอป ----------
let installEvent = null;
window.addEventListener('beforeinstallprompt', e => {
  e.preventDefault();
  installEvent = e;
  $('installBtn').hidden = false;
});
$('installBtn').addEventListener('click', async () => {
  if (!installEvent) return;
  installEvent.prompt();
  await installEvent.userChoice;
  installEvent = null;
  $('installBtn').hidden = true;
});
window.addEventListener('appinstalled', () => { $('installBtn').hidden = true; });

// ---------- ข้อความสั้น ----------
let toastTimer = null;
const toast = (text, ms = 3000) => {
  const node = $('toast');
  node.textContent = text;
  node.hidden = false;
  // ให้ลอยเหนือ dialog ด้วย: ย้ายเข้าไปอยู่ใน dialog ที่เปิดอยู่
  const host = wizard.open ? wizard : confirmDialog.open ? confirmDialog : document.body;
  if (node.parentElement !== host) host.append(node);
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => {
    node.hidden = true;
    document.body.append(node);
  }, ms);
};

// ---------- งานตามรอบเวลา ----------
setInterval(() => {
  if (app.mode === 'ble') {
    renderLink();
    render();
  }
}, 1000);
setInterval(() => { if (app.mode === 'ble') history.flush(); }, FLUSH_MS);
setInterval(refreshWeekly, WEEK_REFRESH_MS);

document.addEventListener('visibilitychange', () => {
  if (document.visibilityState === 'hidden') history.flush();
  else link.retryNow();
});
window.addEventListener('pagehide', () => history.flush());

// ---------- เริ่มทำงาน ----------
if (!native && 'serviceWorker' in navigator && window.isSecureContext) {
  navigator.serviceWorker.register('sw.js').catch(err => console.warn('ลงทะเบียน service worker ไม่สำเร็จ', err));
}

document.body.dataset.mode = 'demo';
renderLink();
startDemo();
showView();
renderNotifySettings();
if (prefs.get('wizardSeen', '0') !== '1') openWizard();
// เปิดหน้าเว็บจากตัวบอร์ดได้แปลว่าต่อ Wi-Fi อยู่แล้ว จึงเริ่มอ่านข้อมูลเลย
if (overWifi) connectDevice();
// เปิดแอปกลับมาตอนบริการยังเชื่อมต่ออยู่: รับข้อมูลต่อได้เลย
if (native) {
  syncNativeAlerts();
  link.attach();
}
