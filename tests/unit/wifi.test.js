import { test } from 'node:test';
import assert from 'node:assert/strict';
import { WifiLink, isDeviceHosted } from '../../js/wifi.js';
import { encode, parse, STATE } from '../../js/protocol.js';

const wait = ms => new Promise(r => setTimeout(r, ms));
const until = async (check, ms = 800) => {
  const start = Date.now();
  while (!check()) {
    if (Date.now() - start > ms) throw new Error('หมดเวลารอเงื่อนไข');
    await wait(2);
  }
};

const sample = { state: STATE.SLOUCH, alarm: true, twoSensors: true, battOk: true, upper: 22, lower: 2, curve: 20, battMv: 3900, good: 10, slouch: 5, alerts: 1, thr: 15, delay: 3, snooze: 0 };
const packetBuffer = () => encode(sample).buffer;

const makeDevice = () => {
  const device = { online: true, commands: [], statusCalls: 0, rejectCommands: false, length: null, hang: false };
  device.fetchFn = async (path, options = {}) => {
    if (device.hang) {
      return new Promise((_, reject) => options.signal.addEventListener('abort', () => reject(Object.assign(new Error('aborted'), { name: 'AbortError' }))));
    }
    if (!device.online) throw new TypeError('Failed to fetch');
    if (path === 'status') {
      device.statusCalls += 1;
      const buffer = device.length === null ? packetBuffer() : new ArrayBuffer(device.length);
      return { ok: true, status: 200, arrayBuffer: async () => buffer };
    }
    assert.equal(options.method, 'POST');
    if (device.rejectCommands) return { ok: false, status: 503 };
    device.commands.push(decodeURIComponent(path.replace('cmd?c=', '')));
    return { ok: true, status: 200 };
  };
  return device;
};

const setup = (device = makeDevice(), gap = () => 0) => {
  const statuses = [];
  const packets = [];
  const link = new WifiLink({
    fetchFn: device.fetchFn,
    onStatus: s => statuses.push(s),
    onPacket: p => packets.push(parse(p)),
    pollMs: 5,
    timeoutMs: 30,
    commandGap: gap,
  });
  return { link, device, statuses, packets };
};

test('เชื่อมต่อแล้วอ่าน packet เดียวกับ Bluetooth ได้ทุกช่อง', async t => {
  const { link, statuses, packets } = setup();
  t.after(() => link.disconnect());
  await link.connect();
  assert.deepEqual(statuses, ['connecting', 'connected']);
  assert.deepEqual(packets[0], sample);
  assert.equal(link.connected, true);
});

test('อ่านซ้ำเป็นรอบ ๆ', async t => {
  const { link, packets } = setup();
  t.after(() => link.disconnect());
  await link.connect();
  await until(() => packets.length >= 4);
});

test('ติดต่ออุปกรณ์ไม่ได้ตั้งแต่แรก ต้องแจ้งข้อผิดพลาด และไม่อ่านต่อ', async () => {
  const device = makeDevice();
  device.online = false;
  const { link, statuses } = setup(device);
  await assert.rejects(link.connect());
  assert.equal(statuses.at(-1), 'idle');
  device.online = true;
  await wait(30);
  assert.equal(device.statusCalls, 0);
});

test('Wi-Fi หลุดแล้วบอกสถานะ และกลับมาอ่านต่อเองเมื่อกลับมา', async t => {
  const { link, device, statuses } = setup();
  t.after(() => link.disconnect());
  await link.connect();
  device.online = false;
  await until(() => statuses.at(-1) === 'reconnecting');
  assert.equal(link.connected, false);
  device.online = true;
  await until(() => statuses.at(-1) === 'connected');
  assert.equal(link.connected, true);
});

test('อุปกรณ์ไม่ตอบ ต้องหมดเวลา ไม่ค้าง', async t => {
  const { link, device, statuses } = setup();
  t.after(() => link.disconnect());
  await link.connect();
  device.hang = true;
  await until(() => statuses.at(-1) === 'reconnecting');
});

test('packet ขนาดผิดถือว่าอ่านไม่สำเร็จ', async () => {
  const device = makeDevice();
  device.length = 19;
  const { link } = setup(device);
  await assert.rejects(link.connect());
});

test('ตัดการเชื่อมต่อแล้วหยุดอ่านจริง', async () => {
  const { link, device, statuses } = setup();
  await link.connect();
  link.disconnect();
  const calls = device.statusCalls;
  await wait(30);
  assert.equal(device.statusCalls, calls);
  assert.equal(statuses.at(-1), 'idle');
});

test('คำสั่งเรียงตามลำดับ และเข้ารหัสตัวอักษรถูกต้อง', async t => {
  const { link, device } = setup();
  t.after(() => link.disconnect());
  await link.connect();
  await Promise.all(['cal', 'thr=20', 'delay=5'].map(c => link.send(c)));
  assert.deepEqual(device.commands, ['cal', 'thr=20', 'delay=5']);
});

test('เว้นช่วงระหว่างคำสั่งตามที่เฟิร์มแวร์ต้องการ', async t => {
  const { link, device } = setup(makeDevice(), () => 60);
  t.after(() => link.disconnect());
  await link.connect();
  await link.send('cal');
  link.send('buzz');
  await wait(20);
  assert.deepEqual(device.commands, ['cal']);
  await until(() => device.commands.length === 2);
});

test('อุปกรณ์ปฏิเสธคำสั่ง (ช่องไม่ว่าง) ต้องไม่บอกว่าสำเร็จ และคิวไม่ค้าง', async t => {
  const { link, device } = setup();
  t.after(() => link.disconnect());
  await link.connect();
  device.rejectCommands = true;
  await assert.rejects(link.send('cal'));
  device.rejectCommands = false;
  await link.send('buzz');
  assert.deepEqual(device.commands, ['buzz']);
});

test('ปิดเครื่องแล้วหยุดอ่าน / ส่งไม่สำเร็จยังอ่านต่อ', async () => {
  const { link, device } = setup();
  await link.connect();
  device.rejectCommands = true;
  await assert.rejects(link.powerOff());
  const before = device.statusCalls;
  await until(() => device.statusCalls > before);
  device.rejectCommands = false;
  await link.powerOff();
  assert.deepEqual(device.commands, ['off']);
  const calls = device.statusCalls;
  await wait(30);
  assert.ok(device.statusCalls <= calls + 1);
  link.disconnect();
});

test('แยกหน้าที่โหลดจากบอร์ดด้วย meta', () => {
  assert.equal(isDeviceHosted({ querySelector: () => ({}) }), true);
  assert.equal(isDeviceHosted({ querySelector: () => null }), false);
  assert.equal(isDeviceHosted(undefined), false);
});
