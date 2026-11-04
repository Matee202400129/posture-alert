// ทดสอบทุกหน้าจอในเบราว์เซอร์จริง (ใช้ Chrome ที่ติดตั้งในเครื่อง): npm run test:e2e
// อุปกรณ์จริงถูกแทนด้วย navigator.bluetooth จำลอง เพื่อให้ทดสอบเส้นทางของ Bluetooth ได้จนจบ
// ภาพหน้าจอเก็บไว้ที่ test-results/
import { mkdir } from 'node:fs/promises';
import { chromium } from 'playwright-core';
import { startServer } from '../../tools/serve.mjs';

const PORT = 8123;
// รันใต้ path ย่อยเหมือน GitHub Pages: ถ้ามี URL ที่ขึ้นต้นด้วย / จะพังตั้งแต่ตรงนี้
const SUBPATH = '/posture-alert/';
const BASE = `http://127.0.0.1:${PORT}${SUBPATH}`;
const SHOTS = new URL('../../test-results/', import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, '$1');

// โค้ดนี้รันในหน้าเว็บ ก่อนสคริปต์ของแอป
const mockBluetooth = () => {
  const makeTarget = () => {
    const map = new Map();
    return {
      addEventListener(t, f) { (map.get(t) || map.set(t, new Set()).get(t)).add(f); },
      removeEventListener(t, f) { map.get(t)?.delete(f); },
      emit(t, e) { for (const f of [...(map.get(t) || [])]) f(e); },
    };
  };
  const state = {
    device: null,
    writes: [],
    status: null,
    timer: null,
    mode: 'ok',        // ok | notfound | adapter | cancel
    silent: false,
    ignoreThr: false,
    values: { state: 0, flags: 0b110, upper: 12.5, lower: 2.5, curve: 10, batt: 3900, good: 100, slouch: 25, alerts: 2, thr: 15, delay: 3, snooze: 0 },
  };
  const packet = () => {
    const v = state.values;
    const dv = new DataView(new ArrayBuffer(20));
    dv.setUint8(0, v.state); dv.setUint8(1, v.flags);
    dv.setInt16(2, Math.round(v.upper * 10), true); dv.setInt16(4, Math.round(v.lower * 10), true); dv.setInt16(6, Math.round(v.curve * 10), true);
    dv.setUint16(8, v.batt, true); dv.setUint16(10, v.good, true); dv.setUint16(12, v.slouch, true); dv.setUint16(14, v.alerts, true);
    dv.setUint8(16, v.thr); dv.setUint8(17, v.delay); dv.setUint16(18, v.snooze, true);
    return dv;
  };
  const device = Object.assign(makeTarget(), { name: 'PostureAlert', gatt: { connected: false } });
  const stopTimer = () => { clearInterval(state.timer); state.timer = null; };
  const notify = () => {
    if (state.silent || !device.gatt.connected || !state.status) return;
    state.status.value = packet();
    state.status.emit('characteristicvaluechanged', { target: state.status });
  };
  device.gatt.connect = async () => {
    if (state.refuseConnect) throw Object.assign(new Error('fail'), { name: 'NetworkError' });
    device.gatt.connected = true;
    return {
      getPrimaryService: async () => ({
        getCharacteristic: async uuid => {
          if (uuid.startsWith('6e1f0002')) {
            const status = makeTarget();
            status.startNotifications = async () => {
              state.status = status;
              stopTimer();
              state.timer = setInterval(notify, 200);
            };
            // เฟิร์มแวร์เรียก setValue ครั้งแรกตอนส่ง notify ค่าที่อ่านทันทีหลังเชื่อมต่อจึงเป็นค่าว่าง
            status.readValue = async () => new DataView(new ArrayBuffer(0));
            return status;
          }
          const write = async data => {
            const text = new TextDecoder().decode(data);
            state.writes.push(text);
            const m = /^(thr|delay)=(\d+)$/.exec(text);
            if (m && !state.ignoreThr) state.values[m[1]] = Number(m[2]);
            if (text === 'reset') Object.assign(state.values, { good: 0, slouch: 0, alerts: 0 });
            if (text === 'snooze') state.values.snooze = state.values.snooze ? 0 : 1800;
            if (text === 'off') setTimeout(() => state.drop(), 10);
          };
          return { writeValueWithResponse: write, writeValueWithoutResponse: write };
        },
      }),
    };
  };
  device.gatt.disconnect = () => {
    if (!device.gatt.connected) return;
    device.gatt.connected = false;
    stopTimer();
    device.emit('gattserverdisconnected', {});
  };
  state.drop = () => device.gatt.disconnect();
  state.device = device;
  window.__ble = state;

  const bluetooth = {
    getAvailability: async () => {
      state.availabilityCalls = (state.availabilityCalls || 0) + 1;
      return state.mode !== 'adapter';
    },
    requestDevice: async opts => {
      state.requestOptions = JSON.parse(JSON.stringify(opts));
      // แอปต้องเรียก requestDevice ทันทีตอนกดปุ่ม ก่อนจะมี await ใด ๆ
      state.hadActivation = navigator.userActivation?.isActive ?? true;
      state.calledAvailabilityFirst = state.availabilityCalls > 0;
      if (state.mode === 'cancel') throw Object.assign(new Error('User cancelled the requestDevice() chooser.'), { name: 'NotFoundError' });
      if (state.mode === 'notfound' || state.mode === 'adapter') throw Object.assign(new Error('No devices found'), { name: 'NotFoundError' });
      return device;
    },
  };
  Object.defineProperty(navigator, 'bluetooth', { value: bluetooth, configurable: true });
};

const results = [];
const check = (name, ok, extra = '') => {
  results.push({ name, ok });
  console.log(`${ok ? 'ok  ' : 'FAIL'} ${name}${!ok && extra ? ` :: ${extra}` : ''}`);
};

const server = await startServer(PORT, { prefix: SUBPATH });
await mkdir(SHOTS, { recursive: true });
const browser = await chromium.launch({ channel: 'chrome', headless: true });

const consoleErrors = [];
const newPage = async ({ width = 390, height = 844, scheme = 'light', seen = true, bluetooth = true, context: ctx } = {}) => {
  const context = ctx || await browser.newContext({ viewport: { width, height }, colorScheme: scheme, hasTouch: width < 600, deviceScaleFactor: 2, locale: 'th-TH' });
  const page = await context.newPage();
  page.on('pageerror', e => consoleErrors.push(`pageerror: ${e.message}`));
  page.on('console', m => { if (m.type() === 'error') consoleErrors.push(`console: ${m.text()}`); });
  if (bluetooth) await page.addInitScript(mockBluetooth);
  if (seen) await page.addInitScript(() => localStorage.setItem('pa.wizardSeen', '1'));
  await page.goto(BASE);
  return { page, context };
};
const shot = (page, name, opts = {}) => page.screenshot({ path: `${SHOTS}${name}.png`, ...opts });
const text = (page, sel) => page.locator(sel).first().innerText();
const noHorizontalScroll = page => page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth);
const scenario = async (page, value) => page.selectOption('#scenario', value);

try {
  // ---------- โหมดตัวอย่าง ----------
  {
    const { page, context } = await newPage();
    check('เปิดมาเป็นโหมดตัวอย่าง', (await page.getAttribute('body', 'data-mode')) === 'demo');
    check('ติดป้ายข้อมูลจำลองชัดเจน', await page.locator('#linkChip', { hasText: 'ข้อมูลจำลอง' }).isVisible() && await page.locator('#hero .demo-tag').isVisible());
    await page.waitForFunction(() => document.getElementById('heroCurve').textContent !== '–');

    await scenario(page, 'upright');
    await page.waitForFunction(() => document.getElementById('heroState').textContent === 'นั่งตรง', null, { timeout: 15000 });
    check('นั่งตรง: สีเขียว', (await page.getAttribute('#hero', 'data-tone')) === 'ok');
    await page.waitForTimeout(1500);
    await shot(page, '01-live-ok-light', { fullPage: true });

    await scenario(page, 'slouch');
    await page.waitForFunction(() => document.getElementById('heroState').textContent === 'หลังค่อม', null, { timeout: 15000 });
    check('หลังค่อม: สีแดง', (await page.getAttribute('#hero', 'data-tone')) === 'bad');
    await page.waitForSelector('#alarmBand:not([hidden])', { timeout: 10000 });
    check('แสดงป้ายกำลังสั่นเตือน', await page.locator('#alarmBand').isVisible());
    await page.waitForTimeout(1000);
    await shot(page, '02-live-slouch-alarm', { fullPage: true });

    for (const [value, label, tone] of [['moving', 'กำลังขยับ', 'idle'], ['lying', 'นอน / ก้มมาก', 'idle'], ['sensor', 'เซนเซอร์มีปัญหา', 'warn']]) {
      await scenario(page, value);
      await page.waitForFunction(l => document.getElementById('heroState').textContent === l, label, { timeout: 15000 });
      check(`${label}: สี ${tone}`, (await page.getAttribute('#hero', 'data-tone')) === tone);
    }
    await shot(page, '03-live-sensor');

    await scenario(page, 'upright');
    await page.waitForFunction(() => document.getElementById('heroState').textContent === 'นั่งตรง', null, { timeout: 15000 });
    await page.click('#snoozeBtn');
    await page.waitForFunction(() => document.getElementById('heroState').textContent === 'พักเตือน');
    check('พักเตือน: สีเทา และปุ่มเปลี่ยนเป็นยกเลิก', (await page.getAttribute('#hero', 'data-tone')) === 'idle' && (await text(page, '#snoozeText')).includes('ยกเลิก'));
    await page.click('#snoozeBtn');
    await page.waitForFunction(() => document.getElementById('heroState').textContent === 'นั่งตรง');

    const curveBefore = await page.evaluate(() => document.querySelector('#figureLive .fig-spine').getAttribute('d'));
    await scenario(page, 'slouch');
    await page.waitForTimeout(2500);
    const curveAfter = await page.evaluate(() => document.querySelector('#figureLive .fig-spine').getAttribute('d'));
    check('ภาพหลังขยับตามค่า', curveBefore !== curveAfter);

    const chartPainted = await page.evaluate(() => {
      const c = document.getElementById('liveChart');
      const d = c.getContext('2d').getImageData(0, 0, c.width, c.height).data;
      for (let i = 3; i < d.length; i += 4) if (d[i] > 0) return true;
      return false;
    });
    check('กราฟสดวาดออกมา', chartPainted);

    // ปุ่มควบคุม
    await page.click('[data-action="cal"]');
    check('บันทึกท่าตรง: มีข้อความยืนยัน', (await text(page, '#toast')).includes('บันทึกท่าตรงแล้ว'));
    await page.click('[data-action="buzz"]');
    check('ทดสอบสั่น: มีข้อความยืนยัน', (await text(page, '#toast')).includes('สั่นทดสอบ'));

    await page.click('[data-action="off"]');
    check('ปิดเครื่อง: มีกล่องยืนยันในหน้าเว็บ', await page.locator('#confirmDialog[open]').isVisible());
    await shot(page, '04-confirm-off');
    await page.click('#confirmNo');
    check('กดยกเลิกแล้วกล่องปิด', !(await page.locator('#confirmDialog[open]').isVisible()));
    check('ไม่ใช้ confirm() ของเบราว์เซอร์', !(await page.evaluate(async () => (await (await fetch('js/app.js')).text()).match(/[^a-zA-Z.]confirm\(/))));

    // สถิติ
    await page.click('[data-tab="stats"]');
    await page.waitForSelector('#view-stats:not([hidden])');
    await page.waitForTimeout(300);
    check('สถิติ: แบต % แสดงเป็นตัวเลข', /^\d+%$/.test(await text(page, '#statBatt')));
    check('กราฟ 7 วันมีครบ 7 แท่ง', (await page.locator('#weekBars .bar').count()) === 7);
    check('สถิติจำลองติดป้ายและไม่มีปุ่มล้างประวัติ', await page.locator('#view-stats .demo-tag').isVisible() && !(await page.locator('#clearHistoryBtn').isVisible()));
    await page.locator('#weekBars .bar').nth(2).click();
    check('แตะแท่งแล้วเห็นรายละเอียด', (await text(page, '#weekDetail')).includes('นั่งตรง'));
    await page.locator('.week-table summary').click();
    await shot(page, '05-stats-light', { fullPage: true });
    check('ไม่มีข้อมูลจำลองไหลเข้า IndexedDB', await page.evaluate(() => new Promise(resolve => {
      const req = indexedDB.open('posture-alert', 1);
      req.onsuccess = () => {
        const r = req.result.transaction('days').objectStore('days').count();
        r.onsuccess = () => resolve(r.result === 0);
      };
    })));
    check('หน้าสถิติไม่เลื่อนแนวนอน', await noHorizontalScroll(page));

    // ตั้งค่า
    await page.click('[data-tab="settings"]');
    await page.waitForSelector('#view-settings:not([hidden])');
    await page.locator('#thrSlider').fill('22');
    await page.locator('#thrSlider').dispatchEvent('change');
    await page.waitForFunction(() => document.getElementById('thrReply').dataset.state === 'ok');
    check('สไลเดอร์เกณฑ์: แสดงค่าที่ตอบกลับ', (await text(page, '#thrReply')).includes('22° ตรงกับที่ตั้งไว้'));
    await page.locator('#delaySlider').fill('7');
    await page.locator('#delaySlider').dispatchEvent('change');
    await page.waitForFunction(() => document.getElementById('delayReply').dataset.state === 'ok');
    check('สไลเดอร์เวลาค้าง: แสดงค่าที่ตอบกลับ', (await text(page, '#delayReply')).includes('7 วินาที ตรงกับที่ตั้งไว้'));
    await shot(page, '06-settings-light', { fullPage: true });

    // ธีมมืด
    await page.selectOption('#themeSelect', 'dark');
    check('เลือกธีมมืดได้', (await page.evaluate(() => document.documentElement.dataset.theme)) === 'dark');
    await shot(page, '07-settings-dark', { fullPage: true });
    await page.click('[data-tab="stats"]');
    await page.waitForTimeout(300);
    await shot(page, '08-stats-dark', { fullPage: true });
    await page.click('[data-tab="live"]');
    await page.waitForTimeout(800);
    await shot(page, '09-live-dark', { fullPage: true });
    await page.reload();
    check('จำธีมหลังโหลดใหม่', (await page.evaluate(() => document.documentElement.dataset.theme)) === 'dark');
    await page.selectOption('#themeSelect', 'auto').catch(() => {});

    // ช่วยเหลือ
    await page.click('[data-tab="help"]');
    const helpText = await text(page, '#view-help');
    check('มีคำแนะนำ Bluefy', helpText.includes('Bluefy'));
    check('บอกข้อจำกัดเมื่อปิดหน้าจอ', helpText.includes('ไม่ได้รับข้อมูลเมื่อปิดหน้าจอ'));
    await shot(page, '10-help', { fullPage: true });

    // deep link และปุ่มย้อนกลับ
    await page.goBack();
    check('ปุ่มย้อนกลับของเบราว์เซอร์สลับหน้าได้', !(await page.locator('#view-help').isVisible()));
    await context.close();
  }

  // ---------- ขนาดปุ่ม และจอแคบ ----------
  {
    const { page, context } = await newPage({ width: 360, height: 740 });
    const small = async () => page.evaluate(() => [...document.querySelectorAll('button, a[href], select, input[type="range"]')]
      .filter(el => el.offsetParent !== null)
      .map(el => ({ el, box: el.getBoundingClientRect() }))
      .filter(({ box }) => box.height < 44 || box.width < 44)
      .map(({ el, box }) => `${el.id || el.textContent.trim().slice(0, 20)} ${Math.round(box.width)}x${Math.round(box.height)}`));
    for (const view of ['live', 'stats', 'settings', 'help']) {
      await page.click(`[data-tab="${view}"]`);
      await page.waitForTimeout(150);
      const tooSmall = await small();
      check(`หน้า ${view}: ปุ่มสูงกว้างอย่างน้อย 44px ที่ 360px`, tooSmall.length === 0, tooSmall.join(', '));
      check(`หน้า ${view}: ไม่เลื่อนแนวนอนที่ 360px`, await noHorizontalScroll(page));
      await shot(page, `11-360-${view}`, { fullPage: true });
    }
    await context.close();
  }

  // ---------- ตัวช่วยตั้งค่าครั้งแรก ----------
  {
    const { page, context } = await newPage({ seen: false });
    check('ครั้งแรกเปิดตัวช่วยเอง', await page.locator('#wizard[open]').isVisible());
    await page.waitForTimeout(400);
    await shot(page, '12-wizard-1');
    check('ขั้น 1 มีวิธีติดเซนเซอร์', (await text(page, '#wizard')).includes('5–10 ซม.'));
    await page.click('#wizardNext');
    await page.waitForTimeout(800);
    await shot(page, '13-wizard-2');
    await page.click('#wizardCal');
    await page.waitForSelector('#wizardCalDone:not([hidden])');
    check('ขั้น 2 บันทึกท่าตรงได้', true);
    await page.click('#wizardNext');
    await page.click('#wizardDemoSlouch');
    await page.waitForSelector('#wizardTryDone:not([hidden])', { timeout: 15000 });
    check('ขั้น 3 จับการค่อมได้', true);
    await shot(page, '14-wizard-3');
    await page.click('#wizardNext');
    check('กดเสร็จแล้วปิดตัวช่วย', !(await page.locator('#wizard[open]').isVisible()));
    await page.reload();
    check('เปิดครั้งถัดไปไม่เด้งขึ้นอีก', !(await page.locator('#wizard[open]').isVisible()));
    await context.close();
  }

  // ---------- โหมดนำเสนอ ----------
  {
    const { page, context } = await newPage({ width: 1280, height: 720 });
    await scenario(page, 'slouch');
    await page.waitForFunction(() => document.getElementById('heroState').textContent === 'หลังค่อม', null, { timeout: 15000 });
    await page.click('#presentBtn');
    await page.waitForSelector('#present:not([hidden])');
    await page.waitForSelector('#presentAlarm:not([hidden])', { timeout: 10000 });
    await page.waitForTimeout(1000);
    await shot(page, '15-present-landscape');
    check('โหมดนำเสนอ: แสดงสถานะ', (await text(page, '#presentState')) === 'หลังค่อม');
    check('โหมดนำเสนอ: ตัวเลขใหญ่', await page.evaluate(() => parseFloat(getComputedStyle(document.getElementById('presentCurve')).fontSize) > 120));
    check('โหมดนำเสนอ: ยังติดป้ายข้อมูลจำลอง', await page.locator('#present .demo-tag').isVisible());
    check('โหมดนำเสนอ: เต็มจอ', await page.evaluate(() => document.fullscreenElement?.id === 'present' || document.getElementById('present').getBoundingClientRect().width === window.innerWidth));
    await page.click('#presentClose');
    check('ออกจากโหมดนำเสนอได้', !(await page.locator('#present').isVisible()));
    await shot(page, '16-desktop-live', { fullPage: true });
    await context.close();
  }

  // ---------- เส้นทาง Bluetooth ----------
  {
    const { page, context } = await newPage();
    await page.evaluate(() => { window.__ble.mode = 'cancel'; });
    await page.click('#linkBtn');
    await page.waitForFunction(() => document.getElementById('linkBtnText').textContent === 'เชื่อมต่ออุปกรณ์');
    check('กดยกเลิกหน้าต่างเลือกอุปกรณ์: ไม่ขึ้นข้อผิดพลาด', !(await page.locator('#errorPanel').isVisible()));
    check('requestDevice ถูกเรียกทันทีจากการกดปุ่ม', await page.evaluate(() => window.__ble.hadActivation && !window.__ble.calledAvailabilityFirst));

    await page.evaluate(() => { window.__ble.mode = 'notfound'; });
    await page.click('#linkBtn');
    await page.waitForSelector('#errorPanel:not([hidden])');
    check('ไม่เจออุปกรณ์: แจ้งเป็นภาษาไทยพร้อมวิธีแก้', (await text(page, '#errorPanel')).includes('ไม่เจออุปกรณ์'));
    await shot(page, '17-error-notfound');

    await page.evaluate(() => { window.__ble.mode = 'adapter'; });
    await page.click('#linkBtn');
    await page.waitForFunction(() => document.getElementById('errorTitle').textContent.includes('Bluetooth'));
    check('ปิด Bluetooth อยู่: บอกให้เปิด', (await text(page, '#errorPanel')).includes('ยังไม่ได้เปิด Bluetooth'));

    await page.evaluate(() => { window.__ble.mode = 'ok'; });
    await page.click('#linkBtn');
    await page.waitForFunction(() => document.body.dataset.mode === 'ble');
    await page.waitForFunction(() => document.getElementById('linkChip').textContent === 'เชื่อมต่อแล้ว');
    check('เชื่อมต่อแล้ว: ซ่อนข้อผิดพลาด', !(await page.locator('#errorPanel').isVisible()));
    const options = await page.evaluate(() => window.__ble.requestOptions);
    check('requestDevice ใช้ตัวกรองตามเอกสาร', options.filters[0].name === 'PostureAlert' && options.optionalServices[0] === '6e1f0001-5b8a-4c2b-9d3e-7a1c2f4e8b10');
    check('เชื่อมต่อแล้ว: ไม่มีป้ายข้อมูลจำลอง', !(await page.locator('#hero .demo-tag').isVisible()) && !(await page.locator('#scenarioRow').isVisible()));
    await page.waitForFunction(() => document.getElementById('heroCurve').textContent === '10.0°');
    check('อ่านค่าแรกได้ค่าว่าง แล้วแสดงค่าจาก notify ถัดไป', true);
    await page.waitForTimeout(600);
    await shot(page, '18-ble-connected', { fullPage: true });

    // ทุกปุ่มส่งคำสั่งตรงตามเอกสาร
    await page.evaluate(() => { window.__ble.writes.length = 0; });
    await page.click('[data-action="cal"]');
    await page.click('[data-action="snooze"]');
    await page.waitForFunction(() => document.getElementById('snoozeBtn').getAttribute('aria-pressed') === 'true');
    await page.click('[data-action="snooze"]');
    await page.click('[data-action="buzz"]');
    await page.click('[data-action="reset"]');
    await page.click('#confirmYes');
    await page.waitForFunction(() => window.__ble.writes.includes('reset'));
    const writes = await page.evaluate(() => window.__ble.writes);
    check('คำสั่ง cal, snooze, buzz, reset ส่งถูกต้อง', JSON.stringify(writes) === JSON.stringify(['cal', 'snooze', 'snooze', 'buzz', 'reset']), JSON.stringify(writes));

    // ตั้งค่า: ส่งเมื่อปล่อย แสดงค่าที่อุปกรณ์ตอบ
    await page.evaluate(() => { window.__ble.writes.length = 0; });
    await page.click('[data-tab="settings"]');
    // ลากด้วยเมาส์จริง: กดค้าง เลื่อน รอหลาย packet แล้วค่อยปล่อย
    const sliderBox = await page.locator('#thrSlider').boundingBox();
    const sliderY = sliderBox.y + sliderBox.height / 2;
    await page.mouse.move(sliderBox.x + sliderBox.width * 0.3, sliderY);
    await page.mouse.down();
    await page.mouse.move(sliderBox.x + sliderBox.width * 0.45, sliderY, { steps: 4 });
    await page.mouse.move(sliderBox.x + sliderBox.width * 0.6, sliderY, { steps: 4 });
    const heldValue = await page.inputValue('#thrSlider');
    await page.waitForTimeout(700);
    check('ระหว่างลากยังไม่ส่งคำสั่ง', (await page.evaluate(() => window.__ble.writes.length)) === 0);
    check('ระหว่างลากค่าไม่กระโดดกลับ', (await page.inputValue('#thrSlider')) === heldValue && heldValue !== '15');
    await page.mouse.up();
    await page.waitForFunction(() => document.getElementById('thrReply').dataset.state === 'ok');
    check('ปล่อยแล้วส่งครั้งเดียว และแสดงค่าที่อุปกรณ์ยืนยัน',
      (await page.evaluate(() => window.__ble.writes.join())) === `thr=${heldValue}` && (await text(page, '#thrReply')).includes(`อุปกรณ์ตอบกลับ: ${heldValue}°`),
      await page.evaluate(() => window.__ble.writes.join()));

    await page.evaluate(() => { window.__ble.ignoreThr = true; });
    await page.locator('#delaySlider').fill('9');
    await page.locator('#delaySlider').dispatchEvent('change');
    await page.waitForFunction(() => document.getElementById('delayReply').dataset.state === 'error', null, { timeout: 8000 });
    check('อุปกรณ์ไม่เปลี่ยนค่า: แจ้งเตือนและสไลเดอร์กลับค่าเดิม', (await page.inputValue('#delaySlider')) === '3');
    await page.evaluate(() => { window.__ble.ignoreThr = false; });

    // ประวัติรายวันต้องเข้า IndexedDB
    await page.evaluate(() => { Object.assign(window.__ble.values, { good: 160, slouch: 40, alerts: 4 }); });
    await page.waitForTimeout(400);
    await page.click('[data-tab="stats"]');
    await page.waitForTimeout(300);
    check('สถิติแบตและเปอร์เซ็นต์จาก packet', (await text(page, '#statBatt')) === '65%' && (await text(page, '#statPct')) === '80%', `${await text(page, '#statBatt')} ${await text(page, '#statPct')}`);
    // ก่อนหน้านี้กด reset ไปแล้ว: ยอดก่อนล้าง (100, 25, 2) ต้องไม่หาย จึงรวมกับยอดใหม่ (160, 40, 4)
    check('ล้างสถิติในอุปกรณ์แล้วประวัติรายวันไม่หาย', (await text(page, '#weekDetail')).includes('เตือน 6 ครั้ง'), await text(page, '#weekDetail'));
    check('เชื่อมต่อจริงมีปุ่มล้างประวัติ', await page.locator('#clearHistoryBtn').isVisible());
    await shot(page, '19-ble-stats', { fullPage: true });

    // ใช้เซนเซอร์ตัวเดียว: เกณฑ์จริงสูงกว่าค่าที่ตั้ง 5° ตามเฟิร์มแวร์
    await page.evaluate(() => { window.__ble.values.flags = 0b100; });
    await page.click('[data-tab="live"]');
    await page.waitForSelector('#sensorNote:not([hidden])');
    check('เซนเซอร์ตัวเดียว: แจ้งผู้ใช้ และเกณฑ์เพิ่ม 5°', (await text(page, '#heroThr')) === `เกณฑ์เตือน ${Number(heldValue) + 5}°`, await text(page, '#heroThr'));
    check('เซนเซอร์ตัวเดียว: ไม่แสดงค่าตัวล่าง', await page.evaluate(() => [...document.querySelectorAll('#figureLive .fig-label')].some(n => n.textContent === 'ล่าง –')));
    await page.evaluate(() => { window.__ble.values.flags = 0b110; });
    await page.waitForFunction(() => document.getElementById('sensorNote').hidden);

    // สั่นเตือน + การแจ้งเตือนบนมือถือ
    await page.evaluate(() => {
      window.__vibrated = 0;
      navigator.vibrate = () => { window.__vibrated += 1; return true; };
      localStorage.setItem('pa.vibrate', '1');
    });
    await page.evaluate(() => { Object.assign(window.__ble.values, { state: 1, flags: 0b111, curve: 25, upper: 28, lower: 3 }); });
    await page.click('[data-tab="live"]');
    await page.waitForSelector('#alarmBand:not([hidden])');
    await page.waitForTimeout(700);
    check('เริ่มเตือน: สั่นมือถือครั้งเดียว ไม่สั่นซ้ำทุก packet', (await page.evaluate(() => window.__vibrated)) === 1);
    await page.evaluate(() => { Object.assign(window.__ble.values, { state: 0, flags: 0b110, curve: 5, upper: 7, lower: 2 }); });
    await page.waitForFunction(() => document.getElementById('alarmBand').hidden);

    // ไม่มี notify เข้ามา
    await page.evaluate(() => { window.__ble.silent = true; });
    await page.waitForFunction(() => document.getElementById('linkChip').textContent === 'ไม่มีข้อมูลใหม่', null, { timeout: 6000 });
    check('ไม่มี notify: แจ้งว่าไม่มีข้อมูลใหม่ และหน้าจอเป็นสีเทา', (await page.getAttribute('#hero', 'data-tone')) === 'idle');
    await page.evaluate(() => { window.__ble.silent = false; });
    await page.waitForFunction(() => document.getElementById('linkChip').textContent === 'เชื่อมต่อแล้ว');

    // สัญญาณหลุด ต้องเชื่อมต่อใหม่เอง และห้ามกลับไปใช้ข้อมูลจำลอง
    await page.evaluate(() => { window.__ble.refuseConnect = true; window.__ble.drop(); });
    await page.waitForFunction(() => document.getElementById('linkChip').textContent === 'สัญญาณหลุด');
    check('สัญญาณหลุด: หน้าจอเปลี่ยนเป็นสีเทาทันที ไม่ค้างสีเดิม', (await page.getAttribute('#hero', 'data-tone')) === 'idle' && (await text(page, '#heroState')).startsWith('ค่าล่าสุด'), await text(page, '#heroState'));
    check('สัญญาณหลุด: ไม่สลับเป็นข้อมูลจำลอง', (await page.getAttribute('body', 'data-mode')) === 'ble');
    check('สัญญาณหลุด: ปุ่มควบคุมกดไม่ได้', await page.locator('[data-action="cal"]').isDisabled());
    await page.waitForTimeout(300);
    await shot(page, '20-ble-reconnecting');
    await page.evaluate(() => { window.__ble.refuseConnect = false; });
    await page.waitForFunction(() => document.getElementById('linkChip').textContent === 'เชื่อมต่อแล้ว', null, { timeout: 15000 });
    check('เชื่อมต่อใหม่อัตโนมัติสำเร็จ', await page.locator('[data-action="cal"]').isEnabled());

    // ประวัติยังอยู่หลังเขียนลงเครื่องและโหลดหน้าใหม่
    await page.evaluate(() => new Promise(r => { document.dispatchEvent(new Event('visibilitychange')); window.dispatchEvent(new Event('pagehide')); setTimeout(r, 200); }));
    await page.waitForTimeout(200);
    const stored = await page.evaluate(() => new Promise(resolve => {
      const req = indexedDB.open('posture-alert', 1);
      req.onsuccess = () => {
        const r = req.result.transaction('days').objectStore('days').getAll();
        r.onsuccess = () => resolve(r.result);
      };
    }));
    check('บันทึกประวัติลง IndexedDB จริง', stored.length === 1 && stored[0].good === 260 && stored[0].slouch === 65 && stored[0].alerts === 6, JSON.stringify(stored));

    // ปิดเครื่อง
    await page.evaluate(() => { window.__ble.writes.length = 0; });
    await page.click('[data-action="off"]');
    check('ปิดเครื่อง: ยังไม่ส่งจนกว่าจะยืนยัน', (await page.evaluate(() => window.__ble.writes.length)) === 0);
    await page.click('#confirmYes');
    await page.waitForFunction(() => document.body.dataset.mode === 'demo');
    check('ปิดเครื่อง: ส่ง off แล้วกลับเป็นโหมดตัวอย่าง', (await page.evaluate(() => window.__ble.writes.join())) === 'off');
    check('ปิดเครื่องแล้วไม่พยายามเชื่อมต่อใหม่', await (async () => {
      await page.waitForTimeout(2500);
      return page.evaluate(() => !window.__ble.device.gatt.connected);
    })());
    await context.close();
  }

  // ---------- การแจ้งเตือนบนมือถือ ----------
  {
    const context = await browser.newContext({ viewport: { width: 390, height: 844 }, reducedMotion: 'reduce' });
    await context.grantPermissions(['notifications']);
    const { page } = await newPage({ context });
    await page.evaluate(() => navigator.serviceWorker.ready);
    await page.evaluate(() => {
      window.__notes = [];
      ServiceWorkerRegistration.prototype.showNotification = async function (title, options) { window.__notes.push({ title, ...options }); };
    });
    await scenario(page, 'slouch');
    await page.waitForSelector('#alarmBand:not([hidden])', { timeout: 15000 });
    check('ปิดการแจ้งเตือนไว้ (ค่าเริ่มต้น): ไม่แจ้ง', (await page.evaluate(() => window.__notes.length)) === 0);
    check('reduced motion: ไฟเตือนไม่กะพริบ', (await page.evaluate(() => getComputedStyle(document.getElementById('alarmBand')).animationName)) === 'none');

    await scenario(page, 'upright');
    await page.waitForFunction(() => document.getElementById('alarmBand').hidden, null, { timeout: 15000 });
    await page.click('[data-tab="settings"]');
    await page.check('#notifyToggle');
    await page.waitForFunction(() => document.getElementById('toast').textContent.includes('เปิดการแจ้งเตือนแล้ว'));
    await page.click('[data-tab="live"]');
    await scenario(page, 'slouch');
    await page.waitForFunction(() => window.__notes.length > 0, null, { timeout: 15000 });
    await page.waitForTimeout(1500);
    const notes = await page.evaluate(() => window.__notes);
    check('เปิดแล้ว: แจ้งผ่าน service worker ครั้งเดียว และบอกว่าเป็นข้อมูลจำลอง', notes.length === 1 && notes[0].title.includes('ข้อมูลจำลอง'), JSON.stringify(notes));
    await context.close();
  }

  // ---------- เบราว์เซอร์ไม่รองรับ ----------
  {
    const { page, context } = await newPage({ bluetooth: false });
    await page.evaluate(() => Object.defineProperty(navigator, 'bluetooth', { value: undefined, configurable: true }));
    await page.click('#linkBtn');
    await page.waitForSelector('#errorPanel:not([hidden])');
    check('เบราว์เซอร์ไม่รองรับ: แนะนำ Chrome / Edge', (await text(page, '#errorPanel')).includes('Chrome หรือ Edge'));
    await context.close();
  }

  // ---------- PWA และออฟไลน์ ----------
  {
    const context = await browser.newContext({ viewport: { width: 390, height: 844 } });
    const { page } = await newPage({ context });
    const manifest = await page.evaluate(async () => (await fetch(document.querySelector('link[rel=manifest]').href)).json());
    check('manifest ติดตั้งได้', manifest.display === 'standalone' && manifest.icons.some(i => i.sizes === '512x512') && manifest.icons.some(i => i.purpose === 'maskable'));
    await page.evaluate(() => navigator.serviceWorker.ready);
    await page.waitForFunction(() => navigator.serviceWorker.controller !== null, null, { timeout: 10000 }).catch(() => {});
    await page.waitForTimeout(500);
    server.closeAllConnections();
    await context.setOffline(true);
    await page.reload();
    await page.waitForFunction(() => document.getElementById('heroCurve').textContent !== '–', null, { timeout: 10000 });
    check('ไม่มีเน็ตก็เปิดแอปและใช้โหมดตัวอย่างได้', (await page.getAttribute('body', 'data-mode')) === 'demo');
    const fontOk = await page.evaluate(async () => {
      await document.fonts.ready;
      return document.fonts.check('600 16px "IBM Plex Sans Thai"', 'นั่งตรง');
    });
    check('ไม่มีเน็ตก็ยังใช้ฟอนต์ไทยได้', fontOk);
    await context.setOffline(false);
    await context.close();
  }
} catch (err) {
  check(`สคริปต์ทดสอบหยุดกลางทาง: ${err.message}`, false);
} finally {
  await browser.close();
  server.close();
  server.closeAllConnections?.();
}

const unexpected = consoleErrors.filter(e => !/ERR_INTERNET_DISCONNECTED|Failed to fetch/.test(e));
check('ไม่มี error ใน console', unexpected.length === 0, unexpected.slice(0, 5).join(' | '));

const failed = results.filter(r => !r.ok);
console.log(`\nผ่าน ${results.length - failed.length}/${results.length}`);
process.exit(failed.length ? 1 : 0);
