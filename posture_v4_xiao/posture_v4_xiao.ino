// อุปกรณ์เตือนหลังค่อม v4 (XIAO) - บอร์ด Seeed Studio XIAO ESP32C3 + เซนเซอร์ MPU6050 / MPU6500 1 หรือ 2 ตัว
//
// ผังขาของ XIAO (GPIO = เลขที่ใช้ในโค้ดนี้):
//   D4 = GPIO6 SDA   D5 = GPIO7 SCL   D10 = GPIO10 มอเตอร์สั่น
//   D1 = GPIO3 ปุ่ม   D2 = GPIO4 วัดแรงดันแบต (ตัวต้านทานแบ่งแรงดัน 100k/100k)
//   แบต: บัดกรีที่แผ่น BAT+ / BAT- ใต้บอร์ด (XIAO ชาร์จแบตให้เองผ่าน USB-C)
//   ต้องเสียบเสาอากาศที่ขั้วเล็กบนบอร์ด ไม่อย่างนั้น Bluetooth จะได้ระยะสั้นมาก
//
// สิ่งที่เพิ่มใน v4:
//  - Bluetooth (BLE) เว็บแอปบนมือถือเชื่อมต่อกับอุปกรณ์ชื่อ "PostureAlert"
//    แสดงท่านั่งแบบสด แบต และสถิติรอบการใช้งาน
//    และสั่งบันทึกท่าตรง พักเตือน ทดสอบมอเตอร์ ปรับความไว และปิดเครื่องได้
//  - ปรับเกณฑ์เตือนและเวลาค้างก่อนเตือนได้จากแอป ค่าจะบันทึกไว้ในหน่วยความจำแฟลช
//
// สิ่งที่เพิ่มใน v3.1:
//  - คุยกับเซนเซอร์ผ่าน I2C โดยตรง (ไม่ต้องใช้ไลบรารี Adafruit)
//    ใช้ได้กับ MPU6050 ของแท้ (WHO_AM_I 0x68) และชิปเลียนแบบ /
//    MPU6500 ที่ขายในชื่อ "MPU6050" (WHO_AM_I 0x70, 0x71, 0x72, 0x73, 0x98...)
//  - BATTERY_SENSE เปิดได้หลังจากบัดกรีตัวต้านทานแบ่งแรงดัน 100k/100k แล้วเท่านั้น
//    ไม่อย่างนั้นขาวัดแบต (D2) ที่ลอยอยู่อาจอ่านค่าได้เหมือนแบตหมด
//
// สิ่งที่เพิ่มใน v3:
//  - มุมรู้ทิศทาง ขั้น "โน้มตัวไปข้างหน้า" ที่ทำครั้งเดียว จะสอนอุปกรณ์
//    ว่าเซนเซอร์แต่ละตัวหันด้านไหนไปข้างหน้า มุมจึงมีเครื่องหมาย:
//      + = ก้มไปข้างหน้า, - = เอนไปข้างหลัง
//    แก้ปัญหาการนั่งไหลตัว (หลังบนค่อมไปหน้า เชิงกรานกลิ้งไปหลัง) ที่ v2
//    วัดได้น้อยกว่าจริง และไม่นับการเอียงซ้ายขวา
//  - ตรวจสุขภาพเซนเซอร์ จับได้เมื่อเซนเซอร์หยุดตอบ (สายหลวม)
//    ถ้าตัวล่างหลุดจะเปลี่ยนไปใช้โหมดเซนเซอร์ตัวเดียว ถ้าตัวบนหลุดจะเตือน
//    และกลับมาทำงานเองเมื่อต่อสายกลับคืน
//  - ทิศด้านหน้าบันทึกไว้ในแฟลช จึงต้องทำขั้นโน้มตัวแค่ครั้งเดียว
//    (หรือทำใหม่เมื่อติดเซนเซอร์ใหม่)
//
// ที่คงไว้จาก v2: หยุดเตือนตอนขยับตัว / นอน, เตือนแรงขึ้นเรื่อย ๆ, พักเตือน, ตรวจแบต,
// เข้าโหมดพักเครื่องอัตโนมัติ, สถิติรอบการใช้งาน
//
// ปุ่ม:    กด 1 ครั้ง        = เปิดเครื่อง (ตอนปิดอยู่) / บันทึกท่าตรงใหม่
//          กดเร็ว ๆ 3 ครั้ง  = ปิดเครื่อง (deep sleep กด 1 ครั้งเพื่อเปิด)
//          กดค้าง 1.5 วิ    = พักเตือน 30 นาที (กดค้างอีกครั้งเพื่อยกเลิก)
//          กดค้าง 5 วิ      = ตั้งค่าใหม่ทั้งหมด (บันทึกท่าตรง + โน้มตัวไปข้างหน้า)
//
// การต่อสาย:
//  MPU6050 #1 (หลังส่วนบน): SDA->GPIO6, SCL->GPIO7, AD0 ไม่ต่อ (0x68)
//  MPU6050 #2 (หลังส่วนล่าง): SDA/SCL/VCC/GND เดียวกับตัวบน, AD0 -> 3V3  (0x69)
//  วัดแบต:       BAT+ -> 100k -> GPIO4 (D2) -> 100k -> GND
//  ขับมอเตอร์:    GPIO10 -> 1k -> ขา base ของ S8050 (10k จาก base->GND)
//  ปุ่ม:         GPIO3 (D1) -> ปุ่ม -> GND

#include <Wire.h>
#include <Preferences.h>
#include <math.h>
#include "esp_sleep.h"
#include "driver/gpio.h"
#include <BLEDevice.h>
#include <BLEServer.h>
#include <BLE2902.h>

// ---------- ขา ----------
const int PIN_SDA    = 6;
const int PIN_SCL    = 7;
const int PIN_MOTOR  = 10;
const int PIN_BUTTON = 3;   // XIAO D1 และเป็นขาปลุกเครื่องจาก deep sleep ด้วย (ESP32-C3 ปลุกได้เฉพาะ GPIO0-5)
const int PIN_BATT   = 4;   // XIAO D2 (ADC)

// ---------- ค่าปรับแต่ง ----------
const float CURVE_DEG        = 15.0;  // เซนเซอร์ 2 ตัว: หลังบนโค้งมากกว่าหลังล่างเท่านี้ถือว่าค่อม
const float TILT_DEG         = 20.0;  // เซนเซอร์ตัวเดียว: เอียงไปหน้าจากท่าที่บันทึกไว้เท่านี้ถือว่าค่อม
const float LYING_DEG        = 60.0;  // เอียงเกินนี้ = นอนหรือก้มมาก -> หยุดเตือนชั่วคราว
const float MIN_LEAN_DEG     = 10.0;  // ขั้นโน้มตัวต้องทำให้เซนเซอร์ขยับอย่างน้อยเท่านี้
const float GYRO_MOVING_DPS  = 40.0;
const float ACC_MOVING_G     = 0.15;
const unsigned long MOTION_HOLD_MS  = 1000;
const unsigned long ALERT_DELAY_MS  = 3000;
const unsigned long ALARM_ON_MS     = 400;   // ตอนเตือน: สั่น 0.4 วิ หยุด 0.2 วิ ซ้ำไปจนกว่าจะนั่งตรง
const unsigned long ALARM_OFF_MS    = 200;
const float         ALARM_RELEASE_DEG = 5.0; // หยุดเตือนเมื่อค่ากลับมาต่ำกว่าเกณฑ์เท่านี้
const unsigned long REALERT_BASE_MS = 10000;
const unsigned long REALERT_MAX_MS  = 60000;
const unsigned long SNOOZE_MS       = 30UL * 60 * 1000;
const unsigned long SNOOZE_PRESS_MS = 1500;
const unsigned long SETUP_PRESS_MS  = 5000;
const unsigned long CLICK_GAP_MS    = 700;   // กดห่างกันน้อยกว่านี้ นับเป็นชุดเดียวกัน
const unsigned long LEAN_WAIT_MS    = 20000;
const unsigned long LYING_SLEEP_MS  = 10UL * 60 * 1000;
const unsigned long HEALTH_MS       = 1000;
const int           HEALTH_FAILS    = 3;
const unsigned long SENSOR_WARN_MS  = 30000;
const bool  BATTERY_SENSE  = true;    // แบต LiPo ต่อที่ BAT+/BAT- พร้อมตัวต้านทานแบ่งแรงดัน 100k/100k ที่ D2 (GPIO4)
const float BATT_LOW_V     = 3.50;
const float BATT_CUTOFF_V  = 3.30;
const float BATT_DIVIDER   = 2.0;
const float BATT_MIN_VALID = 2.50;
const float BATT_MAX_VALID = 4.50;
const unsigned long BATT_CHECK_MS = 30000;
const unsigned long BATT_WARN_MS  = 5UL * 60 * 1000;
const unsigned long SAMPLE_MS     = 50;
const float FILTER_ALPHA          = 0.2;

// ---------- Bluetooth ----------
// เว็บแอปค้นหาด้วย UUID ชุดนี้ตรงตัว - ถ้าจะเปลี่ยน ต้องเปลี่ยนทั้งสองฝั่งพร้อมกัน
#define BLE_NAME         "PostureAlert"
#define BLE_SERVICE_UUID "6e1f0001-5b8a-4c2b-9d3e-7a1c2f4e8b10"
#define BLE_STATUS_UUID  "6e1f0002-5b8a-4c2b-9d3e-7a1c2f4e8b10"  // notify, packet 20 ไบต์
#define BLE_CMD_UUID     "6e1f0003-5b8a-4c2b-9d3e-7a1c2f4e8b10"  // write, คำสั่งแบบข้อความ

// ค่าที่แอปเปลี่ยนได้ (เริ่มจากค่าตั้งต้นด้านบน และบันทึกไว้ในแฟลช)
float curveDeg = CURVE_DEG;
unsigned long alertDelayMs = ALERT_DELAY_MS;

// ---------- เซนเซอร์ ----------
struct Imu {
  const char *name;
  uint8_t addr;
  uint8_t who = 0;           // ค่า WHO_AM_I ที่อ่านได้ตอนเริ่มต้น
  bool present = false;      // เจอตอนเปิดเครื่อง
  bool ok = false;           // ตอนนี้ยังตอบอยู่
  int fails = 0;
  float g[3]    = {0, 0, 1}; // ทิศแรงโน้มถ่วงที่กรองแล้ว
  float ref[3]  = {0, 0, 1}; // ทิศแรงโน้มถ่วงตอนบันทึกท่าตรง
  float axis[3] = {1, 0, 0}; // แกนการก้มที่เรียนรู้จากขั้นโน้มตัว
  bool axisOk = false;
  float gyroDps = 0, accG = 1;
};
Imu upper, lower;
Preferences prefs;

BLECharacteristic *bleStatus = nullptr;
volatile bool bleConnected = false;
volatile bool bleCmdReady = false;
char bleCmd[24];

enum State { ST_OK, ST_SLOUCH, ST_MOVING, ST_LYING, ST_SNOOZE, ST_SENSOR };
const char *STATE_NAME[] = {"OK", "SLOUCH", "MOVING (paused)", "LYING (paused)", "SNOOZE", "SENSOR ERROR"};

// ---------- ฟังก์ชันช่วยคำนวณเวกเตอร์ ----------
float dot3(const float a[3], const float b[3]) { return a[0] * b[0] + a[1] * b[1] + a[2] * b[2]; }
float len3(const float a[3]) { return sqrtf(dot3(a, a)); }
void cross3(const float a[3], const float b[3], float out[3]) {
  out[0] = a[1] * b[2] - a[2] * b[1];
  out[1] = a[2] * b[0] - a[0] * b[2];
  out[2] = a[0] * b[1] - a[1] * b[0];
}
float angleBetween(const float a[3], const float b[3]) {
  float la = len3(a), lb = len3(b);
  if (la < 0.01f || lb < 0.01f) return 0;
  float c = dot3(a, b) / (la * lb);
  if (c > 1) c = 1;
  if (c < -1) c = -1;
  return acosf(c) * 180.0f / PI;
}


unsigned long lastSample = 0, lastPrint = 0, lastMotion = 0, lastStats = 0;
unsigned long badSince = 0, lastAlert = 0, snoozeUntil = 0, lyingSince = 0;
float battV = -1, battRaw = -1;
unsigned long lastBattCheck = 0, lastBattWarn = 0, lastHealth = 0, lastSensorWarn = 0;
unsigned long pressStart = 0;
bool pressSetupDone = false, pressSnoozeArmed = false;
int clickCount = 0;
unsigned long lastClickUp = 0;
int alertLevel = 0;
bool alarmOn = false;
unsigned long alarmStart = 0;
unsigned long msGood = 0, msSlouch = 0;
unsigned int alertsTotal = 0;

void vibrate(int times, int onMs, int offMs) {
  for (int i = 0; i < times; i++) {
    digitalWrite(PIN_MOTOR, HIGH);
    delay(onMs);
    digitalWrite(PIN_MOTOR, LOW);
    if (i < times - 1) delay(offMs);
  }
}

bool ping(uint8_t addr) {
  Wire.beginTransmission(addr);
  return Wire.endTransmission() == 0;
}

// ---- ไดรเวอร์ MPU6050 / MPU6500 แบบย่อ (คุยผ่าน I2C ตรง ๆ) ----
const uint8_t REG_SMPLRT_DIV   = 0x19;
const uint8_t REG_CONFIG       = 0x1A;
const uint8_t REG_GYRO_CONFIG  = 0x1B;
const uint8_t REG_ACCEL_CONFIG = 0x1C;
const uint8_t REG_ACCEL_CONF2  = 0x1D;   // มีเฉพาะตระกูล MPU6500
const uint8_t REG_ACCEL_XOUT_H = 0x3B;
const uint8_t REG_PWR_MGMT_1   = 0x6B;
const uint8_t REG_WHO_AM_I     = 0x75;

bool writeReg(uint8_t addr, uint8_t reg, uint8_t val) {
  Wire.beginTransmission(addr);
  Wire.write(reg);
  Wire.write(val);
  return Wire.endTransmission() == 0;
}

int readReg(uint8_t addr, uint8_t reg) {
  Wire.beginTransmission(addr);
  Wire.write(reg);
  if (Wire.endTransmission(false) != 0) return -1;
  if (Wire.requestFrom(addr, (uint8_t)1) != 1) return -1;
  return Wire.read();
}

// acc หน่วย m/s^2, gyroDps = ความเร็วการหมุนรวม หน่วยองศา/วินาที คืน false ถ้าอ่าน I2C ไม่สำเร็จ
bool readRaw(Imu &s, float acc[3], float &gyroDps) {
  Wire.beginTransmission(s.addr);
  Wire.write(REG_ACCEL_XOUT_H);
  if (Wire.endTransmission(false) != 0) return false;
  if (Wire.requestFrom(s.addr, (uint8_t)14) != 14) return false;
  int16_t v[7];
  for (int i = 0; i < 7; i++) {
    uint8_t hi = Wire.read(), lo = Wire.read();
    v[i] = (int16_t)((hi << 8) | lo);
  }
  const float ACC_SCALE  = 9.80665f / 16384.0f;  // ช่วง +-2 g
  const float GYRO_SCALE = 1.0f / 131.0f;        // ช่วง +-250 องศา/วินาที
  for (int i = 0; i < 3; i++) acc[i] = v[i] * ACC_SCALE;
  float gx = v[4] * GYRO_SCALE, gy = v[5] * GYRO_SCALE, gz = v[6] * GYRO_SCALE;
  gyroDps = sqrtf(gx * gx + gy * gy + gz * gz);
  return true;
}

bool initImu(Imu &s) {
  int who = readReg(s.addr, REG_WHO_AM_I);
  if (who <= 0 || who == 0xFF) return false;
  s.who = (uint8_t)who;
  writeReg(s.addr, REG_PWR_MGMT_1, 0x80);       // รีเซ็ตเซนเซอร์
  delay(100);
  if (!writeReg(s.addr, REG_PWR_MGMT_1, 0x01)) return false;  // ปลุกเซนเซอร์ ใช้สัญญาณนาฬิกาจากไจโร
  delay(10);
  writeReg(s.addr, REG_SMPLRT_DIV, 9);          // อ่าน 100 ครั้ง/วินาที
  writeReg(s.addr, REG_CONFIG, 0x04);           // กรองความถี่ต่ำผ่าน ~20 Hz
  writeReg(s.addr, REG_GYRO_CONFIG, 0x00);      // ช่วง +-250 องศา/วินาที
  writeReg(s.addr, REG_ACCEL_CONFIG, 0x00);     // ช่วง +-2 g
  if (s.who != 0x68) writeReg(s.addr, REG_ACCEL_CONF2, 0x04);  // กรองความถี่ต่ำผ่านของแอคเซล ~20 Hz
  delay(20);
  float acc[3], gd;
  if (!readRaw(s, acc, gd)) return false;
  for (int i = 0; i < 3; i++) s.g[i] = acc[i];
  s.fails = 0;
  return true;
}

void updateImu(Imu &s) {
  if (!s.ok) return;
  float acc[3];
  if (!readRaw(s, acc, s.gyroDps)) return;
  s.accG = len3(acc) / 9.80665f;
  for (int i = 0; i < 3; i++) s.g[i] += FILTER_ALPHA * (acc[i] - s.g[i]);
}

bool isMoving(const Imu &s) {
  return s.ok && (s.gyroDps > GYRO_MOVING_DPS || fabsf(s.accG - 1.0f) > ACC_MOVING_G);
}

// มุมก้มแบบมีเครื่องหมาย วัดจากท่าตรงที่บันทึกไว้ รอบแกนที่เรียนรู้จากขั้นโน้มตัว
// + = ไปข้างหน้า, - = ไปข้างหลัง ถ้ายังไม่ได้เรียนรู้แกน จะใช้มุมเอียงแบบไม่มีเครื่องหมายแทน
float forwardAngle(const Imu &s) {
  if (!s.axisOk) return angleBetween(s.g, s.ref);
  float gp[3], rp[3], c[3];
  float dg = dot3(s.g, s.axis), dr = dot3(s.ref, s.axis);
  for (int i = 0; i < 3; i++) {
    gp[i] = s.g[i] - dg * s.axis[i];
    rp[i] = s.ref[i] - dr * s.axis[i];
  }
  if (len3(gp) < 0.01f || len3(rp) < 0.01f) return 0;
  cross3(rp, gp, c);
  return atan2f(dot3(s.axis, c), dot3(rp, gp)) * 180.0f / PI;
}

void averageAccel(float outU[3], float outL[3]) {
  const int N = 20;
  for (int i = 0; i < 3; i++) outU[i] = outL[i] = 0;
  for (int n = 0; n < N; n++) {
    float acc[3], gd;
    if (upper.ok) { readRaw(upper, acc, gd); for (int i = 0; i < 3; i++) outU[i] += acc[i] / N; }
    if (lower.ok) { readRaw(lower, acc, gd); for (int i = 0; i < 3; i++) outL[i] += acc[i] / N; }
    delay(20);
  }
}

// ---------- บันทึกทิศด้านหน้า ----------
void saveAxes() {
  prefs.begin("posture", false);
  prefs.putBool("uok", upper.axisOk);
  prefs.putBytes("uax", upper.axis, sizeof(upper.axis));
  prefs.putBool("lok", lower.axisOk);
  prefs.putBytes("lax", lower.axis, sizeof(lower.axis));
  prefs.end();
}

void saveSettings() {
  prefs.begin("posture", false);
  prefs.putFloat("thr", curveDeg);
  prefs.putULong("dly", alertDelayMs);
  prefs.end();
}

void loadSettings() {
  prefs.begin("posture", true);
  curveDeg = prefs.getFloat("thr", CURVE_DEG);
  alertDelayMs = prefs.getULong("dly", ALERT_DELAY_MS);
  prefs.end();
}

void loadAxes() {
  prefs.begin("posture", true);
  upper.axisOk = prefs.getBool("uok", false);
  lower.axisOk = prefs.getBool("lok", false);
  if (upper.axisOk) prefs.getBytes("uax", upper.axis, sizeof(upper.axis));
  if (lower.axisOk) prefs.getBytes("lax", lower.axis, sizeof(lower.axis));
  prefs.end();
}

// ---------- บันทึกท่าตรง ----------
void calibrateUpright() {
  Serial.println("Calibrating... sit or stand straight");
  float u[3], l[3];
  averageAccel(u, l);
  for (int i = 0; i < 3; i++) {
    if (upper.ok) upper.ref[i] = upper.g[i] = u[i];
    if (lower.ok) lower.ref[i] = lower.g[i] = l[i];
  }
  badSince = 0; lastAlert = 0; alertLevel = 0; lyingSince = 0;
  alarmOn = false; digitalWrite(PIN_MOTOR, LOW);
  vibrate(2, 100, 100);
  Serial.println("Upright posture saved.");
}

void learnAxis(Imu &s, const float lean[3]) {
  if (!s.ok) return;
  float ang = angleBetween(s.ref, lean);
  if (ang < MIN_LEAN_DEG) {
    s.axisOk = false;
    Serial.printf("  %s: moved only %.1f deg - direction not learned (using unsigned angle)\n", s.name, ang);
    return;
  }
  float c[3];
  cross3(s.ref, lean, c);
  float l = len3(c);
  for (int i = 0; i < 3; i++) s.axis[i] = c[i] / l;
  s.axisOk = true;
  Serial.printf("  %s: forward direction learned (lean %.1f deg)\n", s.name, ang);
}

void learnForward() {
  Serial.println("Lean step: bend forward about 30 deg FROM THE HIPS (keep back straight),");
  Serial.println("then press the button. Waiting 20 s (no press = skip).");
  vibrate(1, 300, 0);
  unsigned long t0 = millis();
  bool pressed = false;
  while (millis() - t0 < LEAN_WAIT_MS) {
    if (digitalRead(PIN_BUTTON) == LOW) {
      delay(30);
      if (digitalRead(PIN_BUTTON) == LOW) { pressed = true; break; }
    }
    delay(10);
  }
  if (!pressed) {
    Serial.println("Lean step skipped - keeping previous setting.");
    return;
  }
  delay(300);  // รอให้ตัวนิ่งหลังกดปุ่ม
  float u[3], l[3];
  averageAccel(u, l);
  while (digitalRead(PIN_BUTTON) == LOW) delay(10);
  learnAxis(upper, u);
  learnAxis(lower, l);
  saveAxes();
  vibrate(2, 100, 100);
  Serial.println("Done. Return to upright posture.");
  lastMotion = millis();  // เว้นช่วงสั้น ๆ ไม่ให้เตือนทันที
}

void fullSetup() {
  calibrateUpright();
  learnForward();
}

// ---------- ตรวจสุขภาพเซนเซอร์ ----------
void checkHealth(Imu &s) {
  if (!s.present) return;
  if (ping(s.addr)) {
    if (!s.ok && initImu(s)) {
      s.ok = true;
      Serial.printf("%s sensor reconnected.\n", s.name);
      vibrate(1, 100, 0);
    }
    s.fails = 0;
  } else if (s.ok && ++s.fails >= HEALTH_FAILS) {
    s.ok = false;
    Serial.printf("!!! %s sensor not responding - check its wires\n", s.name);
    vibrate(5, 60, 60);
  }
}

// ---------- แบต / พักเครื่อง ----------
float readBattery() {
  if (!BATTERY_SENSE) return -1;
  uint32_t mv = 0;
  for (int i = 0; i < 8; i++) mv += analogReadMilliVolts(PIN_BATT);
  float v = (mv / 8.0f) / 1000.0f * BATT_DIVIDER;
  battRaw = v;
  return (v < BATT_MIN_VALID || v > BATT_MAX_VALID) ? -1 : v;
}

void printStats() {
  unsigned long total = msGood + msSlouch;
  int pct = total ? (int)(100.0f * msGood / total) : 100;
  Serial.printf("Session: good %lus, slouch %lus (%d%% good), alerts %u\n",
                msGood / 1000, msSlouch / 1000, pct, alertsTotal);
}

void goToSleep(const char *why) {
  Serial.printf("Going to sleep (%s). Press the button to wake.\n", why);
  vibrate(1, 600, 0);
  if (upper.ok) writeReg(upper.addr, REG_PWR_MGMT_1, 0x40);  // สั่งเซนเซอร์เข้าโหมดพัก
  if (lower.ok) writeReg(lower.addr, REG_PWR_MGMT_1, 0x40);
  digitalWrite(PIN_MOTOR, LOW);
  while (digitalRead(PIN_BUTTON) == LOW) delay(10);
  gpio_pullup_en((gpio_num_t)PIN_BUTTON);
  esp_deep_sleep_enable_gpio_wakeup(1ULL << PIN_BUTTON, ESP_GPIO_WAKEUP_GPIO_LOW);
  Serial.flush();
  esp_deep_sleep_start();
}

void toggleSnooze(unsigned long now) {
  if (now < snoozeUntil) { snoozeUntil = 0; Serial.println("Snooze cancelled."); vibrate(1, 150, 0); }
  else { snoozeUntil = now + SNOOZE_MS; Serial.println("Snoozed for 30 min."); vibrate(1, 500, 0); }
}

// ---------- ปุ่ม ----------
void handleButton(unsigned long now) {
  bool down = digitalRead(PIN_BUTTON) == LOW;
  // นับจำนวนการกดสั้น ๆ แล้วค่อยทำงานเมื่อหยุดกด:
  // 1 (หรือ 2) ครั้ง = บันทึกท่าตรงใหม่, 3 ครั้งขึ้นไป = ปิดเครื่อง
  if (!down && pressStart == 0 && clickCount > 0 && now - lastClickUp > CLICK_GAP_MS) {
    int n = clickCount;
    clickCount = 0;
    if (n >= 3) { printStats(); goToSleep("turned off by button (press once to turn on)"); }
    else calibrateUpright();
  }
  if (down && pressStart == 0) { pressStart = now; pressSetupDone = false; pressSnoozeArmed = false; }
  if (down && !pressSetupDone) {
    unsigned long held = now - pressStart;
    if (!pressSnoozeArmed && held >= SNOOZE_PRESS_MS) { pressSnoozeArmed = true; vibrate(1, 60, 0); }
    if (held >= SETUP_PRESS_MS) {
      pressSetupDone = true;
      clickCount = 0;
      vibrate(3, 60, 60);
      while (digitalRead(PIN_BUTTON) == LOW) delay(10);
      fullSetup();
      pressStart = 0;
      return;
    }
  }
  if (!down && pressStart != 0) {
    unsigned long held = now - pressStart;
    if (!pressSetupDone) {
      if (held >= SNOOZE_PRESS_MS) {
        toggleSnooze(now);
        clickCount = 0;
      } else if (held >= 30) {
        clickCount++;
        lastClickUp = now;
      }
    }
    pressStart = 0;
  }
}

// ---------- การเตือน ----------
void alert() {
  alertLevel++;
  alertsTotal++;
  Serial.printf(">>> ALERT #%d: straighten your back\n", alertLevel);
  if (alertLevel == 1)      vibrate(1, 300, 0);
  else if (alertLevel == 2) vibrate(2, 300, 200);
  else                      vibrate(3, 400, 200);
  lastAlert = millis();
}

// สั่งมอเตอร์ระหว่างที่กำลังเตือน (ไม่หยุดรอ ปุ่มจึงยังกดได้ตามปกติ)
void updateAlarm(unsigned long now) {
  if (!alarmOn) return;
  unsigned long phase = (now - alarmStart) % (ALARM_ON_MS + ALARM_OFF_MS);
  digitalWrite(PIN_MOTOR, phase < ALARM_ON_MS ? HIGH : LOW);
}

void stopAlarm() {
  if (!alarmOn) return;
  alarmOn = false;
  digitalWrite(PIN_MOTOR, LOW);
  Serial.println("Posture OK - alarm stopped.");
}

unsigned long realertInterval() {
  unsigned long ms = REALERT_BASE_MS << (alertLevel > 3 ? 3 : alertLevel - 1);
  return ms > REALERT_MAX_MS ? REALERT_MAX_MS : ms;
}

// ---------- Bluetooth ----------
class ServerCallbacks : public BLEServerCallbacks {
  void onConnect(BLEServer *s) override { bleConnected = true; }
  void onDisconnect(BLEServer *s) override {
    bleConnected = false;
    BLEDevice::startAdvertising();  // ประกาศตัวใหม่ ให้มือถือเชื่อมต่อกลับมาได้
  }
};

class CmdCallbacks : public BLECharacteristicCallbacks {
  // ทำงานใน task ของ Bluetooth: ตรงนี้แค่คัดลอกข้อความเก็บไว้ แล้วไปทำตามคำสั่งใน loop()
  void onWrite(BLECharacteristic *c) override {
    if (bleCmdReady) return;
    String v = c->getValue();
    strncpy(bleCmd, v.c_str(), sizeof(bleCmd) - 1);
    bleCmd[sizeof(bleCmd) - 1] = 0;
    bleCmdReady = true;
  }
};

void startBle() {
  BLEDevice::init(BLE_NAME);
  BLEServer *server = BLEDevice::createServer();
  server->setCallbacks(new ServerCallbacks());
  BLEService *svc = server->createService(BLE_SERVICE_UUID);
  bleStatus = svc->createCharacteristic(BLE_STATUS_UUID,
      BLECharacteristic::PROPERTY_READ | BLECharacteristic::PROPERTY_NOTIFY);
  bleStatus->addDescriptor(new BLE2902());
  BLECharacteristic *cmd = svc->createCharacteristic(BLE_CMD_UUID,
      BLECharacteristic::PROPERTY_WRITE | BLECharacteristic::PROPERTY_WRITE_NR);
  cmd->setCallbacks(new CmdCallbacks());
  svc->start();
  BLEAdvertising *adv = BLEDevice::getAdvertising();
  adv->addServiceUUID(BLE_SERVICE_UUID);
  adv->setScanResponse(true);
  BLEDevice::startAdvertising();
  Serial.println("Bluetooth ready: " BLE_NAME);
}

// คำสั่งจากแอป: cal, snooze, buzz, off, reset, thr=<องศา>, delay=<วินาที>
void handleBleCommand(unsigned long now) {
  if (!bleCmdReady) return;
  char c[sizeof(bleCmd)];
  strcpy(c, bleCmd);
  bleCmdReady = false;
  Serial.printf("App command: %s\n", c);
  if (!strcmp(c, "cal")) calibrateUpright();
  else if (!strcmp(c, "snooze")) toggleSnooze(now);
  else if (!strcmp(c, "buzz")) vibrate(2, 150, 100);
  else if (!strcmp(c, "reset")) { msGood = msSlouch = 0; alertsTotal = 0; }
  else if (!strcmp(c, "off")) { printStats(); goToSleep("turned off from the app (press the button to turn on)"); }
  else if (!strncmp(c, "thr=", 4)) {
    curveDeg = constrain(atof(c + 4), 5.0f, 40.0f);
    saveSettings();
    Serial.printf("Alert threshold now %.0f deg\n", curveDeg);
  } else if (!strncmp(c, "delay=", 6)) {
    alertDelayMs = (unsigned long)constrain(atoi(c + 6), 1, 30) * 1000UL;
    saveSettings();
    Serial.printf("Alert delay now %lu s\n", alertDelayMs / 1000);
  }
}

// packet สถานะ 20 ไบต์ (little endian) ที่แอปอ่าน:
//  0 u8 สถานะ   1 u8 ธง (1=กำลังเตือน, 2=ใช้เซนเซอร์ 2 ตัว, 4=อ่านแบตได้)
//  2 i16 มุมตัวบน x10   4 i16 มุมตัวล่าง x10   6 i16 ความโค้ง x10   8 u16 แรงดันแบต mV
// 10 u16 เวลานั่งตรง (วินาที)   12 u16 เวลาค่อม (วินาที)   14 u16 จำนวนครั้งที่เตือน
// 16 u8 เกณฑ์เตือน (องศา)   17 u8 เวลาค้างก่อนเตือน (วินาที)   18 u16 เวลาพักเตือนที่เหลือ (วินาที)
void sendBleStatus(State st, bool twoSensors, float u, float l, float c, unsigned long now) {
  if (!bleConnected || !bleStatus) return;
  uint8_t b[20];
  auto put16 = [&](int i, int v) { b[i] = v & 0xFF; b[i + 1] = (v >> 8) & 0xFF; };
  b[0] = (uint8_t)st;
  b[1] = (alarmOn ? 1 : 0) | (twoSensors ? 2 : 0) | (battV > 0 ? 4 : 0);
  put16(2, (int)lroundf(u * 10));
  put16(4, (int)lroundf(l * 10));
  put16(6, (int)lroundf(c * 10));
  put16(8, battV > 0 ? (int)(battV * 1000) : 0);
  put16(10, (int)min(msGood / 1000, 65535UL));
  put16(12, (int)min(msSlouch / 1000, 65535UL));
  put16(14, (int)min((unsigned long)alertsTotal, 65535UL));
  b[16] = (uint8_t)lroundf(curveDeg);
  b[17] = (uint8_t)(alertDelayMs / 1000);
  put16(18, now < snoozeUntil ? (int)min((snoozeUntil - now) / 1000, 65535UL) : 0);
  bleStatus->setValue(b, sizeof(b));
  bleStatus->notify();
}

// ---------- ส่วนหลัก ----------
void setup() {
  Serial.begin(115200);
#if ARDUINO_USB_CDC_ON_BOOT
  // ตอนเสียบ USB แต่ไม่ได้เปิด Serial Monitor การพิมพ์ข้อความจะทำให้ loop ค้าง
  // และกดปุ่มแล้วไม่ติด จึงให้ทิ้งข้อความไปเลยแทนการรอ
  Serial.setTxTimeoutMs(0);
#endif
  setCpuFrequencyMhz(80);
  pinMode(PIN_MOTOR, OUTPUT);
  digitalWrite(PIN_MOTOR, LOW);
  pinMode(PIN_BUTTON, INPUT_PULLUP);
  delay(300);

  upper.name = "Upper"; upper.addr = 0x68;
  lower.name = "Lower"; lower.addr = 0x69;
  Wire.begin(PIN_SDA, PIN_SCL);
  upper.present = upper.ok = initImu(upper);
  lower.present = lower.ok = initImu(lower);
  if (!upper.ok) {
    Serial.println("Upper MPU6050 (0x68) not found - check wiring");
    while (true) { vibrate(1, 50, 0); delay(950); }
  }
  Serial.printf("Upper sensor WHO_AM_I = 0x%02X\n", upper.who);
  if (lower.ok) Serial.printf("Lower sensor WHO_AM_I = 0x%02X\n", lower.who);
  Serial.println(lower.ok ? "Mode: 2 sensors (measures back curve)"
                          : "Mode: 1 sensor (lower sensor 0x69 not found)");
  loadAxes();
  loadSettings();
  startBle();
  delay(500);
  calibrateUpright();
  bool needLean = !upper.axisOk || (lower.ok && !lower.axisOk);
  if (needLean) learnForward();
  else Serial.println("Forward direction loaded from memory (hold button 5 s to redo).");
}

void loop() {
  unsigned long now = millis();
  handleButton(now);
  handleBleCommand(now);
  updateAlarm(now);

  if (now - lastHealth >= HEALTH_MS) {
    lastHealth = now;
    checkHealth(upper);
    checkHealth(lower);
  }

  if (now - lastBattCheck >= BATT_CHECK_MS || lastBattCheck == 0) {
    lastBattCheck = now;
    float v = readBattery();
    battV = v;
    if (v > 0 && v < BATT_CUTOFF_V) goToSleep("battery empty - please charge");
    if (v > 0 && v < BATT_LOW_V && now - lastBattWarn >= BATT_WARN_MS) {
      lastBattWarn = now;
      Serial.printf("Battery low: %.2f V\n", v);
      vibrate(4, 80, 80);
    }
  }

  if (now - lastSample < SAMPLE_MS) return;
  unsigned long dt = lastSample ? now - lastSample : 0;
  lastSample = now;

  updateImu(upper);
  updateImu(lower);

  bool twoSensors = upper.ok && lower.ok;
  float upperFwd  = upper.ok ? forwardAngle(upper) : 0;
  float lowerFwd  = lower.ok ? forwardAngle(lower) : 0;
  float curve     = upperFwd - lowerFwd;
  float upperTilt = upper.ok ? angleBetween(upper.g, upper.ref) : 0;
  float lowerTilt = lower.ok ? angleBetween(lower.g, lower.ref) : 0;

  if (isMoving(upper) || isMoving(lower)) lastMotion = now;
  bool moving  = lastMotion && now - lastMotion < MOTION_HOLD_MS;
  bool lying   = upperTilt > LYING_DEG || lowerTilt > LYING_DEG;
  bool snoozed = now < snoozeUntil;
  // ระหว่างที่กำลังเตือน ผู้ใช้ต้องยืดหลังกลับมามากกว่าเกณฑ์อีกนิด ถึงจะหยุดเตือน (กันการสั่นติด ๆ ดับ ๆ ตรงขอบเกณฑ์)
  float hyst   = alarmOn ? ALARM_RELEASE_DEG : 0;
  bool slouch  = twoSensors ? curve > curveDeg - hyst : upperFwd > curveDeg + (TILT_DEG - CURVE_DEG) - hyst;

  State st;
  if (!upper.ok)    st = ST_SENSOR;
  else if (lying)   st = ST_LYING;
  else if (snoozed) st = ST_SNOOZE;
  else if (slouch)  st = ST_SLOUCH;   // ตรวจหลังค่อมก่อนการขยับตัว การขยับจึงไม่ทำให้เตือนช้าลง
  else if (moving)  st = ST_MOVING;
  else              st = ST_OK;

  if (st == ST_SENSOR && now - lastSensorWarn >= SENSOR_WARN_MS) {
    lastSensorWarn = now;
    vibrate(5, 60, 60);
  }

  if (st == ST_LYING) {
    if (lyingSince == 0) lyingSince = now;
    if (now - lyingSince >= LYING_SLEEP_MS) { printStats(); goToSleep("lying flat for 10 min"); }
  } else {
    lyingSince = 0;
  }

  if (st == ST_SLOUCH) {
    msSlouch += dt;
    if (badSince == 0) badSince = now;
    if (!alarmOn && now - badSince >= alertDelayMs) {
      alarmOn = true;
      alarmStart = now;
      alertsTotal++;
      Serial.println(">>> ALERT: straighten your back (buzzing until fixed)");
    }
  } else {
    if (st == ST_OK) { msGood += dt; alertLevel = 0; }
    badSince = 0;
    stopAlarm();
  }

  if (now - lastPrint >= 500) {
    lastPrint = now;
    sendBleStatus(st, twoSensors, upperFwd, lowerFwd, curve, now);
    if (twoSensors)
      Serial.printf("upper %+6.1f | lower %+6.1f | curve %+6.1f deg | %s",
                    upperFwd, lowerFwd, curve, STATE_NAME[st]);
    else
      Serial.printf("upper %+6.1f deg | %s", upperFwd, STATE_NAME[st]);
    if (st == ST_SLOUCH) Serial.printf(" %.1fs", (now - badSince) / 1000.0f);
    if (battV > 0) {
      int pct = constrain((int)((battV - 3.3f) / (4.2f - 3.3f) * 100), 0, 100);
      Serial.printf(" | batt %.2fV %d%%", battV, pct);
    } else if (BATTERY_SENSE && battRaw >= 0) {
      Serial.printf(" | batt ?? D2 reads %.2fV (check wiring)", battRaw);
    }
    Serial.println();
    if (now - lastStats >= 10000) { lastStats = now; printStats(); }
  }
}
