// Renders the NABA storyboard with headless Chromium.
//   node render.mjs stills <dir> <t1,t2,...> [width] [suffix]   -> PNG frames at given times
//   node render.mjs video <out.mp4> [width] [fps]                -> silent MP4
// Set CLEAN=1 to hide captions and titles (start frames for image-to-video).
import { createRequire } from 'node:module';
const { chromium } = createRequire(import.meta.url)('playwright');   // pre-installed globally
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const root = path.dirname(fileURLToPath(import.meta.url));
const [mode, out, a3, a4, a5] = process.argv.slice(2);
const width = Number(mode === 'video' ? a3 : a4) || 1280, height = Math.round(width * 9 / 16);
const types = { '.html': 'text/html', '.js': 'text/javascript', '.mjs': 'text/javascript' };

const server = http.createServer((req, res) => {
  const file = path.join(root, decodeURIComponent(req.url.split('?')[0]));
  if (!file.startsWith(root) || !fs.existsSync(file) || fs.statSync(file).isDirectory()) { res.writeHead(404); return res.end(); }
  res.writeHead(200, { 'content-type': types[path.extname(file)] || 'application/octet-stream' });
  fs.createReadStream(file).pipe(res);
}).listen(0);
const port = server.address().port;

const browser = await chromium.launch({ args: ['--use-gl=angle', '--use-angle=swiftshader', '--enable-unsafe-swiftshader', '--ignore-gpu-blocklist'] });
const page = await browser.newPage({ viewport: { width, height }, deviceScaleFactor: 1 });
page.on('console', m => { if (m.type() === 'error') console.error('[page]', m.text()); });
page.on('pageerror', e => console.error('[page]', e.message));
await page.goto(`http://localhost:${port}/index.html${process.env.CLEAN ? '?clean=1' : ''}`);
await page.waitForFunction('window.READY === true', null, { timeout: 120000 });
const duration = await page.evaluate('window.DURATION');

if (mode === 'stills') {
  fs.mkdirSync(out, { recursive: true });
  for (const t of a3.split(',').map(Number)) {
    const t0 = Date.now();
    await page.evaluate(x => window.renderAt(x), t);
    const f = path.join(out, `t${String(t).padStart(4, '0')}${a5 || ''}.png`);
    await page.screenshot({ path: f });
    console.log(f, `${Date.now() - t0}ms`);
  }
} else {
  const fps = Number(a4) || 30, total = Math.round(duration * fps);
  const ff = spawn('ffmpeg', ['-y', '-loglevel', 'error', '-f', 'image2pipe', '-framerate', String(fps), '-c:v', 'mjpeg', '-i', '-',
    '-c:v', 'libx264', '-preset', 'slow', '-crf', '17', '-pix_fmt', 'yuv420p', '-movflags', '+faststart', out], { stdio: ['pipe', 'inherit', 'inherit'] });
  const t0 = Date.now();
  for (let i = 0; i < total; i++) {
    await page.evaluate(x => window.renderAt(x), i / fps);
    const buf = await page.screenshot({ type: 'jpeg', quality: 95 });
    if (!ff.stdin.write(buf)) await new Promise(r => ff.stdin.once('drain', r));
    if (i % 60 === 0) console.log(`frame ${i}/${total}  ${((Date.now() - t0) / 1000).toFixed(0)}s`);
  }
  ff.stdin.end();
  await new Promise(r => ff.on('close', r));
  console.log('wrote', out);
}
await browser.close();
server.close();
