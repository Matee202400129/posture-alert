// อุปกรณ์จำลองสำหรับโหมดตัวอย่าง ทำงานตามกติกาในเอกสารและส่งข้อมูลเป็น packet 20 ไบต์เหมือนของจริง
import { STATE, THR_RANGE, DELAY_RANGE, encode } from './protocol.js';

const SNOOZE_SECONDS = 30 * 60;
const LYING_ANGLE = 60;
const HYSTERESIS = 5;

// ท่าเป้าหมายของแต่ละสถานการณ์ (องศาดิบก่อนหักท่าตรงที่บันทึกไว้)
const POSES = {
  upright: { upper: 4, lower: 2, moving: false },
  slouch: { upper: 28, lower: 5, moving: false },
  moving: { upper: 16, lower: 9, moving: true },
  lying: { upper: 78, lower: 70, moving: false },
};

// ลำดับในโหมดอัตโนมัติ: [ท่า, ระยะเวลา (วินาที)]
const AUTO_SCRIPT = [
  ['upright', 14], ['slouch', 12], ['upright', 12], ['moving', 6], ['upright', 10], ['slouch', 10], ['lying', 7],
];

export const SCENARIOS = Object.freeze(['auto', 'upright', 'slouch', 'moving', 'lying', 'sensor']);

const clamp = (v, lo, hi) => Math.min(hi, Math.max(lo, v));

export class Simulator {
  constructor({ rng = Math.random } = {}) {
    this.rng = rng;
    this.scenario = 'auto';
    this.battMv = 3950;
    this.thr = 15;
    this.delay = 3;
    this.boot();
  }

  /** เปิดเครื่องใหม่: สถิติหายไปเหมือนเครื่องจริง แต่เกณฑ์ที่ตั้งไว้ยังอยู่ */
  boot() {
    this.rawUpper = 4;
    this.rawLower = 2;
    this.offsetUpper = 0;
    this.offsetLower = 0;
    this.good = 0;
    this.slouch = 0;
    this.alerts = 0;
    this.snoozeLeft = 0;
    this.alarm = false;
    this.overFor = 0;
    this.scriptIndex = 0;
    this.scriptLeft = AUTO_SCRIPT[0][1];
    this.state = STATE.OK;
  }

  setScenario(name) {
    if (!SCENARIOS.includes(name)) return;
    this.scenario = name;
    this.scriptIndex = 0;
    this.scriptLeft = AUTO_SCRIPT[0][1];
  }

  /** รับคำสั่งรูปแบบเดียวกับที่ส่งไปอุปกรณ์จริง */
  command(text) {
    const assign = /^(thr|delay)=(\d+)$/.exec(text);
    if (assign) {
      const value = Number(assign[2]);
      const range = assign[1] === 'thr' ? THR_RANGE : DELAY_RANGE;
      if (value >= range.min && value <= range.max) this[assign[1]] = value;
      return;
    }
    switch (text) {
      case 'cal':
        this.offsetUpper = this.rawUpper;
        this.offsetLower = this.rawLower;
        break;
      case 'snooze':
        this.snoozeLeft = this.snoozeLeft > 0 ? 0 : SNOOZE_SECONDS;
        break;
      case 'reset':
        this.good = 0;
        this.slouch = 0;
        this.alerts = 0;
        break;
      case 'off':
        this.boot();
        break;
    }
  }

  get upper() { return this.rawUpper - this.offsetUpper; }
  get lower() { return this.rawLower - this.offsetLower; }
  get curve() { return this.upper - this.lower; }

  _pose() {
    if (this.scenario === 'auto') return POSES[AUTO_SCRIPT[this.scriptIndex][0]];
    return POSES[this.scenario] || POSES.upright;
  }

  /** เดินเวลาไป dt วินาที */
  tick(dt) {
    if (this.scenario === 'auto') {
      this.scriptLeft -= dt;
      if (this.scriptLeft <= 0) {
        this.scriptIndex = (this.scriptIndex + 1) % AUTO_SCRIPT.length;
        this.scriptLeft = AUTO_SCRIPT[this.scriptIndex][1];
      }
    }

    const pose = this._pose();
    const noise = pose.moving ? 6 : 0.5;
    const ease = 1 - Math.exp(-dt * 1.4);
    this.rawUpper += (pose.upper - this.rawUpper) * ease + (this.rng() - 0.5) * noise;
    this.rawLower += (pose.lower - this.rawLower) * ease + (this.rng() - 0.5) * noise * 0.6;

    this.battMv = Math.max(3300, this.battMv - dt * 0.02);
    this.snoozeLeft = Math.max(0, this.snoozeLeft - dt);

    this._updateState(pose, dt);
  }

  _updateState(pose, dt) {
    const lying = Math.abs(this.upper) > LYING_ANGLE;
    let state;
    if (this.scenario === 'sensor') state = STATE.SENSOR;
    else if (this.snoozeLeft > 0) state = STATE.SNOOZE;
    else if (lying) state = STATE.LYING;
    else if (pose.moving) state = STATE.MOVING;
    else if (this.alarm || this.curve > this.thr) state = STATE.SLOUCH;
    else state = STATE.OK;

    if (state === STATE.SLOUCH) {
      this.overFor += dt;
      if (!this.alarm && this.overFor >= this.delay) {
        this.alarm = true;
        this.alerts += 1;
      }
      // เตือนค้างจนกว่าค่าจะต่ำกว่าเกณฑ์ − 5°
      if (this.alarm && this.curve < this.thr - HYSTERESIS) {
        this.alarm = false;
        this.overFor = 0;
        state = STATE.OK;
      } else if (!this.alarm && this.curve <= this.thr) {
        this.overFor = 0;
        state = STATE.OK;
      }
    } else {
      this.alarm = false;
      this.overFor = 0;
    }

    if (state === STATE.OK) this.good += dt;
    if (state === STATE.SLOUCH) this.slouch += dt;
    this.state = state;
  }

  /** packet ปัจจุบันในรูป DataView */
  packet() {
    return encode({
      state: this.state,
      alarm: this.alarm,
      twoSensors: true,
      battOk: true,
      upper: clamp(this.upper, -180, 180),
      lower: clamp(this.lower, -180, 180),
      curve: clamp(this.curve, -180, 180),
      battMv: Math.round(this.battMv),
      good: Math.floor(this.good) & 0xffff,
      slouch: Math.floor(this.slouch) & 0xffff,
      alerts: this.alerts,
      thr: this.thr,
      delay: this.delay,
      snooze: Math.ceil(this.snoozeLeft),
    });
  }
}
