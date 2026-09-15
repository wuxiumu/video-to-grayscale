#!/usr/bin/env node
import path from 'node:path';
import { readdir, realpath, stat } from 'node:fs/promises';
import { parseArgs } from 'node:util';
import { convert, doctor, extensions, validateOptions } from './core/media.js';

const help = `Video to Grayscale · 本地深度 / 黑白视频转换

  npm run doctor
  npm run convert -- video.mp4 [other.mov] --output-dir ./output
  npm run convert -- --input-dir ./test --recursive --preset quality
  npm start -- --input-dir ./test --output-dir ./output

选项：
  --output-dir DIR  输出目录（默认 ./output；不覆盖已有文件）
  --input-dir DIR   批量输入目录 / 网页可访问根目录
  --recursive      CLI 递归扫描子目录
  --mode MODE      depth（默认深度视频）或 grayscale（普通灰度）
  --depth-size N   推理短边 392（默认）或 518
  --depth-device D auto（默认）、mps、cpu
  --invert-depth   深度图改为近黑远白
  --preset MODE    quality（默认）或 speed（可用时硬件编码）
  --audio MODE     mute（默认无音频）、auto（AAC 复制，否则转 AAC）、aac
  --json           CLI 输出 JSON 结果；失败退出码为 1
  --port NUMBER    网页端口（默认 3000，冲突时自动分配）
  --no-open        不自动打开浏览器
  --help           显示帮助

当前支持 SDR；仅导出主视频及首条音轨。按 Ctrl+C 取消。`;

try {
  const { values, positionals } = parseArgs({ allowPositionals: true, options: {
    'input-dir': { type: 'string' }, 'output-dir': { type: 'string', default: './output' },
    mode: { type: 'string', default: 'depth' }, 'depth-size': { type: 'string', default: '392' },
    'depth-device': { type: 'string', default: 'auto' }, 'invert-depth': { type: 'boolean' },
    preset: { type: 'string', default: 'quality' }, audio: { type: 'string', default: 'mute' },
    recursive: { type: 'boolean' }, json: { type: 'boolean' }, port: { type: 'string', default: '3000' },
    'no-open': { type: 'boolean' }, help: { type: 'boolean', short: 'h' },
  } });
  const [command, ...files] = positionals;
  if (values.help || !command) console.log(help);
  else if (command === 'doctor') {
    const env = await doctor(); console.log(JSON.stringify(env, null, 2)); if (!env.ready) process.exitCode = 1;
  } else if (command === 'serve') {
    const { serve } = await import('./server/http.js');
    await serve({ inputDir: values['input-dir'] || process.cwd(), outputDir: values['output-dir'], port: Number(values.port), open: !values['no-open'] });
  } else if (command === 'convert') {
    const options = validateOptions(values), outputDir = path.resolve(values['output-dir']);
    const canonicalOutput = await realpath(outputDir).catch(() => outputDir);
    const candidates = [...files.map(f => path.resolve(f))];
    const seenDirs = new Set();
    async function scan(directory) {
      const resolved = await realpath(directory);
      if (seenDirs.has(resolved) || resolved === canonicalOutput || path.basename(resolved) === '.grayscale') return;
      seenDirs.add(resolved);
      for (const entry of (await readdir(resolved, { withFileTypes: true })).sort((a, b) => a.name.localeCompare(b.name))) {
        if (entry.name.startsWith('.') || entry.name === 'node_modules') continue;
        const file = path.join(resolved, entry.name);
        if (entry.isFile() && extensions.has(path.extname(entry.name).toLowerCase())) candidates.push(file);
        else if (values.recursive && entry.isDirectory()) await scan(file);
      }
    }
    if (values['input-dir']) await scan(values['input-dir']);
    const inputs = [...new Set(await Promise.all(candidates.map(async f => realpath(f).catch(() => f))))];
    if (!inputs.length) throw new Error('没有输入视频。使用 --help 查看示例');
    const controller = new AbortController();
    process.once('SIGINT', () => controller.abort());
    const results = [];
    for (const [index, input] of inputs.entries()) {
      if (controller.signal.aborted) break;
      if (!values.json) console.error(`[${index + 1}/${inputs.length}] ${path.basename(input)}`);
      try {
        await stat(input);
        const result = await convert(input, outputDir, options, { signal: controller.signal,
          onPhase: (phase, info) => { if (!values.json) console.error(`  ${phase} · ${info.encoder}${info.fallback ? ` · ${info.fallback}` : ''}`); },
          onProgress: p => { if (process.stderr.isTTY && !values.json) process.stderr.write(`\r  ${p.percent?.toFixed(0) ?? '?'}%  `); },
        });
        results.push({ input, status: 'completed', ...result });
        if (!values.json) console.log(`\n✓ ${result.output} (${result.seconds}s)`);
      } catch (error) {
        results.push({ input, status: controller.signal.aborted ? 'canceled' : 'failed', error: error.message });
        if (!values.json) console.error(`\n✗ ${error.message}`);
      }
    }
    if (values.json) console.log(JSON.stringify(results, null, 2));
    if (controller.signal.aborted) process.exitCode = 130;
    else if (results.some(r => r.status !== 'completed')) process.exitCode = 1;
  } else throw new Error(`未知命令：${command}\n${help}`);
} catch (error) { console.error(error.message); process.exitCode = 1; }
