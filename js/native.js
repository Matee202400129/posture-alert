// การเชื่อมต่อผ่านแอป Android: บริการเบื้องหลังของแอปถือการเชื่อมต่อ Bluetooth ไว้เอง (ทำงานต่อได้แม้ปิดจอ)
// หน้าเว็บคุยกับบริการผ่าน window.PostureNative และรับข้อมูลกลับทาง window.__postureNative
import { BLUETOOTH_OFF, bleErrorMessage } from './ble.js';

/** แอป Android ใส่ window.PostureNative ให้ก่อนหน้าเว็บโหลด */
export const isNativeApp = (win = globalThis) => !!win?.PostureNative;

const decode = base64 => {
  const raw = atob(base64);
  const bytes = new Uint8Array(raw.length);
  for (let i = 0; i < raw.length; i++) bytes[i] = raw.charCodeAt(i);
  return new DataView(bytes.buffer);
};

const nativeError = (name, message) => {
  const err = new Error(message || name);
  err.name = name;
  return err;
};

export const nativeErrorMessage = err => {
  if (err?.name === 'BluetoothOff') return BLUETOOTH_OFF;
  if (err?.name === 'PermissionError') {
    return {
      title: 'แอปยังไม่ได้รับสิทธิ์ที่ต้องใช้',
      fix: 'อนุญาต "อุปกรณ์ที่อยู่ใกล้เคียง" และ "การแจ้งเตือน" ให้ PostureAlert ในการตั้งค่าแอปของมือถือ แล้วกดเชื่อมต่ออีกครั้ง',
    };
  }
  return bleErrorMessage(err);
};

/** ใช้งานเหมือน BleLink: สถานะ idle | connecting | connected | reconnecting */
export class NativeLink {
  constructor({ onStatus = () => {}, onPacket = () => {} } = {}, { bridge = globalThis.PostureNative, host = globalThis } = {}) {
    this.onStatus = onStatus;
    this.onPacket = onPacket;
    this.bridge = bridge;
    this.status = 'idle';
    this.nextId = 1;
    this.replies = new Map();
    this.waiting = null;
    host.__postureNative = {
      onStatus: (status, attempt) => this._status(status, attempt),
      onError: (name, message) => this._fail(nativeError(name, message)),
      onPacket: base64 => this.onPacket(decode(base64)),
      onReply: (id, ok, message) => this._reply(id, ok, message),
    };
  }

  get connected() {
    return this.status === 'connected';
  }

  /** ถามบริการว่าเชื่อมต่ออยู่ไหม เช่น เปิดแอปกลับมาจากแจ้งเตือน */
  attach() {
    this.bridge.hello();
  }

  _status(status, attempt = 0) {
    this.status = status;
    if (status === 'connected' && this.waiting) {
      this.waiting.resolve();
      this.waiting = null;
    }
    this.onStatus(status, { attempt });
  }

  _fail(err) {
    this.status = 'idle';
    if (this.waiting) {
      this.waiting.reject(err);
      this.waiting = null;
    } else {
      this.onStatus('idle', { attempt: 0 });
    }
  }

  _reply(id, ok, message) {
    const pending = this.replies.get(id);
    if (!pending) return;
    this.replies.delete(id);
    if (ok) pending.resolve();
    else pending.reject(nativeError('NetworkError', message));
  }

  /** สำเร็จเมื่อเชื่อมต่อแล้ว ล้มเหลวเมื่อหาไม่เจอหรือไม่มีสิทธิ์ */
  connect() {
    this.waiting?.reject(nativeError('AbortError', 'replaced'));
    return new Promise((resolve, reject) => {
      this.waiting = { resolve, reject };
      this.bridge.connect();
    });
  }

  /** บริการต่อใหม่เองอยู่แล้ว */
  retryNow() {}

  disconnect() {
    this.bridge.disconnect();
  }

  /** บริการส่งทีละคำสั่งและเว้นจังหวะให้เอง เพราะเฟิร์มแวร์เก็บคำสั่งรอได้ทีละ 1 ช่อง */
  send(text) {
    const id = this.nextId++;
    return new Promise((resolve, reject) => {
      this.replies.set(id, { resolve, reject });
      this.bridge.send(id, String(text));
    });
  }

  /** ปิดเครื่อง: บริการส่ง off แล้วเลิกต่อใหม่ เครื่องจะเปิดใหม่ได้จากปุ่มบนเครื่องเท่านั้น */
  powerOff() {
    const id = this.nextId++;
    return new Promise((resolve, reject) => {
      this.replies.set(id, { resolve, reject });
      this.bridge.powerOff(id);
    });
  }

  /** ตั้งค่าการเตือนบนมือถือของบริการ */
  setAlerts(vibrate, notify) {
    this.bridge.setAlerts(!!vibrate, !!notify);
  }
}
