import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile, stat } from 'node:fs/promises';
import { counterDelta, demoDays } from '../../js/history.js';
import { dateKey, fmtClock, fmtDeg, fmtDuration, goodPercent, lastNDays } from '../../js/util.js';
import { Simulator } from '../../js/simulator.js';
import { parse, STATE } from '../../js/protocol.js';
import { bleErrorMessage, checkSupport } from '../../js/ble.js';
import { niceMaxSeconds } from '../../js/charts.js';

const c = (good, slouch, alerts) => ({ good, slouch, alerts });

test('counterDelta นับส่วนต่างเมื่อตัวนับเพิ่มขึ้น', () => {
  assert.deepEqual(counterDelta(c(100, 20, 2), c(130, 25, 3)), c(30, 5, 1));
});

test('counterDelta ครั้งแรกสุดนับค่าปัจจุบันทั้งหมด', () => {
  assert.deepEqual(counterDelta(null, c(50, 10, 1)), c(50, 10, 1));
});

test('counterDelta เมื่อเครื่องเปิดใหม่ (ตัวนับลดลง) ใช้ค่าใหม่ทั้งหมด ไม่ติดลบ', () => {
  assert.deepEqual(counterDelta(c(500, 90, 7), c(12, 3, 0)), c(12, 3, 0));
});

test('counterDelta รับตัวนับที่ลดลงแยกช่องกันได้', () => {
  assert.deepEqual(counterDelta(c(500, 2, 7), c(510, 3, 0)), c(10, 1, 0));
});

test('dateKey ใช้วันตามเวลาเครื่อง ไม่ใช่ UTC', () => {
  assert.equal(dateKey(new Date(2026, 10, 5, 0, 30)), '2026-11-05');
  assert.equal(dateKey(new Date(2026, 0, 9, 23, 59)), '2026-01-09');
});

test('lastNDays ข้ามเดือนได้ และวันสุดท้ายคือวันนี้', () => {
  assert.deepEqual(lastNDays(3, new Date(2026, 2, 1, 12)), ['2026-02-27', '2026-02-28', '2026-03-01']);
});

test('fmtDeg ใช้เครื่องหมายลบจริง และไม่แสดง -0.0', () => {
  assert.equal(fmtDeg(18.4), '18.4°');
  assert.equal(fmtDeg(-3.5), '−3.5°');
  assert.equal(fmtDeg(-0.04), '0.0°');
  assert.equal(fmtDeg(null), '–');
});

test('fmtDuration และ fmtClock อ่านง่าย', () => {
  assert.equal(fmtDuration(45), '45 วินาที');
  assert.equal(fmtDuration(720), '12 นาที');
  assert.equal(fmtDuration(3900), '1 ชม. 5 นาที');
  assert.equal(fmtDuration(7200), '2 ชม.');
  assert.equal(fmtClock(1745), '29:05');
});

test('goodPercent ไม่หารด้วยศูนย์', () => {
  assert.equal(goodPercent(0, 0), null);
  assert.equal(goodPercent(75, 25), 75);
});

test('niceMaxSeconds ให้ขอบบนของแกนที่อ่านง่าย และไม่ต่ำกว่าข้อมูล', () => {
  assert.equal(niceMaxSeconds(30), 60);
  assert.equal(niceMaxSeconds(200), 300);
  assert.equal(niceMaxSeconds(25 * 60), 30 * 60);
  assert.equal(niceMaxSeconds(3600), 3600);
  assert.equal(niceMaxSeconds(3 * 3600 + 1), 4 * 3600);
});

test('demoDays มี 7 วัน วันสุดท้ายใช้ค่าวันนี้ และเรียกซ้ำได้ค่าเดิม', () => {
  const now = new Date(2026, 10, 5, 12);
  const a = demoDays({ good: 1, slouch: 2, alerts: 3 }, 7, now);
  const b = demoDays({ good: 1, slouch: 2, alerts: 3 }, 7, now);
  assert.equal(a.length, 7);
  assert.deepEqual(a[6], { date: '2026-11-05', good: 1, slouch: 2, alerts: 3 });
  assert.deepEqual(a, b);
});

// ---------- ตัวจำลองต้องทำตามกติกาในเอกสาร ----------
const stableSim = () => new Simulator({ rng: () => 0.5 });
const run = (sim, seconds) => {
  for (let t = 0; t < seconds; t += 0.5) sim.tick(0.5);
  return parse(sim.packet());
};

test('ตัวจำลอง: นั่งตรงต้องไม่เตือน และสะสมเวลานั่งตรง', () => {
  const sim = stableSim();
  sim.setScenario('upright');
  const p = run(sim, 10);
  assert.equal(p.state, STATE.OK);
  assert.equal(p.alarm, false);
  assert.ok(p.good >= 9);
  assert.equal(p.slouch, 0);
});

test('ตัวจำลอง: curve = upper - lower เหมือนอุปกรณ์จริง', () => {
  const sim = stableSim();
  sim.setScenario('slouch');
  const p = run(sim, 5);
  assert.ok(Math.abs(p.curve - (p.upper - p.lower)) < 0.11);
});

test('ตัวจำลอง: ค่อมเกินเกณฑ์ค้างครบเวลาจึงเตือน และนับครั้งเดียว', () => {
  const sim = stableSim();
  sim.setScenario('slouch');
  const p = run(sim, 15);
  assert.equal(p.state, STATE.SLOUCH);
  assert.equal(p.alarm, true);
  assert.equal(p.alerts, 1);
});

test('ตัวจำลอง: เตือนค้างจนกว่าค่าจะต่ำกว่าเกณฑ์ − 5°', () => {
  const sim = stableSim();
  sim.setScenario('slouch');
  run(sim, 15);
  sim.setScenario('upright');
  let wasBetween = false;
  for (let t = 0; t < 20; t += 0.5) {
    sim.tick(0.5);
    const p = parse(sim.packet());
    if (p.curve <= p.thr && p.curve >= p.thr - 5) {
      wasBetween = true;
      assert.equal(p.alarm, true, `curve ${p.curve} ยังไม่ต่ำกว่า ${p.thr - 5} ต้องยังเตือนอยู่`);
    }
  }
  assert.ok(wasBetween);
  assert.equal(parse(sim.packet()).alarm, false);
});

test('ตัวจำลอง: เซนเซอร์เอียงเกิน 60° หยุดเตือน', () => {
  const sim = stableSim();
  sim.setScenario('lying');
  const p = run(sim, 15);
  assert.equal(p.state, STATE.LYING);
  assert.equal(p.alarm, false);
});

test('ตัวจำลอง: ลำดับสถานะตรงกับเฟิร์มแวร์ นอนมาก่อนพักเตือน และค่อมมาก่อนขยับ', () => {
  const lying = stableSim();
  lying.setScenario('lying');
  lying.command('snooze');
  assert.equal(run(lying, 15).state, STATE.LYING);

  const moving = stableSim();
  moving.setScenario('moving');
  assert.equal(run(moving, 15).state, STATE.MOVING);
  moving.command('thr=5');
  const p = run(moving, 1);
  assert.equal(p.state, STATE.SLOUCH, `curve ${p.curve} เกินเกณฑ์ 5° ต้องเป็นหลังค่อมแม้กำลังขยับ`);
});

test('ตัวจำลอง: เวลาขยับไม่นับเป็นนั่งตรง และ cal หยุดการเตือนทันที', () => {
  const moving = stableSim();
  moving.setScenario('moving');
  const p = run(moving, 10);
  assert.equal(p.slouch, 0);
  assert.ok(p.good < 2, `good = ${p.good}`);

  const sim = stableSim();
  sim.setScenario('slouch');
  assert.equal(run(sim, 15).alarm, true);
  sim.command('cal');
  assert.equal(parse(sim.packet()).alarm, false);
});

test('ตัวจำลอง: snooze เปิด/ปิดได้ และนับถอยหลัง', () => {
  const sim = stableSim();
  sim.setScenario('slouch');
  sim.command('snooze');
  let p = run(sim, 10);
  assert.equal(p.state, STATE.SNOOZE);
  assert.equal(p.alarm, false);
  assert.ok(p.snooze <= 1790 && p.snooze > 1780);
  sim.command('snooze');
  p = run(sim, 0.5);
  assert.equal(p.snooze, 0);
});

test('ตัวจำลอง: thr และ delay เปลี่ยนค่าที่ส่งกลับ และไม่รับค่านอกช่วง', () => {
  const sim = stableSim();
  sim.command('thr=22');
  sim.command('delay=9');
  let p = parse(sim.packet());
  assert.equal(p.thr, 22);
  assert.equal(p.delay, 9);
  sim.command('thr=99');
  sim.command('delay=0');
  p = parse(sim.packet());
  assert.equal(p.thr, 22);
  assert.equal(p.delay, 9);
});

test('ตัวจำลอง: เวลาค้างก่อนเตือนใช้ค่าที่ตั้งไว้', () => {
  const sim = stableSim();
  sim.command('delay=30');
  sim.setScenario('slouch');
  assert.equal(run(sim, 15).alarm, false);
  assert.equal(run(sim, 20).alarm, true);
});

test('ตัวจำลอง: cal ทำให้ท่าปัจจุบันเป็นศูนย์ / reset ล้างตัวนับ / off เริ่มใหม่แต่จำเกณฑ์', () => {
  const sim = stableSim();
  sim.setScenario('upright');
  run(sim, 10);
  sim.command('cal');
  let p = parse(sim.packet());
  assert.equal(p.upper, 0);
  assert.equal(p.lower, 0);
  sim.command('reset');
  p = parse(sim.packet());
  assert.deepEqual([p.good, p.slouch, p.alerts], [0, 0, 0]);
  sim.command('thr=20');
  run(sim, 5);
  sim.command('off');
  p = parse(sim.packet());
  assert.equal(p.good, 0);
  assert.equal(p.thr, 20);
});

// ---------- ข้อความผิดพลาด ----------
const err = (name, message = '') => Object.assign(new Error(message), { name });

test('ผู้ใช้กดยกเลิกหน้าต่างเลือกอุปกรณ์ ต้องไม่แสดงข้อผิดพลาด', () => {
  assert.equal(bleErrorMessage(err('NotFoundError', 'User cancelled the requestDevice() chooser.')), null);
});

test('ข้อผิดพลาดแต่ละแบบมีข้อความไทยที่บอกวิธีแก้', () => {
  const cases = [
    [err('NotFoundError', 'Bluetooth adapter not available.'), /เปิด Bluetooth/],
    [err('NotFoundError', 'No Services matching UUID found in Device.'), /ไม่ตรงกับ PostureAlert/],
    [err('NotFoundError', 'No devices found'), /ไม่เจออุปกรณ์/],
    [err('SecurityError'), /อนุญาต/],
    [err('NetworkError'), /ไม่สำเร็จ/],
    [err('TimeoutError'), /ไม่สำเร็จ/],
    [err('SomethingElse'), /ไม่สำเร็จ/],
  ];
  for (const [input, expected] of cases) {
    const m = bleErrorMessage(input);
    assert.match(m.title, expected);
    assert.ok(m.fix.length > 10);
  }
});

test('checkSupport แนะนำให้ถูกตามเบราว์เซอร์', () => {
  const iphone = { isSecureContext: true, navigator: { userAgent: 'iPhone OS 17', platform: 'iPhone', maxTouchPoints: 5 } };
  assert.match(checkSupport(iphone).title, /Bluefy/);
  assert.match(checkSupport(iphone).fix, /Bluefy/);
  const ipad = { isSecureContext: true, navigator: { userAgent: 'Macintosh', platform: 'MacIntel', maxTouchPoints: 5 } };
  assert.match(checkSupport(ipad).title, /Bluefy/);
  const firefox = { isSecureContext: true, navigator: { userAgent: 'Firefox', platform: 'Win32', maxTouchPoints: 0 } };
  assert.match(checkSupport(firefox).fix, /Chrome หรือ Edge/);
  const http = { isSecureContext: false, navigator: { userAgent: 'Chrome' } };
  assert.match(checkSupport(http).title, /HTTPS/);
  assert.equal(checkSupport({ isSecureContext: true, navigator: { bluetooth: {} } }), null);
});

// ---------- ไฟล์สำหรับใช้งานออฟไลน์ ----------
test('ไฟล์ทุกตัวที่ service worker เก็บไว้มีอยู่จริง และครอบคลุมทุกโมดูล', async () => {
  const root = new URL('../../', import.meta.url);
  const sw = await readFile(new URL('sw.js', root), 'utf8');
  const files = [...sw.match(/const FILES = \[([\s\S]*?)\];/)[1].matchAll(/'([^']+)'/g)].map(m => m[1]);
  assert.ok(files.length > 10);
  for (const f of files) {
    if (f === './') continue;
    assert.ok((await stat(new URL(f, root))).isFile(), f);
  }
  for (const module of ['app', 'ble', 'charts', 'figure', 'history', 'native', 'protocol', 'simulator', 'util', 'wifi']) {
    assert.ok(files.includes(`js/${module}.js`), `sw.js ต้องมี js/${module}.js`);
  }
  const css = await readFile(new URL('css/style.css', root), 'utf8');
  for (const m of css.matchAll(/url\(\.\.\/(fonts\/[^)]+)\)/g)) assert.ok(files.includes(m[1]), m[1]);
});

test('ทุก URL ในแอปเป็นแบบ relative เพื่อให้ทำงานใต้ /ชื่อ-repo/ บน GitHub Pages ได้', async () => {
  const root = new URL('../../', import.meta.url);
  const html = await readFile(new URL('index.html', root), 'utf8');
  for (const m of html.matchAll(/(?:href|src)="([^"#][^"]*)"/g)) assert.ok(!m[1].startsWith('/'), m[1]);
  const manifest = JSON.parse(await readFile(new URL('manifest.webmanifest', root), 'utf8'));
  assert.equal(manifest.start_url, './');
  assert.equal(manifest.scope, './');
  for (const icon of manifest.icons) {
    assert.ok(!icon.src.startsWith('/'), icon.src);
    assert.ok((await stat(new URL(icon.src, root))).isFile(), icon.src);
  }
});
