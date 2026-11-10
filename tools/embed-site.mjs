// แปลงไฟล์หน้าเว็บเป็น posture_v5/web_assets.h เพื่อเก็บไว้ในบอร์ด: node tools/embed-site.mjs
// ต้องรันใหม่ทุกครั้งที่แก้หน้าเว็บ แล้วอัปโหลดเฟิร์มแวร์อีกครั้ง
import { readFile, writeFile } from 'node:fs/promises';
import { extname } from 'node:path';
import { gzipSync } from 'node:zlib';

const root = new URL('../', import.meta.url);
const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.woff2': 'font/woff2',
  '.webmanifest': 'application/manifest+json',
};
// ไอคอนใหญ่ไม่จำเป็นต่อการใช้งานบนบอร์ด จึงตัดออกเพื่อประหยัดพื้นที่
const SKIP = new Set(['./', 'icons/icon-512.png', 'icons/icon-maskable-512.png']);

const sw = await readFile(new URL('sw.js', root), 'utf8');
const files = [...sw.match(/const FILES = \[([\s\S]*?)\];/)[1].matchAll(/'([^']+)'/g)].map(m => m[1]).filter(f => !SKIP.has(f));

const entries = [];
let chunks = '';
let total = 0;
for (const [i, file] of files.entries()) {
  let body = await readFile(new URL(file, root));
  if (file === 'index.html') {
    const html = body.toString('utf8');
    if (!html.includes('<head>')) throw new Error('index.html ไม่มี <head>');
    body = Buffer.from(html.replace('<head>', '<head>\n  <meta name="pa-device-hosted" content="1">'));
  }
  if (file === 'manifest.webmanifest') {
    // บนบอร์ดไม่มีไอคอนใหญ่ จึงอ้างเฉพาะไฟล์ที่มี
    const manifest = JSON.parse(body.toString('utf8'));
    manifest.icons = manifest.icons.filter(icon => !SKIP.has(icon.src));
    body = Buffer.from(JSON.stringify(manifest));
  }
  const type = MIME[extname(file)];
  if (!type) throw new Error(`ไม่รู้จักชนิดไฟล์: ${file}`);
  const compressible = !['.png', '.woff2'].includes(extname(file));
  const data = compressible ? gzipSync(body, { level: 9 }) : body;
  total += data.length;
  const bytes = [...data].map(b => `0x${b.toString(16).padStart(2, '0')}`);
  const lines = [];
  for (let n = 0; n < bytes.length; n += 24) lines.push(bytes.slice(n, n + 24).join(','));
  chunks += `const uint8_t ASSET_${i}[] PROGMEM = {\n${lines.join(',\n')}\n};\n`;
  entries.push(`  {"/${file}", "${type}", ASSET_${i}, ${data.length}, ${compressible}},`);
}

const header = `// สร้างอัตโนมัติด้วย tools/embed-site.mjs ห้ามแก้ไฟล์นี้เอง
#pragma once
#include <Arduino.h>

struct WebAsset {
  const char *path;
  const char *type;
  const uint8_t *data;
  size_t length;
  bool gzip;
};

${chunks}
const WebAsset WEB_ASSETS[] = {
${entries.join('\n')}
};
const size_t WEB_ASSET_COUNT = sizeof(WEB_ASSETS) / sizeof(WEB_ASSETS[0]);
`;
await writeFile(new URL('posture_v5/web_assets.h', root), header);
console.log(`${files.length} files, ${Math.round(total / 1024)} KB in flash`);
