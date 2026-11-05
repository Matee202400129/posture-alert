// การเชื่อมต่อ Web Bluetooth: เลือกอุปกรณ์ รับ packet ส่งคำสั่ง และเชื่อมต่อใหม่อัตโนมัติเมื่อหลุด
import { DEVICE_NAME, SERVICE_UUID, STATUS_UUID, COMMAND_UUID } from './protocol.js';

const BACKOFF_MS = [1000, 2000, 4000, 8000, 15000];
const CONNECT_TIMEOUT_MS = 12000;
const INITIAL_ATTEMPTS = 3;

/**
 * เวลาพักหลังส่งแต่ละคำสั่ง: เฟิร์มแวร์เก็บคำสั่งได้ทีละ 1 ช่อง ถ้าช่องยังไม่ว่าง คำสั่งใหม่จะถูกทิ้งเงียบ ๆ
 * ทั้งที่การเขียนสำเร็จ และ cal / buzz / snooze ทำให้ loop() ค้างระหว่างสั่นหรืออ่านเซนเซอร์
 */
export const commandGapMs = text => ({ cal: 900, buzz: 500, snooze: 600 })[text] ?? 150;

const withTimeout = (promise, ms) => new Promise((resolve, reject) => {
  const timer = setTimeout(() => {
    const err = new Error('connect timeout');
    err.name = 'TimeoutError';
    reject(err);
  }, ms);
  promise.then(
    value => { clearTimeout(timer); resolve(value); },
    err => { clearTimeout(timer); reject(err); },
  );
});

/**
 * สถานะที่ส่งให้ onStatus:
 * idle | connecting | connected | reconnecting (ส่ง { attempt } มาด้วย)
 */
export class BleLink {
  constructor({ bluetooth = globalThis.navigator?.bluetooth, onStatus = () => {}, onPacket = () => {}, backoff = BACKOFF_MS, connectTimeout = CONNECT_TIMEOUT_MS, commandGap = commandGapMs } = {}) {
    this.commandGap = commandGap;
    this.bluetooth = bluetooth;
    this.onStatus = onStatus;
    this.onPacket = onPacket;
    this.backoff = backoff;
    this.connectTimeout = connectTimeout;
    this.device = null;
    this.statusChar = null;
    this.commandChar = null;
    this.want = false;
    this.connecting = false;
    this.retryTimer = null;
    this.attempt = 0;
    this.writeQueue = Promise.resolve();
    this._onValue = e => this.onPacket(e.target.value);
    this._onDisconnect = () => this._handleDisconnect();
  }

  get connected() {
    return !!(this.device?.gatt?.connected && this.commandChar);
  }

  /** เปิดหน้าต่างเลือกอุปกรณ์ ต้องเรียกจากการกดปุ่มของผู้ใช้ */
  async connect() {
    const device = await this.bluetooth.requestDevice({
      // เฟิร์มแวร์ไม่ได้ใส่ชื่อในสัญญาณที่ประกาศเสมอไป (พบจากการสแกนเครื่องจริง) จึงต้องค้นหาด้วย UUID ของ service ด้วย
      filters: [{ name: DEVICE_NAME }, { services: [SERVICE_UUID] }],
      optionalServices: [SERVICE_UUID],
    });
    if (this.device && this.device !== device) this.device.removeEventListener('gattserverdisconnected', this._onDisconnect);
    this._cancelRetry();
    this.device = device;
    device.addEventListener('gattserverdisconnected', this._onDisconnect);
    this.want = true;
    this.attempt = 0;
    this.onStatus('connecting');

    // Bluetooth บนมือถือมักพลาดครั้งแรก จึงลองซ้ำก่อนแจ้งว่าไม่สำเร็จ
    this.connecting = true;
    try {
      for (let i = 1; ; i++) {
        try {
          await this._setup();
          break;
        } catch (err) {
          if (!this.want) throw err;
          const fatal = err.name === 'NotFoundError' || err.name === 'SecurityError';
          if (fatal || i >= INITIAL_ATTEMPTS) throw err;
        }
      }
    } catch (err) {
      this.want = false;
      this._dropGatt();
      this.onStatus('idle');
      throw err;
    } finally {
      this.connecting = false;
    }
    this.onStatus('connected');
  }

  async _setup() {
    this._releaseChars();
    const { gatt } = this.device;
    let server;
    try {
      server = await withTimeout(gatt.connect(), this.connectTimeout);
    } catch (err) {
      this._dropGatt();
      throw err;
    }
    const service = await server.getPrimaryService(SERVICE_UUID);
    const statusChar = await service.getCharacteristic(STATUS_UUID);
    const commandChar = await service.getCharacteristic(COMMAND_UUID);
    statusChar.addEventListener('characteristicvaluechanged', this._onValue);
    this.statusChar = statusChar;
    await statusChar.startNotifications();
    this.commandChar = commandChar;
    this.writeQueue = Promise.resolve();
    // ได้ค่าแรกทันทีโดยไม่ต้องรอ notify รอบถัดไป
    try {
      this.onPacket(await statusChar.readValue());
    } catch { /* notify จะส่งค่ามาเองภายใน 0.5 วินาที */ }
    // อ่านค่าแรกพลาดเพราะสายหลุดก็ได้ ต้องไม่รายงานว่าเชื่อมต่อสำเร็จ
    if (!gatt.connected) {
      const err = new Error('disconnected during setup');
      err.name = 'NetworkError';
      throw err;
    }
  }

  _releaseChars() {
    this.statusChar?.removeEventListener('characteristicvaluechanged', this._onValue);
    this.statusChar = null;
    this.commandChar = null;
  }

  _dropGatt() {
    try { this.device?.gatt?.disconnect(); } catch { /* ไม่ได้เชื่อมต่ออยู่แล้ว */ }
  }

  _handleDisconnect() {
    this._releaseChars();
    if (!this.want) {
      this.onStatus('idle');
      return;
    }
    // ถ้าหลุดระหว่างกำลังเชื่อมต่อ รอบที่กำลังทำอยู่จะจัดการต่อเอง
    if (this.connecting) return;
    this.onStatus('reconnecting', { attempt: this.attempt + 1 });
    this._scheduleRetry();
  }

  _scheduleRetry() {
    if (this.retryTimer !== null) return;
    const delay = this.backoff[Math.min(this.attempt, this.backoff.length - 1)];
    this.attempt += 1;
    this.retryTimer = setTimeout(() => {
      this.retryTimer = null;
      this._retry();
    }, delay);
  }

  _cancelRetry() {
    if (this.retryTimer !== null) clearTimeout(this.retryTimer);
    this.retryTimer = null;
  }

  async _retry() {
    if (!this.want || this.connecting) return;
    this.connecting = true;
    this.onStatus('reconnecting', { attempt: this.attempt });
    let ok = false;
    try {
      await this._setup();
      ok = true;
    } catch { /* จะลองใหม่ด้านล่าง */ }
    this.connecting = false;
    if (!this.want) {
      this._releaseChars();
      this._dropGatt();
      return;
    }
    if (ok) {
      this.attempt = 0;
      this.onStatus('connected');
    } else {
      this._releaseChars();
      this.onStatus('reconnecting', { attempt: this.attempt + 1 });
      this._scheduleRetry();
    }
  }

  /** กลับเข้ามาที่หน้าเว็บ: ลองใหม่ทันทีไม่ต้องรอ backoff */
  retryNow() {
    if (!this.want || this.connected || this.connecting) return;
    this._cancelRetry();
    this.attempt = 1;
    this._retry();
  }

  /** ผู้ใช้สั่งเลิกเชื่อมต่อ จะไม่เชื่อมต่อใหม่เอง */
  disconnect() {
    this.want = false;
    this._cancelRetry();
    this._releaseChars();
    if (this.device?.gatt?.connected) this.device.gatt.disconnect();
    this.onStatus('idle');
  }

  /** ส่งคำสั่งข้อความ UTF-8 ทีละคำสั่ง เพราะ GATT เขียนซ้อนกันไม่ได้ */
  send(text, { withoutResponse = false } = {}) {
    const run = async () => {
      const char = this.commandChar;
      if (!char || !this.device?.gatt?.connected) {
        const err = new Error('not connected');
        err.name = 'NotConnected';
        throw err;
      }
      const data = new TextEncoder().encode(text);
      if (withoutResponse && char.writeValueWithoutResponse) return char.writeValueWithoutResponse(data);
      if (char.writeValueWithResponse) return char.writeValueWithResponse(data);
      return char.writeValue(data);
    };
    const result = this.writeQueue.then(run, run);
    const gap = this.commandGap(text);
    this.writeQueue = result.catch(() => {}).then(() => new Promise(resolve => setTimeout(resolve, gap)));
    return result;
  }

  /**
   * สั่งปิดเครื่อง: ต้องปิดการเชื่อมต่อใหม่ก่อนส่ง
   * เครื่องจะเข้า deep sleep และเปิดได้จากปุ่มบนเครื่องเท่านั้น จึงไม่มีทางเชื่อมต่อกลับได้เอง
   */
  async powerOff() {
    this.want = false;
    this._cancelRetry();
    try {
      await this.send('off', { withoutResponse: true });
    } catch (err) {
      this.want = true;
      throw err;
    }
  }
}

const isIOS = (ua, platform, touch) => /iPhone|iPad|iPod/.test(ua) || (platform === 'MacIntel' && touch > 1);

/** ตรวจก่อนเชื่อมต่อ คืนข้อความแนะนำภาษาไทย หรือ null ถ้าไม่มีปัญหา */
export const checkSupport = (env = globalThis) => {
  const nav = env.navigator || {};
  if (nav.bluetooth) {
    if (env.isSecureContext === false) return insecureMessage();
    return null;
  }
  if (env.isSecureContext === false) return insecureMessage();
  if (isIOS(nav.userAgent || '', nav.platform || '', nav.maxTouchPoints || 0)) {
    return {
      title: 'iPhone และ iPad ต้องใช้แอป Bluefy',
      fix: 'Safari และ Chrome บน iOS ยังไม่รองรับ Web Bluetooth ให้ติดตั้งแอป Bluefy จาก App Store แล้วเปิดเว็บนี้ในแอปนั้น',
    };
  }
  return {
    title: 'เบราว์เซอร์นี้ยังไม่รองรับ Web Bluetooth',
    fix: 'กรุณาเปิดเว็บนี้ด้วย Chrome หรือ Edge บน Android, Windows หรือ macOS',
  };
};

const insecureMessage = () => ({
  title: 'ต้องเปิดเว็บผ่าน HTTPS',
  fix: 'Web Bluetooth ใช้ได้เฉพาะหน้าเว็บที่เป็น HTTPS หรือ localhost ให้เปิดจากลิงก์ GitHub Pages แทน',
});

export const BLUETOOTH_OFF = Object.freeze({
  title: 'ยังไม่ได้เปิด Bluetooth',
  fix: 'เปิด Bluetooth ในการตั้งค่าเครื่อง แล้วกดเชื่อมต่ออีกครั้ง',
});

/** แปลงข้อผิดพลาดของ Web Bluetooth เป็นข้อความไทยที่บอกวิธีแก้ คืน null เมื่อผู้ใช้กดยกเลิกเอง */
export const bleErrorMessage = err => {
  const name = err?.name || '';
  const message = String(err?.message || '');
  if (name === 'NotFoundError') {
    if (/cancel/i.test(message)) return null;
    if (/adapter|bluetooth.*(off|unavailable|not available)/i.test(message)) return BLUETOOTH_OFF;
    if (/globally disabled/i.test(message)) {
      return { title: 'Web Bluetooth ถูกปิดอยู่', fix: 'เปิดสิทธิ์ Bluetooth ในการตั้งค่าเว็บไซต์ของเบราว์เซอร์ แล้วโหลดหน้านี้ใหม่' };
    }
    if (/service|characteristic/i.test(message)) {
      return { title: 'อุปกรณ์นี้ไม่ตรงกับ PostureAlert', fix: 'ตรวจว่าเลือกอุปกรณ์ถูกตัว และเฟิร์มแวร์ในบอร์ดเป็นรุ่นล่าสุด' };
    }
    return { title: 'ไม่เจออุปกรณ์ PostureAlert', fix: 'เปิดเครื่องด้วยปุ่มบนตัวอุปกรณ์ วางไว้ใกล้ ๆ และปิดการเชื่อมต่อจากมือถือเครื่องอื่นก่อน' };
  }
  if (name === 'SecurityError') {
    return { title: 'เบราว์เซอร์ไม่อนุญาตให้ใช้ Bluetooth', fix: 'เปิดเว็บผ่าน HTTPS และอนุญาตสิทธิ์ Bluetooth (บน Android ต้องอนุญาต "อุปกรณ์ใกล้เคียง" ให้ Chrome ด้วย)' };
  }
  if (name === 'NotSupportedError') {
    return { title: 'อุปกรณ์นี้ไม่รองรับ Bluetooth แบบที่ใช้', fix: 'ลองใช้ Chrome หรือ Edge บนมือถือหรือคอมที่มี Bluetooth 4.0 ขึ้นไป' };
  }
  if (name === 'TimeoutError' || name === 'NetworkError') {
    return { title: 'เชื่อมต่อกับอุปกรณ์ไม่สำเร็จ', fix: 'วางอุปกรณ์ให้ใกล้ขึ้น ตรวจว่าแบตยังไม่หมด แล้วลองอีกครั้ง ถ้ายังไม่ได้ให้ปิดเปิดเครื่องใหม่' };
  }
  return { title: 'เชื่อมต่อไม่สำเร็จ', fix: 'ลองปิดเปิด Bluetooth แล้วกดเชื่อมต่ออีกครั้ง' };
};
