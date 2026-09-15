import http from 'node:http';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { randomBytes, randomUUID } from 'node:crypto';
import { createReadStream, createWriteStream } from 'node:fs';
import { readFile, stat, mkdir, open as openFile, unlink } from 'node:fs/promises';
import { pipeline } from 'node:stream/promises';
import { Transform } from 'node:stream';
import { spawn } from 'node:child_process';
import { doctor, probe } from '../core/media.js';
import { Library, within } from './library.js';
import { Queue } from './queue.js';

const publicDir = fileURLToPath(new URL('../../public/', import.meta.url));
function json(res, status, body) { res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' }); res.end(JSON.stringify(body)); }
async function body(req) {
  let data = ''; for await (const chunk of req) { data += chunk; if (data.length > 65536) throw new Error('请求过大'); }
  return JSON.parse(data || '{}');
}
async function media(req, res, file) {
  const { size } = await stat(file); let start = 0, end = size - 1;
  const headers = { 'Content-Type': 'video/mp4', 'Accept-Ranges': 'bytes', 'Cache-Control': 'no-store' };
  if (req.headers.range) {
    const match = /^bytes=(\d*)-(\d*)$/.exec(req.headers.range);
    if (!match || (!match[1] && !match[2])) { res.writeHead(416, { 'Content-Range': `bytes */${size}` }); return res.end(); }
    start = match[1] ? Number(match[1]) : Math.max(0, size - Number(match[2]));
    end = match[1] && match[2] ? Math.min(size - 1, Number(match[2])) : size - 1;
    if (!Number.isSafeInteger(start) || !Number.isSafeInteger(end) || start > end || start >= size) { res.writeHead(416, { 'Content-Range': `bytes */${size}` }); return res.end(); }
    headers['Content-Range'] = `bytes ${start}-${end}/${size}`;
  }
  headers['Content-Length'] = end - start + 1;
  res.writeHead(req.headers.range ? 206 : 200, headers);
  await pipeline(createReadStream(file, { start, end }), res);
}
function openNative(target, reveal = false) {
  const command = process.platform === 'darwin' ? 'open' : process.platform === 'win32' ? 'explorer.exe' : 'xdg-open';
  const args = process.platform === 'darwin' && reveal ? ['-R', target] : [reveal ? path.dirname(target) : target];
  const child = spawn(command, args, { shell: false, stdio: 'ignore' }); child.on('error', () => {}); child.unref();
}
export async function serve({ inputDir, outputDir, port = 3000, open = true, dataDir = path.resolve('.grayscale') }) {
  if (!Number.isInteger(port) || port < 0 || port > 65535) throw new Error('端口必须为 0–65535 的整数');
  await mkdir(dataDir, { recursive: true, mode: 0o700 });
  const lockPath = path.join(dataDir, 'server.lock');
  let lock;
  try { lock = await openFile(lockPath, 'wx', 0o600); await lock.writeFile(String(process.pid)); }
  catch (error) {
    if (error.code !== 'EEXIST') throw error;
    const pid = Number(await readFile(lockPath, 'utf8'));
    let alive = true; try { process.kill(pid, 0); } catch (e) { if (e.code === 'ESRCH') alive = false; }
    if (alive) throw new Error('此项目已有服务运行，请使用已有页面或先停止服务');
    await unlink(lockPath); lock = await openFile(lockPath, 'wx', 0o600); await lock.writeFile(String(process.pid));
  }
  const release = async () => { await lock.close(); await unlink(lockPath).catch(() => {}); };
  const library = new Library(inputDir, outputDir, dataDir);
  let queue;
  try { await library.init(); queue = new Queue(library); await queue.init(); } catch (error) { await release(); throw error; }
  let token = randomBytes(32).toString('hex'); const session = randomBytes(32).toString('hex');
  const connections = new Set(); let origin;
  queue.on('update', state => { for (const res of connections) { if (res.writableLength > 1024 * 1024) res.destroy(); else res.write(`id: ${state.revision}\ndata: ${JSON.stringify(state)}\n\n`); } });
  const server = http.createServer(async (req, res) => {
    res.setHeader('X-Content-Type-Options', 'nosniff'); res.setHeader('Referrer-Policy', 'no-referrer');
    res.setHeader('Content-Security-Policy', "default-src 'self'; script-src 'self'; style-src 'self'; img-src 'self' data:; media-src 'self' blob:; connect-src 'self'; frame-ancestors 'none'; base-uri 'none'; form-action 'self'");
    try {
      if (req.headers.host !== new URL(origin).host || (req.headers.origin && req.headers.origin !== origin) || req.headers['sec-fetch-site'] === 'cross-site') return json(res, 403, { error: '拒绝非本地页面请求' });
      const url = new URL(req.url, origin), method = req.method;
      const authenticated = (req.headers.cookie || '').split(';').some(c => c.trim() === `gray_session=${session}`);
      if (url.pathname === '/api/session' && method === 'POST') {
        if (req.headers.origin !== origin) return json(res, 403, { error: '来源校验失败' });
        const value = await body(req);
        if (!authenticated && (!token || value.token !== token)) return json(res, 401, { error: '请使用终端中显示的启动链接打开页面' });
        token = null; res.setHeader('Set-Cookie', `gray_session=${session}; HttpOnly; SameSite=Strict; Path=/`); return json(res, 200, { ok: true });
      }
      if (url.pathname === '/favicon.ico' && method === 'GET') { res.writeHead(204); return res.end(); }
      const assets = { '/': ['index.html', 'text/html'], '/app.js': ['app.js', 'text/javascript'], '/style.css': ['style.css', 'text/css'] };
      if (assets[url.pathname] && method === 'GET') {
        const [file, type] = assets[url.pathname]; res.writeHead(200, { 'Content-Type': `${type}; charset=utf-8`, 'Cache-Control': 'no-cache' }); return res.end(await readFile(path.join(publicDir, file)));
      }
      if (!authenticated) return json(res, 401, { error: '会话已失效，请从终端启动链接重新打开' });
      if (method !== 'GET' && req.headers.origin !== origin) return json(res, 403, { error: '来源校验失败' });
      if (method === 'GET' && url.pathname === '/api/environment') return json(res, 200, { ...await doctor(), inputDir: library.inputDir, outputDir: library.outputDir });
      if (method === 'GET' && url.pathname === '/api/files') return json(res, 200, await library.list(url.searchParams.get('directoryId') || 'root'));
      if (method === 'GET' && url.pathname === '/api/jobs') return json(res, 200, queue.snapshot());
      if (method === 'GET' && url.pathname === '/api/events') {
        res.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache', Connection: 'keep-alive' });
        res.write(`data: ${JSON.stringify(queue.snapshot())}\n\n`); connections.add(res);
        const timer = setInterval(() => res.write(': heartbeat\n\n'), 15000); req.on('close', () => { clearInterval(timer); connections.delete(res); }); return;
      }
      if (method === 'GET' && url.pathname === '/api/imports') return json(res, 200, [...library.sources.values()].filter(s => s.imported).map(s => library.public(s)));
      if (method === 'POST' && url.pathname === '/api/imports') {
        const source = await library.prepareImport(url.searchParams.get('name'));
        try {
          let bytes = 0;
          const limiter = new Transform({ transform(chunk, encoding, callback) { bytes += chunk.length; callback(bytes > 100 * 1024 ** 3 ? new Error('单个导入最多 100 GiB，请使用目录直读') : null, chunk); } });
          await pipeline(req, limiter, createWriteStream(source.path, { flags: 'wx', mode: 0o600 }));
          source.size = bytes; await library.commitImport(source); return json(res, 201, library.public(source));
        } catch (error) { await library.discardImport(source); throw error; }
      }
      if (method === 'DELETE' && url.pathname.startsWith('/api/imports/')) {
        const id = url.pathname.split('/').pop(), source = library.sources.get(id);
        if (!source?.imported) throw new Error('暂存素材不存在');
        if (queue.jobs.some(j => j.source.id === id)) throw new Error('任务仍引用此素材，请先保留以便重试');
        await library.discardImport(source); return json(res, 200, { ok: true });
      }
      if (method === 'POST' && url.pathname === '/api/jobs') {
        const data = await body(req);
        if (typeof data.requestId !== 'string' || data.requestId.length > 100 || !data.requestId) throw new Error('缺少请求 ID');
        const jobs = await queue.add(data.sourceIds, data.options, data.requestId);
        return json(res, 201, { ids: jobs.map(j => j.id) });
      }
      if (method === 'POST' && url.pathname === '/api/queue/clear-ended') { await queue.clearEnded(); return json(res, 200, queue.snapshot()); }
      if (method === 'POST' && ['/api/queue/pause', '/api/queue/resume'].includes(url.pathname)) { await queue.pause(url.pathname.endsWith('/pause')); return json(res, 200, queue.snapshot()); }
      const match = /^\/api\/jobs\/([^/]+)\/(cancel|retry|output|reveal)$/.exec(url.pathname);
      if (match) {
        const [, id, action] = match, job = queue.find(id);
        if (method === 'POST' && ['cancel', 'retry'].includes(action)) { await queue[action](id); return json(res, 200, queue.snapshot()); }
        if (job.status !== 'completed') throw new Error('任务尚未完成');
        const file = await import('node:fs/promises').then(fs => fs.realpath(job.result.output));
        if (!within(library.outputDir, file)) throw new Error('输出不在授权范围');
        if (method === 'GET' && action === 'output') return await media(req, res, file);
        if (method === 'POST' && action === 'reveal') { openNative(file, true); return json(res, 200, { ok: true }); }
      }
      if (method === 'GET' && /^\/api\/sources\/[^/]+\/probe$/.test(url.pathname)) {
        const source = library.sources.get(url.pathname.split('/')[3]); if (!source) throw new Error('素材不存在');
        return json(res, 200, await probe(await library.validate(source)));
      }
      json(res, 404, { error: '接口不存在' });
    } catch (error) {
      if (!res.headersSent && !res.destroyed) json(res, 400, { error: error.message.slice(-3000) }); else res.destroy();
    }
  });
  server.requestTimeout = 0;
  await new Promise((resolve, reject) => {
    server.once('error', error => {
      if (error.code === 'EADDRINUSE' && port !== 0) { server.once('error', reject); server.listen(0, '127.0.0.1', resolve); }
      else reject(error);
    }); server.listen(port, '127.0.0.1', resolve);
  }).catch(async error => { await release(); throw error; });
  origin = `http://127.0.0.1:${server.address().port}`;
  const url = `${origin}/#token=${token}`;
  console.log(`\n◐ Video to Grayscale\n${url}\n输入：${library.inputDir}\n输出：${library.outputDir}\n按 Ctrl+C 停止服务。\n`);
  if (open) openNative(url);
  let shutting = false;
  const close = async () => {
    if (shutting) return; shutting = true;
    for (const res of connections) res.end();
    server.close(); server.closeAllConnections(); await queue.close(); await release();
    process.removeListener('SIGINT', close); process.removeListener('SIGTERM', close);
  };
  process.once('SIGINT', close); process.once('SIGTERM', close);
  return { server, queue, library, url, origin, close };
}
