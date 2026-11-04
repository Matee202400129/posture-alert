import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parse, encode, battPercent, effectiveThreshold, releaseThreshold, CMD, STATE, PACKET_SIZE, SERVICE_UUID, STATUS_UUID, COMMAND_UUID } from '../../js/protocol.js';

test('เกณฑ์จริงตรงกับเฟิร์มแวร์: เซนเซอร์ตัวเดียวสูงกว่าค่าที่ตั้ง 5° และหยุดสั่นที่เกณฑ์ − 5°', () => {
  assert.equal(effectiveThreshold({ thr: 15, twoSensors: true }), 15);
  assert.equal(effectiveThreshold({ thr: 15, twoSensors: false }), 20);
  assert.equal(releaseThreshold({ thr: 15, twoSensors: true }), 10);
  assert.equal(releaseThreshold({ thr: 15, twoSensors: false }), 15);
});

test('ค่าว่างจากการอ่านครั้งแรก (เฟิร์มแวร์ยังไม่เคย setValue) ต้องไม่ทำให้แอปล้ม', () => {
  assert.equal(parse(new DataView(new ArrayBuffer(0))), null);
});

// ประกอบ packet ด้วยมือทีละไบต์ตามตารางในเอกสาร ไม่ใช้ encode() เพื่อให้ตรวจ parse() ได้อย่างอิสระ
const handmade = () => new DataView(new Uint8Array([
  0x01,             // 0  state = SLOUCH
  0b101,            // 1  flags: alarm + battOk
  0xB8, 0x00,       // 2  upper = 184 → 18.4
  0xE7, 0xFF,       // 4  lower = -25 → -2.5
  0xD1, 0x00,       // 6  curve = 209 → 20.9
  0x6A, 0x0F,       // 8  battMv = 3946
  0x34, 0x12,       // 10 good = 4660
  0x78, 0x01,       // 12 slouch = 376
  0x0C, 0x00,       // 14 alerts = 12
  0x12,             // 16 thr = 18
  0x05,             // 17 delay = 5
  0x08, 0x07,       // 18 snooze = 1800
]).buffer);

test('parse อ่านทุกช่องของ packet 20 ไบต์ถูกต้อง', () => {
  assert.deepEqual(parse(handmade()), {
    state: STATE.SLOUCH,
    alarm: true,
    twoSensors: false,
    battOk: true,
    upper: 18.4,
    lower: -2.5,
    curve: 20.9,
    battMv: 3946,
    good: 4660,
    slouch: 376,
    alerts: 12,
    thr: 18,
    delay: 5,
    snooze: 1800,
  });
});

test('parse แยกแต่ละบิตของ flags ได้', () => {
  const flags = bits => {
    const dv = new DataView(new ArrayBuffer(PACKET_SIZE));
    dv.setUint8(1, bits);
    const { alarm, twoSensors, battOk } = parse(dv);
    return [alarm, twoSensors, battOk];
  };
  assert.deepEqual(flags(0b000), [false, false, false]);
  assert.deepEqual(flags(0b001), [true, false, false]);
  assert.deepEqual(flags(0b010), [false, true, false]);
  assert.deepEqual(flags(0b100), [false, false, true]);
  assert.deepEqual(flags(0b111), [true, true, true]);
});

test('parse อ่านค่าสุดขอบของ int16 และ uint16 ได้', () => {
  const dv = new DataView(new ArrayBuffer(PACKET_SIZE));
  dv.setInt16(2, -32768, true);
  dv.setInt16(4, 32767, true);
  dv.setUint16(10, 65535, true);
  const p = parse(dv);
  assert.equal(p.upper, -3276.8);
  assert.equal(p.lower, 3276.7);
  assert.equal(p.good, 65535);
});

test('parse ไม่ล้มเมื่อ packet สั้นเกินไป', () => {
  assert.equal(parse(new DataView(new ArrayBuffer(19))), null);
  assert.equal(parse(null), null);
});

test('encode แล้ว parse ได้ค่าเดิม (ตัวจำลองใช้รูปแบบเดียวกับอุปกรณ์)', () => {
  const input = {
    state: STATE.SNOOZE, alarm: false, twoSensors: true, battOk: true,
    upper: -12.3, lower: 4.5, curve: -16.8, battMv: 4100, good: 10, slouch: 20, alerts: 3, thr: 15, delay: 3, snooze: 1799,
  };
  const dv = encode(input);
  assert.equal(dv.byteLength, 20);
  assert.deepEqual(parse(dv), input);
});

test('battPercent ตรงกับทุกจุดในตาราง', () => {
  const table = { 3300: 0, 3600: 10, 3700: 30, 3800: 50, 3900: 65, 4000: 80, 4100: 92, 4200: 100 };
  for (const [mv, pct] of Object.entries(table)) assert.equal(battPercent(Number(mv)), pct, `${mv} mV`);
});

test('battPercent คำนวณค่าระหว่างจุดแบบเส้นตรง', () => {
  assert.equal(battPercent(3450), 5);
  assert.equal(battPercent(3650), 20);
  assert.equal(battPercent(3850), 57.5);
  assert.equal(battPercent(4050), 86);
  assert.equal(battPercent(4150), 96);
});

test('battPercent จำกัดค่านอกช่วง และคืน null เมื่ออ่านไม่ได้', () => {
  assert.equal(battPercent(3000), 0);
  assert.equal(battPercent(4500), 100);
  assert.equal(battPercent(0), null);
});

test('คำสั่งข้อความตรงตามเอกสาร และปฏิเสธค่านอกช่วง', () => {
  assert.equal(CMD.cal, 'cal');
  assert.equal(CMD.snooze, 'snooze');
  assert.equal(CMD.buzz, 'buzz');
  assert.equal(CMD.reset, 'reset');
  assert.equal(CMD.off, 'off');
  assert.equal(CMD.thr(5), 'thr=5');
  assert.equal(CMD.thr(40), 'thr=40');
  assert.equal(CMD.delay(1), 'delay=1');
  assert.equal(CMD.delay(30), 'delay=30');
  assert.throws(() => CMD.thr(4), RangeError);
  assert.throws(() => CMD.thr(41), RangeError);
  assert.throws(() => CMD.delay(0), RangeError);
  assert.throws(() => CMD.delay(31), RangeError);
  assert.throws(() => CMD.thr(10.5), RangeError);
});

test('UUID ตรงกับเฟิร์มแวร์', () => {
  assert.equal(SERVICE_UUID, '6e1f0001-5b8a-4c2b-9d3e-7a1c2f4e8b10');
  assert.equal(STATUS_UUID, '6e1f0002-5b8a-4c2b-9d3e-7a1c2f4e8b10');
  assert.equal(COMMAND_UUID, '6e1f0003-5b8a-4c2b-9d3e-7a1c2f4e8b10');
});
