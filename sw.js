// Service worker: เก็บไฟล์ทั้งหมดไว้ตอนติดตั้ง เพื่อให้เปิดแอปได้แม้ไม่มีเน็ต
// ใช้เน็ตก่อนถ้ามี (เวอร์ชันใหม่ขึ้นทันทีหลัง deploy) ถ้าเน็ตช้าหรือไม่มีจะใช้ไฟล์ที่เก็บไว้
const CACHE = 'posture-alert-v2';
const NETWORK_TIMEOUT_MS = 3000;

const FILES = [
  './',
  'index.html',
  'manifest.webmanifest',
  'css/style.css',
  'js/app.js',
  'js/ble.js',
  'js/charts.js',
  'js/figure.js',
  'js/history.js',
  'js/protocol.js',
  'js/simulator.js',
  'js/util.js',
  'js/wifi.js',
  'icons/icon.svg',
  'icons/icon-180.png',
  'icons/icon-192.png',
  'icons/icon-512.png',
  'icons/icon-maskable-512.png',
  'fonts/ibm-plex-sans-thai-thai-400-normal.woff2',
  'fonts/ibm-plex-sans-thai-thai-500-normal.woff2',
  'fonts/ibm-plex-sans-thai-thai-600-normal.woff2',
  'fonts/ibm-plex-sans-thai-thai-700-normal.woff2',
  'fonts/ibm-plex-sans-thai-latin-400-normal.woff2',
  'fonts/ibm-plex-sans-thai-latin-500-normal.woff2',
  'fonts/ibm-plex-sans-thai-latin-600-normal.woff2',
  'fonts/ibm-plex-sans-thai-latin-700-normal.woff2',
];

self.addEventListener('install', event => {
  event.waitUntil((async () => {
    const cache = await caches.open(CACHE);
    await cache.addAll(FILES.map(f => new Request(f, { cache: 'reload' })));
    await self.skipWaiting();
  })());
});

self.addEventListener('activate', event => {
  event.waitUntil((async () => {
    const names = await caches.keys();
    await Promise.all(names.filter(n => n !== CACHE).map(n => caches.delete(n)));
    await self.clients.claim();
  })());
});

const fromCache = async request => {
  const cache = await caches.open(CACHE);
  const hit = await cache.match(request, { ignoreSearch: true });
  if (hit) return hit;
  if (request.mode === 'navigate') return cache.match('index.html');
  return undefined;
};

self.addEventListener('fetch', event => {
  const { request } = event;
  if (request.method !== 'GET' || new URL(request.url).origin !== self.location.origin) return;

  event.respondWith((async () => {
    const network = fetch(request).then(async response => {
      if (response.ok) {
        const cache = await caches.open(CACHE);
        await cache.put(request, response.clone());
      }
      return response;
    });
    // ปล่อยให้ network ทำงานต่อเบื้องหลังเพื่ออัปเดตไฟล์ แม้จะตอบจากไฟล์ที่เก็บไว้ไปแล้ว
    event.waitUntil(network.then(() => {}, () => {}));

    const timeout = new Promise(resolve => setTimeout(resolve, NETWORK_TIMEOUT_MS, 'timeout'));
    let result;
    try {
      result = await Promise.race([network, timeout]);
    } catch {
      result = 'failed';
    }
    if (result !== 'timeout' && result !== 'failed') return result;

    const cached = await fromCache(request);
    if (cached) return cached;
    return network;
  })());
});

// แตะการแจ้งเตือนแล้วกลับเข้าแอป
self.addEventListener('notificationclick', event => {
  event.notification.close();
  event.waitUntil((async () => {
    const windows = await self.clients.matchAll({ type: 'window', includeUncontrolled: true });
    if (windows.length) return windows[0].focus();
    return self.clients.openWindow('./');
  })());
});
