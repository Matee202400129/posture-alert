// เซิร์ฟเวอร์เล็ก ๆ สำหรับรันในเครื่อง ไม่ต้องติดตั้งอะไรเพิ่ม: npm start
import { createServer } from 'node:http';
import { readFile, stat } from 'node:fs/promises';
import { extname, join, normalize, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = resolve(fileURLToPath(new URL('..', import.meta.url)));
const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.woff2': 'font/woff2',
  '.webmanifest': 'application/manifest+json',
  '.txt': 'text/plain; charset=utf-8',
};

// prefix ใช้จำลอง path ของ GitHub Pages เช่น /posture-alert/ นอก path นี้จะได้ 404 เหมือนของจริง
export const startServer = (port = 8000, { prefix = '/' } = {}) => new Promise((resolvePromise, reject) => {
  const server = createServer(async (req, res) => {
    try {
      const path = decodeURIComponent(new URL(req.url, 'http://x').pathname);
      if (!path.startsWith(prefix)) {
        res.writeHead(404).end('Not found');
        return;
      }
      let file = normalize(join(ROOT, path.slice(prefix.length)));
      if (file !== ROOT && !file.startsWith(ROOT + sep)) {
        res.writeHead(403).end();
        return;
      }
      if ((await stat(file)).isDirectory()) file = join(file, 'index.html');
      const body = await readFile(file);
      res.writeHead(200, { 'Content-Type': MIME[extname(file)] || 'application/octet-stream', 'Cache-Control': 'no-cache' });
      res.end(body);
    } catch {
      res.writeHead(404).end('Not found');
    }
  });
  server.once('error', reject);
  // ผูกกับ localhost เท่านั้น: Web Bluetooth ใช้งานได้บน localhost โดยไม่ต้องมี HTTPS
  server.listen(port, '127.0.0.1', () => resolvePromise(server));
});

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const port = Number(process.env.PORT) || 8000;
  await startServer(port);
  console.log(`เปิดเว็บแอปได้ที่ http://localhost:${port}`);
}
