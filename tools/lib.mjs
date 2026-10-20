// 渲染工具共用：静态服务 + 帧接收、浏览器启动、时间线读取
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright';

export const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
export const timeline = () => JSON.parse(fs.readFileSync(path.join(ROOT, 'timeline.json'), 'utf8'));

const MIME = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.mjs': 'text/javascript; charset=utf-8', '.json': 'application/json; charset=utf-8', '.css': 'text/css; charset=utf-8', '.woff2': 'font/woff2', '.woff': 'font/woff', '.wav': 'audio/wav', '.png': 'image/png' };

// 不带值的开关，避免把后面的参数（如时间点）当成它的值吃掉
const FLAGS = new Set(['gpu', 'headed', 'force', 'preview']);

export function parseArgs(argv = process.argv.slice(2)) {
  const out = { _: [] };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a.startsWith('--')) {
      const k = a.slice(2);
      const v = !FLAGS.has(k) && argv[i + 1] && !argv[i + 1].startsWith('--') ? argv[++i] : true;
      out[k] = v;
    } else out._.push(a);
  }
  return out;
}

// onFrame(i, buffer) -> Promise，返回后才回应页面，形成背压
export function startServer(port, onFrame) {
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
    // 完整版 Chromium（--gpu）会自动请求 favicon，回个空响应，免得日志里冒出 404
    if (url.pathname === '/favicon.ico') { res.writeHead(204); res.end(); return; }
    const f = path.join(ROOT, decodeURIComponent(url.pathname === '/' ? '/index.html' : url.pathname));
    if (!f.startsWith(ROOT)) { res.writeHead(403); res.end(); return; }
    fs.readFile(f, (e, d) => {
      if (e) { res.writeHead(404); res.end(); return; }
      res.writeHead(200, { 'Content-Type': MIME[path.extname(f)] || 'application/octet-stream', 'Cache-Control': 'no-store' });
      res.end(d);
    });
  });
  return new Promise((resolve) => server.listen(port, '127.0.0.1', () => resolve(server)));
}

// 默认用 SwiftShader 软件渲染（任何机器都能跑，含无显卡的云容器）；
// 带 --gpu 时用本机显卡（新版无头模式，Mac 上走 ANGLE/Metal，不弹窗口），快得多。
// 两种方式画面只差浮点舍入（全片抽样平均差约 1/255），但同一部片请用同一种方式渲完。--headed 显示浏览器窗口，排查用
export async function launch({ width, height, gpu = process.argv.includes('--gpu'), headed = process.argv.includes('--headed') }) {
  const common = ['--ignore-gpu-blocklist', '--disable-gpu-watchdog', '--disable-background-timer-throttling', '--disable-renderer-backgrounding', '--disable-backgrounding-occluded-windows'];
  const browser = await chromium.launch(gpu
    ? { channel: 'chromium', headless: !headed, args: [...common, '--enable-gpu', `--window-size=${width},${height + 120}`] }
    : { headless: !headed, args: ['--use-gl=angle', '--use-angle=swiftshader', '--enable-unsafe-swiftshader', ...common] });
  const page = await browser.newPage({ viewport: { width, height }, deviceScaleFactor: 1 });
  page.on('console', (m) => { const t = m.text(); if (m.type() === 'error' || m.type() === 'warning' || t.startsWith('[')) console.log(`  [page:${m.type()}] ${t}`); });
  page.on('pageerror', (e) => console.error('  [pageerror]', e.message));
  return { browser, page };
}

export async function openFilm(page, port, query) {
  await page.goto(`http://127.0.0.1:${port}/index.html?${query}`);
  await page.waitForFunction(() => window.FILM && window.FILM.ready, null, { timeout: 120000 });
}

export const fmt = (s) => { s = Math.max(0, Math.round(s)); const h = Math.floor(s / 3600), m = Math.floor((s % 3600) / 60), x = s % 60; return `${h ? h + 'h' : ''}${m}m${String(x).padStart(2, '0')}s`; };
