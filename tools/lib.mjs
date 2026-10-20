// 渲染工具共用：静态服务 + 帧接收、浏览器启动、时间线读取
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

export const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
export const timeline = () => JSON.parse(fs.readFileSync(path.join(ROOT, 'timeline.json'), 'utf8'));
export const FFMPEG = process.env.FFMPEG_PATH || 'ffmpeg';
export const FFPROBE = process.env.FFPROBE_PATH || 'ffprobe';
const routes = new Map();
let routePort = 19000;
const pageErrors = new WeakMap();

const MIME = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.mjs': 'text/javascript; charset=utf-8', '.json': 'application/json; charset=utf-8', '.css': 'text/css; charset=utf-8', '.woff2': 'font/woff2', '.woff': 'font/woff', '.wav': 'audio/wav', '.png': 'image/png' };

export function parseArgs(argv = process.argv.slice(2)) {
  const out = { _: [] };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a.startsWith('--')) {
      const k = a.slice(2);
      const v = argv[i + 1] && !argv[i + 1].startsWith('--') ? argv[++i] : true;
      out[k] = v;
    } else out._.push(a);
  }
  return out;
}

// onFrame(i, buffer) -> Promise，返回后才回应页面，形成背压
export function startServer(port, onFrame) {
  // All asset requests stay in Playwright when local HTTP sockets are unavailable.
  if (process.env.FILM_TRANSPORT === 'route') {
    const p = port || routePort++;
    if (routes.has(p)) throw new Error(`route port already in use: ${p}`);
    routes.set(p, onFrame);
    return Promise.resolve({ address: () => ({ port: p }), close: () => routes.delete(p) });
  }
  const server = http.createServer((req, res) => {
    const url = new URL(req.url, 'http://x');
    if (req.method === 'POST' && url.pathname === '/frame') {
      const chunks = [];
      req.on('data', (c) => chunks.push(c));
      req.on('end', async () => {
        try { await onFrame(parseInt(url.searchParams.get('i'), 10), Buffer.concat(chunks)); res.writeHead(200); res.end('ok'); }
        catch (e) { console.error(e); res.writeHead(500); res.end(String(e)); }
      });
      return;
    }
    const f = path.join(ROOT, decodeURIComponent(url.pathname === '/' ? '/index.html' : url.pathname));
    if (!f.startsWith(ROOT + path.sep)) { res.writeHead(403); res.end(); return; }
    fs.readFile(f, (e, d) => {
      if (e) { res.writeHead(404); res.end(); return; }
      res.writeHead(200, { 'Content-Type': MIME[path.extname(f)] || 'application/octet-stream', 'Cache-Control': 'no-store' });
      res.end(d);
    });
  });
  return new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(port, '127.0.0.1', () => resolve(server));
  });
}

export async function launch({ width, height }) {
  const { chromium } = await import('playwright');
  const gpuArgs = process.env.FILM_GPU === '1' ? [] : ['--use-gl=angle', '--use-angle=swiftshader', '--enable-unsafe-swiftshader'];
  const browser = await chromium.launch({
    executablePath: process.env.CHROMIUM_EXECUTABLE_PATH || undefined,
    args: [...gpuArgs, '--ignore-gpu-blocklist', '--disable-gpu-watchdog', '--disable-background-timer-throttling', '--disable-renderer-backgrounding'],
  });
  const page = await browser.newPage({ viewport: { width, height }, deviceScaleFactor: 1 });
  page.on('console', (m) => { const t = m.text(); if (m.type() === 'error' || m.type() === 'warning' || t.startsWith('[')) console.log(`  [page:${m.type()}] ${t}`); });
  pageErrors.set(page, []);
  page.on('pageerror', (e) => { pageErrors.get(page).push(e); console.error('  [pageerror]', e.message); });
  return { browser, page };
}

export async function openFilm(page, port, query) {
  if (routes.has(port)) {
    await page.route(`http://127.0.0.1:${port}/**`, async (route) => {
      const req = route.request(), url = new URL(req.url());
      try {
        if (req.method() === 'POST' && url.pathname === '/frame') {
          await routes.get(port)(Number(url.searchParams.get('i')), req.postDataBuffer());
          return await route.fulfill({ status: 200, body: 'ok' });
        }
        const f = path.join(ROOT, decodeURIComponent(url.pathname === '/' ? '/index.html' : url.pathname));
        if (!f.startsWith(ROOT + path.sep)) return await route.fulfill({ status: 403 });
        const body = await fs.promises.readFile(f);
        await route.fulfill({ status: 200, contentType: MIME[path.extname(f)] || 'application/octet-stream', body });
      } catch (e) {
        await route.fulfill({ status: e.code === 'ENOENT' ? 404 : 500, body: String(e) });
      }
    });
  }
  await page.goto(`http://127.0.0.1:${port}/index.html?${query}`);
  const deadline = Date.now() + 120000;
  while (!(await page.evaluate(() => Boolean(window.FILM?.ready)))) {
    if (pageErrors.get(page)?.length) throw pageErrors.get(page)[0];
    if (Date.now() > deadline) throw new Error('film initialization timed out');
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
}

export const fmt = (s) => { s = Math.max(0, Math.round(s)); const h = Math.floor(s / 3600), m = Math.floor((s % 3600) / 60), x = s % 60; return `${h ? h + 'h' : ''}${m}m${String(x).padStart(2, '0')}s`; };

