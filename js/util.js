// ฟังก์ชันจัดรูปแบบที่ไม่ยุ่งกับหน้าจอ

const pad = n => String(n).padStart(2, '0');

/** คีย์วันตามเวลาเครื่อง (ไม่ใช้ toISOString เพราะเป็น UTC ไทยจะขึ้นวันใหม่ตอน 7 โมง) */
export const dateKey = (d = new Date()) => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;

/** คีย์ของ n วันล่าสุด เรียงจากเก่าไปใหม่ วันสุดท้ายคือวันนี้ */
export const lastNDays = (n, now = new Date()) => {
  const out = [];
  for (let i = n - 1; i >= 0; i--) {
    out.push(dateKey(new Date(now.getFullYear(), now.getMonth(), now.getDate() - i)));
  }
  return out;
};

const DAY_SHORT = ['อา.', 'จ.', 'อ.', 'พ.', 'พฤ.', 'ศ.', 'ส.'];
const DAY_FULL = ['วันอาทิตย์', 'วันจันทร์', 'วันอังคาร', 'วันพุธ', 'วันพฤหัสบดี', 'วันศุกร์', 'วันเสาร์'];

const keyToDate = key => {
  const [y, m, d] = key.split('-').map(Number);
  return new Date(y, m - 1, d);
};
export const dayShort = key => DAY_SHORT[keyToDate(key).getDay()];
export const dayFull = key => DAY_FULL[keyToDate(key).getDay()];

/** แสดงองศา 1 ตำแหน่ง ใช้เครื่องหมายลบจริง และไม่แสดง -0.0 */
export const fmtDeg = v => {
  if (v === null || v === undefined || Number.isNaN(v)) return '–';
  const s = Math.abs(v).toFixed(1);
  return `${v < 0 && s !== '0.0' ? '−' : ''}${s}°`;
};

/** เวลาแบบอ่านง่าย เช่น 45 วินาที, 12 นาที, 1 ชม. 5 นาที */
export const fmtDuration = sec => {
  const s = Math.max(0, Math.floor(sec || 0));
  if (s < 60) return `${s} วินาที`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m} นาที`;
  const h = Math.floor(m / 60);
  const rest = m % 60;
  return rest ? `${h} ชม. ${rest} นาที` : `${h} ชม.`;
};

/** นาฬิกานับถอยหลัง เช่น 29:05 */
export const fmtClock = sec => {
  const s = Math.max(0, Math.floor(sec || 0));
  return `${Math.floor(s / 60)}:${pad(s % 60)}`;
};

/** % เวลานั่งตรง คืน null ถ้ายังไม่มีข้อมูล */
export const goodPercent = (good, slouch) => {
  const total = good + slouch;
  return total > 0 ? Math.round((good / total) * 100) : null;
};
