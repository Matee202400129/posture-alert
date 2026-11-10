import { test } from 'node:test';
import assert from 'node:assert/strict';
import { NativeLink, isNativeApp, nativeErrorMessage } from '../../js/native.js';
import { BLUETOOTH_OFF } from '../../js/ble.js';

// สะพานปลอมแทนแอป Android: จดว่าหน้าเว็บเรียกอะไร
const setup = () => {
  const calls = [];
  const bridge = {
    hello: () => calls.push('hello'),
    connect: () => calls.push('connect'),
    disconnect: () => calls.push('disconnect'),
    send: (id, text) => calls.push(`send ${id} ${text}`),
    powerOff: id => calls.push(`powerOff ${id}`),
    setAlerts: (v, n) => calls.push(`alerts ${v} ${n}`),
  };
  const host = {};
  const statuses = [];
  const packets = [];
  const link = new NativeLink({ onStatus: (s, info) => statuses.push([s, info.attempt]), onPacket: dv => packets.push(dv) }, { bridge, host });
  return { link, calls, host, statuses, packets };
};

test('รู้ว่าเปิดอยู่ในแอป Android จาก window.PostureNative', () => {
  assert.equal(isNativeApp({ PostureNative: {} }), true);
  assert.equal(isNativeApp({}), false);
});

test('connect สำเร็จเมื่อบริการบอกว่าเชื่อมต่อแล้ว', async () => {
  const { link, calls, host, statuses } = setup();
  const done = link.connect();
  assert.deepEqual(calls, ['connect']);
  host.__postureNative.onStatus('connecting');
  host.__postureNative.onStatus('connected');
  await done;
  assert.equal(link.connected, true);
  assert.deepEqual(statuses.map(s => s[0]), ['connecting', 'connected']);
});

test('connect ล้มเหลวพร้อมชื่อข้อผิดพลาดจากบริการ', async () => {
  const { link, host } = setup();
  const done = link.connect();
  host.__postureNative.onError('NotFoundError', 'no device');
  await assert.rejects(done, err => err.name === 'NotFoundError');
  assert.equal(link.connected, false);
});

test('ข้อผิดพลาดหลังเชื่อมต่อแล้ว แจ้งเป็นสถานะ idle', () => {
  const { host, statuses } = setup();
  host.__postureNative.onError('NetworkError', 'lost');
  assert.deepEqual(statuses.at(-1), ['idle', 0]);
});

test('แปลง packet base64 เป็น DataView 20 ไบต์', () => {
  const { host, packets } = setup();
  const bytes = new Uint8Array(20);
  bytes[0] = 1;
  bytes[16] = 15;
  host.__postureNative.onPacket(btoa(String.fromCharCode(...bytes)));
  assert.equal(packets[0].byteLength, 20);
  assert.equal(packets[0].getUint8(0), 1);
  assert.equal(packets[0].getUint8(16), 15);
});

test('send รอคำตอบจากบริการตามหมายเลขคำสั่ง', async () => {
  const { link, calls, host } = setup();
  const a = link.send('thr=20');
  const b = link.send('buzz');
  assert.deepEqual(calls, ['send 1 thr=20', 'send 2 buzz']);
  host.__postureNative.onReply(2, false, 'timeout');
  host.__postureNative.onReply(1, true, '');
  await a;
  await assert.rejects(b, err => err.name === 'NetworkError');
});

test('สถานะต่อใหม่ส่งจำนวนครั้งที่ลองไปด้วย', () => {
  const { host, statuses } = setup();
  host.__postureNative.onStatus('reconnecting', 3);
  assert.deepEqual(statuses.at(-1), ['reconnecting', 3]);
});

test('powerOff attach และ setAlerts เรียกบริการตรงตัว', async () => {
  const { link, calls, host } = setup();
  const off = link.powerOff();
  host.__postureNative.onReply(1, true, '');
  await off;
  link.attach();
  link.setAlerts(1, 0);
  assert.deepEqual(calls, ['powerOff 1', 'hello', 'alerts true false']);
});

test('ข้อความข้อผิดพลาดของแอป', () => {
  assert.equal(nativeErrorMessage({ name: 'BluetoothOff' }), BLUETOOTH_OFF);
  assert.match(nativeErrorMessage({ name: 'PermissionError' }).fix, /อุปกรณ์ที่อยู่ใกล้เคียง/);
  assert.match(nativeErrorMessage({ name: 'NotFoundError', message: 'no device' }).title, /ไม่เจอ/);
});
