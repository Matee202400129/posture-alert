// ประวัติรายวัน: อุปกรณ์ล้างตัวนับทุกครั้งที่ปิดเครื่อง แอปจึงสะสมส่วนต่างของตัวนับลง IndexedDB เอง
import { dateKey, lastNDays } from './util.js';

const COUNTERS = ['good', 'slouch', 'alerts'];

/**
 * คำนวณส่วนต่างระหว่างตัวนับชุดก่อนกับชุดล่าสุด
 * ถ้าตัวนับลดลง แปลว่าเครื่องถูกปิดเปิดใหม่หรือล้างสถิติ ค่าปัจจุบันจึงเป็นส่วนที่สะสมใหม่ทั้งหมด
 * prev เป็น null ได้ (ครั้งแรกสุด) ซึ่งนับเป็นการเริ่มจากศูนย์
 */
export const counterDelta = (prev, pkt) => {
  const out = {};
  for (const key of COUNTERS) {
    const before = prev ? prev[key] : 0;
    out[key] = pkt[key] >= before ? pkt[key] - before : pkt[key];
  }
  return out;
};

const emptyDay = date => ({ date, good: 0, slouch: 0, alerts: 0 });

const DB_NAME = 'posture-alert';
const DB_VERSION = 1;

const request = req => new Promise((resolve, reject) => {
  req.onsuccess = () => resolve(req.result);
  req.onerror = () => reject(req.error);
});

const openDb = idb => new Promise((resolve, reject) => {
  const req = idb.open(DB_NAME, DB_VERSION);
  req.onupgradeneeded = () => {
    const db = req.result;
    if (!db.objectStoreNames.contains('days')) db.createObjectStore('days', { keyPath: 'date' });
    if (!db.objectStoreNames.contains('meta')) db.createObjectStore('meta');
  };
  req.onsuccess = () => resolve(req.result);
  req.onerror = () => reject(req.error);
});

/** บันทึกเฉพาะข้อมูลจากอุปกรณ์จริง ข้อมูลโหมดตัวอย่างห้ามเข้าที่นี่ */
export class HistoryStore {
  constructor({ idb = globalThis.indexedDB, now = () => new Date() } = {}) {
    this.idb = idb;
    this.now = now;
    this.db = null;
    this.last = null;
    this.pending = new Map();
    this.available = false;
    this.ready = this._open();
  }

  async _open() {
    try {
      this.db = await openDb(this.idb);
      const tx = this.db.transaction('meta', 'readonly');
      this.last = (await request(tx.objectStore('meta').get('last'))) || null;
      this.available = true;
    } catch (err) {
      console.warn('เปิด IndexedDB ไม่ได้ ประวัติจะอยู่แค่ในหน่วยความจำ', err);
    }
  }

  /** รับ packet ใหม่จากอุปกรณ์ แล้วพักส่วนต่างไว้รอเขียนลงเครื่อง */
  async record(pkt) {
    await this.ready;
    const delta = counterDelta(this.last, pkt);
    this.last = { good: pkt.good, slouch: pkt.slouch, alerts: pkt.alerts };
    const key = dateKey(this.now());
    const day = this.pending.get(key) || emptyDay(key);
    for (const name of COUNTERS) day[name] += delta[name];
    this.pending.set(key, day);
  }

  /** เขียนส่วนที่ค้างอยู่ทั้งหมดใน transaction เดียว ตัวนับล่าสุดจะได้ตรงกับยอดรายวันเสมอ */
  async flush() {
    await this.ready;
    if (!this.available || this.pending.size === 0) return;
    const batch = [...this.pending.values()];
    this.pending = new Map();
    const last = this.last;
    try {
      await new Promise((resolve, reject) => {
        const tx = this.db.transaction(['days', 'meta'], 'readwrite');
        const days = tx.objectStore('days');
        for (const add of batch) {
          const read = days.get(add.date);
          read.onsuccess = () => {
            const row = read.result || emptyDay(add.date);
            for (const name of COUNTERS) row[name] += add[name];
            days.put(row);
          };
        }
        tx.objectStore('meta').put(last, 'last');
        tx.oncomplete = resolve;
        tx.onerror = () => reject(tx.error);
        tx.onabort = () => reject(tx.error);
      });
    } catch (err) {
      // เขียนไม่สำเร็จ: คืนยอดกลับไปรอรอบถัดไป ไม่ให้ข้อมูลหาย
      for (const add of batch) {
        const day = this.pending.get(add.date) || emptyDay(add.date);
        for (const name of COUNTERS) day[name] += add[name];
        this.pending.set(add.date, day);
      }
      console.warn('บันทึกประวัติไม่สำเร็จ', err);
    }
  }

  /** ข้อมูล n วันล่าสุด รวมยอดที่ยังไม่ได้เขียนลงเครื่อง */
  async getDays(n = 7) {
    await this.ready;
    const keys = lastNDays(n, this.now());
    const stored = new Map();
    if (this.available) {
      const tx = this.db.transaction('days', 'readonly');
      const rows = await Promise.all(keys.map(k => request(tx.objectStore('days').get(k))));
      rows.forEach(r => { if (r) stored.set(r.date, r); });
    }
    return keys.map(k => {
      const row = { ...(stored.get(k) || emptyDay(k)) };
      const add = this.pending.get(k);
      if (add) for (const name of COUNTERS) row[name] += add[name];
      return row;
    });
  }

  /** ล้างประวัติทั้งหมด โดยจำตัวนับล่าสุดไว้ เพื่อไม่ให้ค่าที่ผ่านมาถูกนับซ้ำ */
  async clear() {
    await this.ready;
    this.pending = new Map();
    if (!this.available) return;
    await new Promise((resolve, reject) => {
      const tx = this.db.transaction(['days', 'meta'], 'readwrite');
      tx.objectStore('days').clear();
      if (this.last) tx.objectStore('meta').put(this.last, 'last');
      tx.oncomplete = resolve;
      tx.onerror = () => reject(tx.error);
    });
  }
}

/** ประวัติ 7 วันสำหรับโหมดตัวอย่าง ไม่ได้มาจากการวัดจริงและไม่ถูกบันทึก ค่าของแต่ละวันคงที่ตามวันที่ */
export const demoDays = (today, n = 7, now = new Date()) => {
  const keys = lastNDays(n, now);
  return keys.map((date, i) => {
    if (i === keys.length - 1) return { date, ...today };
    const seed = date.split('-').reduce((a, part) => (a * 31 + Number(part)) % 9973, 7);
    const good = 95 + (seed % 140);
    const slouch = 18 + ((seed * 7) % 70);
    return { date, good: good * 60, slouch: slouch * 60, alerts: 3 + ((seed * 3) % 16) };
  });
};
