// โปรโตคอล Bluetooth ของ PostureAlert: ตรงกับเฟิร์มแวร์ในบอร์ด ห้ามแก้รูปแบบข้อมูล

export const DEVICE_NAME = 'PostureAlert';
export const SERVICE_UUID = '6e1f0001-5b8a-4c2b-9d3e-7a1c2f4e8b10';
export const STATUS_UUID = '6e1f0002-5b8a-4c2b-9d3e-7a1c2f4e8b10';
export const COMMAND_UUID = '6e1f0003-5b8a-4c2b-9d3e-7a1c2f4e8b10';

export const PACKET_SIZE = 20;

export const STATE = Object.freeze({ OK: 0, SLOUCH: 1, MOVING: 2, LYING: 3, SNOOZE: 4, SENSOR: 5 });

export const THR_RANGE = Object.freeze({ min: 5, max: 40 });
export const DELAY_RANGE = Object.freeze({ min: 1, max: 30 });

/** อ่าน Status packet ขนาด 20 ไบต์ คืน null ถ้าแพ็กเก็ตสั้นกว่าที่กำหนด */
export const parse = dv => {
  if (!dv || dv.byteLength < PACKET_SIZE) return null;
  return {
    state: dv.getUint8(0),
    alarm: !!(dv.getUint8(1) & 1), twoSensors: !!(dv.getUint8(1) & 2), battOk: !!(dv.getUint8(1) & 4),
    upper: dv.getInt16(2, true) / 10, lower: dv.getInt16(4, true) / 10, curve: dv.getInt16(6, true) / 10,
    battMv: dv.getUint16(8, true), good: dv.getUint16(10, true), slouch: dv.getUint16(12, true),
    alerts: dv.getUint16(14, true), thr: dv.getUint8(16), delay: dv.getUint8(17), snooze: dv.getUint16(18, true),
  };
};

/** สร้าง packet จากค่าต่าง ๆ: ใช้กับโหมดตัวอย่างและ unit test จึงผ่าน parse() เดียวกับของจริง */
export const encode = s => {
  const dv = new DataView(new ArrayBuffer(PACKET_SIZE));
  const flags = (s.alarm ? 1 : 0) | (s.twoSensors ? 2 : 0) | (s.battOk ? 4 : 0);
  dv.setUint8(0, s.state);
  dv.setUint8(1, flags);
  dv.setInt16(2, Math.round(s.upper * 10), true);
  dv.setInt16(4, Math.round(s.lower * 10), true);
  dv.setInt16(6, Math.round(s.curve * 10), true);
  dv.setUint16(8, s.battMv, true);
  dv.setUint16(10, s.good, true);
  dv.setUint16(12, s.slouch, true);
  dv.setUint16(14, s.alerts, true);
  dv.setUint8(16, s.thr);
  dv.setUint8(17, s.delay);
  dv.setUint16(18, s.snooze, true);
  return dv;
};

const BATT_TABLE = [
  [3300, 0], [3600, 10], [3700, 30], [3800, 50], [3900, 65], [4000, 80], [4100, 92], [4200, 100],
];

/** แปลงแรงดันแบต (mV) เป็น % แบบเส้นตรงระหว่างจุด คืน null ถ้าอ่านค่าไม่ได้ (0 mV) */
export const battPercent = mv => {
  if (!mv) return null;
  if (mv <= BATT_TABLE[0][0]) return 0;
  const last = BATT_TABLE[BATT_TABLE.length - 1];
  if (mv >= last[0]) return 100;
  for (let i = 1; i < BATT_TABLE.length; i++) {
    const [x1, y1] = BATT_TABLE[i];
    if (mv <= x1) {
      const [x0, y0] = BATT_TABLE[i - 1];
      return y0 + ((mv - x0) / (x1 - x0)) * (y1 - y0);
    }
  }
  return 100;
};

const inRange = (v, { min, max }) => Number.isInteger(v) && v >= min && v <= max;

export const CMD = Object.freeze({
  cal: 'cal',
  snooze: 'snooze',
  buzz: 'buzz',
  reset: 'reset',
  off: 'off',
  thr(v) {
    if (!inRange(v, THR_RANGE)) throw new RangeError(`thr out of range: ${v}`);
    return `thr=${v}`;
  },
  delay(v) {
    if (!inRange(v, DELAY_RANGE)) throw new RangeError(`delay out of range: ${v}`);
    return `delay=${v}`;
  },
});
