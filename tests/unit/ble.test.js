import { test } from 'node:test';
import assert from 'node:assert/strict';
import { BleLink, commandGapMs } from '../../js/ble.js';
import { COMMAND_UUID, DEVICE_NAME, SERVICE_UUID, STATUS_UUID } from '../../js/protocol.js';

const wait = ms => new Promise(r => setTimeout(r, ms));
const until = async (check, ms = 800) => {
  const start = Date.now();
  while (!check()) {
    if (Date.now() - start > ms) throw new Error('หมดเวลารอเงื่อนไข');
    await wait(2);
  }
};

class FakeTarget {
  constructor() { this.listeners = new Map(); }
  addEventListener(type, fn) {
    if (!this.listeners.has(type)) this.listeners.set(type, new Set());
    this.listeners.get(type).add(fn);
  }
  removeEventListener(type, fn) { this.listeners.get(type)?.delete(fn); }
  emit(type, event = {}) { for (const fn of [...(this.listeners.get(type) || [])]) fn({ target: this, ...event }); }
  count(type) { return this.listeners.get(type)?.size ?? 0; }
}

const makeDevice = () => {
  const device = new FakeTarget();
  device.writes = [];
  device.failConnects = 0;
  device.connectCalls = 0;
  device.chars = [];
  const makeChars = () => {
    const status = new FakeTarget();
    status.value = new DataView(new ArrayBuffer(20));
    status.startNotifications = async () => {};
    status.readValue = async () => status.value;
    const command = {
      writeValueWithResponse: async data => { device.writes.push({ text: new TextDecoder().decode(data), response: true }); },
      writeValueWithoutResponse: async data => { device.writes.push({ text: new TextDecoder().decode(data), response: false }); },
    };
    device.chars.push(status);
    return { status, command };
  };
  const server = {
    getPrimaryService: async uuid => {
      assert.equal(uuid, SERVICE_UUID);
      const { status, command } = makeChars();
      return {
        getCharacteristic: async id => {
          if (id === STATUS_UUID) return status;
          if (id === COMMAND_UUID) return command;
          throw new Error(`unknown characteristic ${id}`);
        },
      };
    },
  };
  device.gatt = {
    connected: false,
    connect: async () => {
      device.connectCalls += 1;
      if (device.failConnects > 0) {
        device.failConnects -= 1;
        throw Object.assign(new Error('fail'), { name: 'NetworkError' });
      }
      device.gatt.connected = true;
      return server;
    },
    disconnect: () => {
      const was = device.gatt.connected;
      device.gatt.connected = false;
      if (was) device.emit('gattserverdisconnected');
    },
  };
  device.dropLink = () => {
    device.gatt.connected = false;
    device.emit('gattserverdisconnected');
  };
  return device;
};

const setup = (device = makeDevice(), gap = () => 0) => {
  const statuses = [];
  const packets = [];
  let options = null;
  const link = new BleLink({
    bluetooth: { requestDevice: async o => { options = o; return device; } },
    onStatus: s => statuses.push(s),
    onPacket: p => packets.push(p),
    backoff: [5, 5, 5],
    connectTimeout: 50,
    commandGap: gap,
  });
  return { link, device, statuses, packets, options: () => options };
};

test('เลือกอุปกรณ์ด้วยตัวกรองตามเอกสาร และขอ service ที่ถูกต้อง', async () => {
  const { link, options, statuses, packets } = setup();
  await link.connect();
  assert.deepEqual(options(), { filters: [{ name: DEVICE_NAME }], optionalServices: [SERVICE_UUID] });
  assert.deepEqual(statuses, ['connecting', 'connected']);
  assert.equal(packets.length, 1, 'อ่านค่าแรกทันทีหลังเชื่อมต่อ');
  assert.equal(link.connected, true);
});

test('ส่งต่อ notify ไปยัง onPacket', async () => {
  const { link, device, packets } = setup();
  await link.connect();
  device.chars.at(-1).emit('characteristicvaluechanged');
  assert.equal(packets.length, 2);
});

test('พลาดครั้งแรกตอนเชื่อมต่อจะลองซ้ำเอง', async () => {
  const device = makeDevice();
  device.failConnects = 2;
  const { link, statuses } = setup(device);
  await link.connect();
  assert.equal(device.connectCalls, 3);
  assert.equal(statuses.at(-1), 'connected');
});

test('ลองครบแล้วยังไม่ได้ต้องแจ้งข้อผิดพลาด และไม่พยายามต่อเอง', async () => {
  const device = makeDevice();
  device.failConnects = 99;
  const { link, statuses } = setup(device);
  await assert.rejects(link.connect(), { name: 'NetworkError' });
  assert.equal(statuses.at(-1), 'idle');
  const calls = device.connectCalls;
  await wait(30);
  assert.equal(device.connectCalls, calls);
});

test('gatt.connect ค้าง จะหมดเวลาและแจ้งข้อผิดพลาด', async () => {
  const device = makeDevice();
  device.gatt.connect = () => new Promise(() => {});
  const { link } = setup(device);
  await assert.rejects(link.connect(), { name: 'TimeoutError' });
});

test('สัญญาณหลุดจะเชื่อมต่อใหม่อัตโนมัติ และ listener ไม่ซ้ำ', async () => {
  const { link, device, statuses, packets } = setup();
  await link.connect();
  const oldChar = device.chars.at(-1);
  device.dropLink();
  assert.equal(statuses.at(-1), 'reconnecting');
  await until(() => statuses.at(-1) === 'connected');
  assert.equal(link.connected, true);
  assert.equal(oldChar.count('characteristicvaluechanged'), 0, 'ของเก่าต้องถอด listener');
  const before = packets.length;
  device.chars.at(-1).emit('characteristicvaluechanged');
  assert.equal(packets.length, before + 1, 'ได้ข้อมูลรอบละครั้งเดียว');
});

test('ต่อไม่ติดหลายครั้งจะลองไปเรื่อย ๆ จนสำเร็จ', async () => {
  const { link, device, statuses } = setup();
  await link.connect();
  device.failConnects = 4;
  device.dropLink();
  await until(() => statuses.at(-1) === 'connected');
  assert.equal(device.failConnects, 0);
});

test('หลุดระหว่างอ่านค่าแรก ต้องไม่รายงานว่าเชื่อมต่อสำเร็จ', async () => {
  const { link, device, statuses } = setup();
  await link.connect();
  const realConnect = device.gatt.connect;
  let trip = true;
  device.gatt.connect = async () => {
    const server = await realConnect();
    if (trip) {
      trip = false;
      const realService = server.getPrimaryService;
      return {
        getPrimaryService: async uuid => {
          const service = await realService(uuid);
          const realChar = service.getCharacteristic;
          return {
            getCharacteristic: async id => {
              const char = await realChar(id);
              if (id === STATUS_UUID) {
                char.readValue = async () => {
                  device.gatt.connected = false;
                  device.emit('gattserverdisconnected');
                  throw Object.assign(new Error('gone'), { name: 'NetworkError' });
                };
              }
              return char;
            },
          };
        },
      };
    }
    return server;
  };
  device.dropLink();
  await until(() => statuses.at(-1) === 'connected' && link.connected);
  assert.ok(device.connectCalls >= 3, 'ต้องลองซ้ำหลังรอบที่หลุด');
});

test('ผู้ใช้ตัดการเชื่อมต่อเอง จะไม่เชื่อมต่อใหม่', async () => {
  const { link, device, statuses } = setup();
  await link.connect();
  const calls = device.connectCalls;
  link.disconnect();
  await wait(30);
  assert.equal(statuses.at(-1), 'idle');
  assert.equal(device.connectCalls, calls);
});

test('หยุดระหว่างกำลังลองใหม่ จะหยุดจริง', async () => {
  const { link, device, statuses } = setup();
  await link.connect();
  device.failConnects = 999;
  device.dropLink();
  link.disconnect();
  const calls = device.connectCalls;
  await wait(30);
  assert.equal(device.connectCalls, calls);
  assert.equal(statuses.at(-1), 'idle');
});

test('คำสั่งถูกส่งเป็น UTF-8 ตามลำดับ แม้เรียกซ้อนกัน', async () => {
  const { link, device } = setup();
  await link.connect();
  await Promise.all(['cal', 'thr=20', 'delay=5'].map(c => link.send(c)));
  assert.deepEqual(device.writes.map(w => w.text), ['cal', 'thr=20', 'delay=5']);
});

test('เว้นช่วงระหว่างคำสั่ง เพราะเฟิร์มแวร์ทิ้งคำสั่งที่มาตอนช่องไม่ว่าง', async () => {
  const { link, device } = setup(makeDevice(), () => 60);
  await link.connect();
  await link.send('cal');
  link.send('buzz');
  await wait(20);
  assert.deepEqual(device.writes.map(w => w.text), ['cal'], 'คำสั่งถัดไปต้องรอให้ครบช่วงพัก');
  await until(() => device.writes.length === 2);
  assert.deepEqual(device.writes.map(w => w.text), ['cal', 'buzz']);
});

test('ช่วงพักครอบคลุมเวลาที่เฟิร์มแวร์ค้างจริง', () => {
  // cal: อ่านเซนเซอร์ 20 × 20 ms + สั่น 100+100+100 ms / buzz: 150+100+150 ms / snooze: สั่นสูงสุด 500 ms
  assert.ok(commandGapMs('cal') > 700);
  assert.ok(commandGapMs('buzz') > 400);
  assert.ok(commandGapMs('snooze') > 500);
  assert.ok(commandGapMs('thr=20') > 0);
});

test('คำสั่งที่ล้มเหลวไม่ทำให้คิวค้าง', async () => {
  const { link, device } = setup();
  await link.connect();
  device.gatt.connected = false;
  await assert.rejects(link.send('cal'), { name: 'NotConnected' });
  device.gatt.connected = true;
  await link.send('buzz');
  assert.deepEqual(device.writes.map(w => w.text), ['buzz']);
});

test('สั่งปิดเครื่องแล้วต้องไม่พยายามเชื่อมต่อใหม่', async () => {
  const { link, device, statuses } = setup();
  await link.connect();
  await link.powerOff();
  assert.deepEqual(device.writes, [{ text: 'off', response: false }]);
  device.dropLink();
  const calls = device.connectCalls;
  await wait(30);
  assert.equal(device.connectCalls, calls);
  assert.equal(statuses.at(-1), 'idle');
});

test('ส่งคำสั่งปิดเครื่องไม่สำเร็จ ยังคงเชื่อมต่อใหม่ได้ตามปกติ', async () => {
  const { link, device, statuses } = setup();
  await link.connect();
  device.gatt.connected = false;
  await assert.rejects(link.powerOff());
  device.gatt.connected = true;
  device.dropLink();
  await until(() => statuses.at(-1) === 'connected');
});
