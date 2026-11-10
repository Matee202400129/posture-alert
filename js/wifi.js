// การเชื่อมต่อผ่าน Wi-Fi ของบอร์ด (เฟิร์มแวร์ posture_v5): ใช้ packet 20 ไบต์และคำสั่งชุดเดียวกับ Bluetooth
// หน้าเว็บต้องโหลดจากตัวบอร์ด เพราะหน้า HTTPS ติดต่อบอร์ดที่เป็น HTTP ไม่ได้
import { PACKET_SIZE } from './protocol.js';
import { commandGapMs } from './ble.js';

const POLL_MS = 500;
const REQUEST_TIMEOUT_MS = 2500;
const FAILS_BEFORE_LOST = 2;

/** tools/embed-site.mjs ใส่ meta นี้ให้เฉพาะหน้าเว็บที่เก็บในบอร์ด */
export const isDeviceHosted = (doc = globalThis.document) => !!doc?.querySelector('meta[name="pa-device-hosted"]');

export const WIFI_ERROR = Object.freeze({
  title: 'เชื่อมต่ออุปกรณ์ผ่าน Wi-Fi ไม่ได้',
  fix: 'ตรวจว่ามือถือยังต่อ Wi-Fi ชื่อ PostureAlert และเครื่องเปิดอยู่ แล้วโหลดหน้านี้ใหม่',
});

/** ใช้งานเหมือน BleLink: สถานะ idle | connecting | connected | reconnecting */
export class WifiLink {
  constructor({ onStatus = () => {}, onPacket = () => {}, fetchFn = (...a) => globalThis.fetch(...a), pollMs = POLL_MS, timeoutMs = REQUEST_TIMEOUT_MS, commandGap = commandGapMs } = {}) {
    this.onStatus = onStatus;
    this.onPacket = onPacket;
    this.fetchFn = fetchFn;
    this.pollMs = pollMs;
    this.timeoutMs = timeoutMs;
    this.commandGap = commandGap;
    this.want = false;
    this.online = false;
    this.fails = 0;
    this.timer = null;
    this.generation = 0;
    this.writeQueue = Promise.resolve();
  }

  get connected() {
    return this.online;
  }

  async _request(path, options = {}) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.timeoutMs);
    try {
      const response = await this.fetchFn(path, { cache: 'no-store', signal: controller.signal, ...options });
      if (!response.ok) {
        const err = new Error(`HTTP ${response.status}`);
        err.name = 'NetworkError';
        throw err;
      }
      return response;
    } finally {
      clearTimeout(timer);
    }
  }

  async _readStatus() {
    const response = await this._request('status');
    const buffer = await response.arrayBuffer();
    if (buffer.byteLength !== PACKET_SIZE) {
      const err = new Error(`bad packet length ${buffer.byteLength}`);
      err.name = 'NetworkError';
      throw err;
    }
    return new DataView(buffer);
  }

  /** ลองอ่านครั้งแรก ถ้าไม่ได้ให้แจ้งข้อผิดพลาดทันที */
  async connect() {
    this._stop();
    this.want = true;
    const generation = ++this.generation;
    this.onStatus('connecting');
    let packet;
    try {
      packet = await this._readStatus();
    } catch (err) {
      if (generation === this.generation) {
        this.want = false;
        this.onStatus('idle');
      }
      throw err;
    }
    if (generation !== this.generation) return;
    this.online = true;
    this.fails = 0;
    this.onPacket(packet);
    this.onStatus('connected');
    this._schedule(generation);
  }

  _schedule(generation, delay = this.pollMs) {
    if (!this.want || generation !== this.generation) return;
    clearTimeout(this.timer);
    this.timer = setTimeout(() => this._poll(generation), delay);
  }

  async _poll(generation) {
    try {
      const packet = await this._readStatus();
      if (generation !== this.generation || !this.want) return;
      const wasLost = !this.online;
      this.online = true;
      this.fails = 0;
      this.onPacket(packet);
      if (wasLost) this.onStatus('connected');
    } catch {
      if (generation !== this.generation || !this.want) return;
      this.fails += 1;
      if (this.fails >= FAILS_BEFORE_LOST) {
        this.online = false;
        this.onStatus('reconnecting', { attempt: this.fails - FAILS_BEFORE_LOST + 1 });
      }
    }
    this._schedule(generation);
  }

  _stop() {
    clearTimeout(this.timer);
    this.timer = null;
    this.online = false;
    this.fails = 0;
    this.generation += 1;
  }

  /** กลับเข้ามาที่หน้าเว็บ: อ่านทันทีไม่ต้องรอรอบถัดไป */
  retryNow() {
    if (!this.want) return;
    this._schedule(this.generation, 0);
  }

  disconnect() {
    this.want = false;
    this._stop();
    this.onStatus('idle');
  }

  /** ส่งทีละคำสั่งและเว้นจังหวะ เพราะเฟิร์มแวร์เก็บคำสั่งรอได้ทีละ 1 ช่อง */
  send(text) {
    const run = async () => {
      await this._request(`cmd?c=${encodeURIComponent(text)}`, { method: 'POST' });
    };
    const result = this.writeQueue.then(run, run);
    const gap = this.commandGap(text);
    this.writeQueue = result.catch(() => {}).then(() => new Promise(resolve => setTimeout(resolve, gap)));
    return result;
  }

  /** ปิดเครื่อง: หยุดอ่านก่อนส่ง เครื่องจะเปิดใหม่ได้จากปุ่มบนเครื่องเท่านั้น */
  async powerOff() {
    const wasWanted = this.want;
    this.want = false;
    clearTimeout(this.timer);
    try {
      await this.send('off');
    } catch (err) {
      this.want = wasWanted;
      this._schedule(this.generation);
      throw err;
    }
  }
}
