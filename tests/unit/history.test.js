// ทดสอบ HistoryStore ด้วย IndexedDB จำลองขนาดเล็กที่มีเฉพาะส่วนที่ใช้
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { HistoryStore } from '../../js/history.js';

const fakeIndexedDB = () => {
  const data = new Map();
  const later = fn => queueMicrotask(fn);
  const makeRequest = compute => {
    const req = {};
    later(() => {
      req.result = compute();
      req.onsuccess?.();
    });
    return req;
  };
  const db = {
    objectStoreNames: { contains: name => data.has(name) },
    createObjectStore: name => { data.set(name, new Map()); },
    transaction() {
      const tx = { oncomplete: null, onerror: null };
      let open = 0;
      const settle = () => {
        if (open === 0) setTimeout(() => { if (open === 0) tx.oncomplete?.(); }, 0);
      };
      const track = compute => {
        open += 1;
        const req = {};
        later(() => {
          req.result = compute();
          req.onsuccess?.();
          open -= 1;
          settle();
        });
        return req;
      };
      tx.objectStore = name => ({
        get: key => track(() => {
          const v = data.get(name).get(key);
          return v === undefined ? undefined : structuredClone(v);
        }),
        put: (value, key) => track(() => {
          data.get(name).set(key ?? value.date, structuredClone(value));
        }),
        clear: () => track(() => data.get(name).clear()),
      });
      settle();
      return tx;
    },
  };
  return {
    data,
    open() {
      const req = {};
      later(() => {
        req.result = db;
        if (data.size === 0) req.onupgradeneeded?.();
        later(() => req.onsuccess?.());
      });
      return req;
    },
    makeRequest,
  };
};

const pkt = (good, slouch, alerts) => ({ good, slouch, alerts });
const at = (d, h = 12) => new Date(2026, 10, d, h);

const makeStore = (idb, now) => new HistoryStore({ idb, now: () => now.value });

test('สะสมยอดรายวันจากส่วนต่าง และบันทึกลงเครื่อง', async () => {
  const idb = fakeIndexedDB();
  const now = { value: at(5) };
  const store = makeStore(idb, now);
  await store.record(pkt(10, 2, 0));
  await store.record(pkt(20, 4, 1));
  await store.flush();
  const days = await store.getDays(1);
  assert.deepEqual(days[0], { date: '2026-11-05', good: 20, slouch: 4, alerts: 1 });
});

test('ยอดที่ยังไม่ได้เขียนก็รวมอยู่ในผลลัพธ์', async () => {
  const idb = fakeIndexedDB();
  const store = makeStore(idb, { value: at(5) });
  await store.record(pkt(10, 2, 0));
  await store.flush();
  await store.record(pkt(15, 2, 0));
  const days = await store.getDays(1);
  assert.equal(days[0].good, 15);
});

test('เครื่องปิดเปิดใหม่ (ตัวนับกลับไปเริ่มใหม่) ยอดสะสมต้องไม่หาย', async () => {
  const idb = fakeIndexedDB();
  const store = makeStore(idb, { value: at(5) });
  await store.record(pkt(100, 20, 3));
  await store.record(pkt(5, 1, 0));
  await store.record(pkt(8, 1, 1));
  await store.flush();
  const [day] = await store.getDays(1);
  assert.deepEqual([day.good, day.slouch, day.alerts], [108, 21, 4]);
});

test('ปิดหน้าเว็บแล้วเปิดใหม่ ต้องไม่นับตัวนับเดิมซ้ำ', async () => {
  const idb = fakeIndexedDB();
  const now = { value: at(5) };
  const first = makeStore(idb, now);
  await first.record(pkt(100, 20, 3));
  await first.flush();

  const second = makeStore(idb, now);
  await second.record(pkt(110, 20, 3));
  await second.flush();
  const [day] = await second.getDays(1);
  assert.deepEqual([day.good, day.slouch, day.alerts], [110, 20, 3]);
});

test('ข้ามเที่ยงคืน ยอดใหม่ไปอยู่วันใหม่', async () => {
  const idb = fakeIndexedDB();
  const now = { value: at(5, 23) };
  const store = makeStore(idb, now);
  await store.record(pkt(100, 0, 0));
  await store.flush();
  now.value = at(6, 0);
  await store.record(pkt(130, 5, 1));
  await store.flush();
  const days = await store.getDays(2);
  assert.deepEqual(days.map(d => d.good), [100, 30]);
  assert.deepEqual(days.map(d => d.date), ['2026-11-05', '2026-11-06']);
});

test('getDays คืนครบ 7 วัน รวมวันที่ไม่มีข้อมูล', async () => {
  const idb = fakeIndexedDB();
  const store = makeStore(idb, { value: at(5) });
  await store.record(pkt(1, 0, 0));
  await store.flush();
  const days = await store.getDays(7);
  assert.equal(days.length, 7);
  assert.equal(days[0].good, 0);
  assert.equal(days[6].good, 1);
});

test('ล้างประวัติแล้วตัวนับเดิมในอุปกรณ์ต้องไม่กลับมาอีก', async () => {
  const idb = fakeIndexedDB();
  const store = makeStore(idb, { value: at(5) });
  await store.record(pkt(100, 20, 3));
  await store.flush();
  await store.clear();
  await store.record(pkt(103, 20, 3));
  await store.flush();
  const [day] = await store.getDays(1);
  assert.deepEqual([day.good, day.slouch, day.alerts], [3, 0, 0]);
});

test('ใช้ IndexedDB ไม่ได้ ก็ยังทำงานได้จากหน่วยความจำ', async () => {
  const broken = { open() { throw new Error('blocked'); } };
  const warn = console.warn;
  console.warn = () => {};
  try {
    const store = makeStore(broken, { value: at(5) });
    await store.record(pkt(10, 2, 0));
    await store.flush();
    const [day] = (await store.getDays(1));
    assert.equal(store.available, false);
    assert.equal(day.good, 10);
  } finally {
    console.warn = warn;
  }
});
