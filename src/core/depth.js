import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { randomUUID, createHash } from 'node:crypto';
import { createReadStream } from 'node:fs';
import { access, mkdir, realpath, readFile, writeFile, rm, link, stat } from 'node:fs/promises';
import { run } from './process.js';
const root = fileURLToPath(new URL('../../', import.meta.url));
export const depthPython = path.join(root, '.venv', process.platform === 'win32' ? 'Scripts/python.exe' : 'bin/python');
export async function depthEnvironment() {
  const ready = await Promise.all([depthPython, path.join(root, '.models/depth-anything-v2-small/download.json')].map(file => access(file).then(() => true, () => false)));
  return { ready: ready.every(Boolean), model: 'Depth Anything V2 Small', setup: 'npm run setup:depth' };
}
async function sha256(file) {
  const hash = createHash('sha256'); for await (const chunk of createReadStream(file)) hash.update(chunk); return hash.digest('hex');
}
export async function convertDepth(input, outputDir, settings, metadata, { signal, onProgress = () => {}, onPhase = () => {} }) {
  if (metadata.video.sample_aspect_ratio && !['1:1', '0:1', 'N/A'].includes(metadata.video.sample_aspect_ratio)) throw new Error('深度首版要求方形像素，请先按显示比例规范化素材');
  if (!(await depthEnvironment()).ready) throw new Error('深度环境或模型未安装，请先运行 npm run setup:depth；不会降级成灰度视频');
  await mkdir(outputDir, { recursive: true }); outputDir = await realpath(outputDir);
  const id = randomUUID(), stem = path.basename(input, path.extname(input)).slice(0, 70);
  const work = path.join(outputDir, `.${id}.depth-partial`), finalDir = path.join(outputDir, `${stem}-depth-${id.slice(0, 8)}`);
  await mkdir(work); const start = Date.now(); let ownsFinal = false, published = false;
  const normalized = path.join(work, 'source.mkv');
  const encoder = 'libx264';
  try {
    onPhase('running', { encoder, stage: '准备帧序列', duration: metadata.duration, warning: '相对深度，近白远黑；单帧模型可能存在时序漂移' });
    await run('ffmpeg', ['-v', 'error', '-nostdin', '-n', '-protocol_whitelist', 'file', '-format_whitelist', 'mov,matroska,webm,avi', '-i', input,
      '-map', `0:${metadata.video.index}`, '-an', '-vf', 'pad=ceil(iw/2)*2:ceil(ih/2)*2,setsar=1', '-c:v', 'ffv1', '-level', '3', '-fps_mode', 'passthrough', '-map_metadata', '-1', normalized], { signal });
    const args = [path.join(root, 'python/depth_worker.py'), '--input', normalized, '--work-dir', work, '--size', String(settings.depthSize), '--device', settings.depthDevice];
    if (settings.invertDepth) args.push('--invert');
    await run(depthPython, args, { signal, onLine: line => {
      let event; try { event = JSON.parse(line); } catch { return; }
      if (event.phase === 'inference') onProgress({ elapsed: event.elapsed, percent: metadata.duration ? Math.min(80, event.elapsed / metadata.duration * 80) : null, frames: event.frame });
      else if (event.phase === 'loading') onPhase('running', { encoder, stage: `加载深度模型 · ${event.device}` });
      else if (event.phase === 'normalizing') { onPhase('running', { encoder, stage: '统一深度范围与编码' }); onProgress({ percent: 82, frames: event.frames }); }
    } });
    const report = JSON.parse(await readFile(path.join(work, 'manifest.json'), 'utf8'));
    const depthFile = path.join(work, 'depth.mp4');
    await run('ffmpeg', ['-v', 'error', '-nostdin', '-n', '-i', path.join(work, 'depth-lossless.mkv'),
      ...(settings.audio !== 'mute' ? ['-protocol_whitelist', 'file', '-format_whitelist', 'mov,matroska,webm,avi', '-i', input] : []),
      '-map', '0:v:0', ...(settings.audio !== 'mute' && metadata.audio ? ['-map', `1:${metadata.audio.index}`, '-c:a', settings.audio === 'auto' && metadata.audio.codec_name === 'aac' ? 'copy' : 'aac'] : ['-an']),
      '-c:v', encoder, '-preset', settings.preset === 'speed' ? 'fast' : 'medium', '-crf', '18', '-pix_fmt', 'yuv420p', '-r', report.fps,
      '-fps_mode', 'cfr', '-map_metadata', '-1', '-map_chapters', '-1', '-movflags', '+faststart', depthFile], { signal });
    onPhase('verifying', { encoder, stage: '验证深度视频' }); onProgress({ percent: 95 });
    const { probe } = await import('./media.js'); const checked = await probe(depthFile, { signal });
    if (checked.video.codec_name !== 'h264' || checked.video.width !== report.width || checked.video.height !== report.height || Number(checked.video.nb_frames) !== report.frames) throw new Error('深度输出帧数或尺寸不匹配');
    if (Boolean(checked.audio) !== Boolean(metadata.audio && settings.audio !== 'mute')) throw new Error('深度输出音轨校验失败');
    if (Math.abs(checked.duration - metadata.duration) > Math.max(0.15, 1 / Number(checked.video.avg_frame_rate?.split('/')[0] || 24))) throw new Error('深度输出时间轴偏差过大');
    await run('ffmpeg', ['-v', 'error', '-xerror', '-i', depthFile, '-f', 'null', '-'], { signal });
    Object.assign(report, { source_sha256: await sha256(input), audio: checked.audio ? checked.audio.codec_name : 'none', options: settings, encoder, crf: 18, seconds: (Date.now() - start) / 1000 });
    await writeFile(path.join(work, 'manifest.json'), JSON.stringify(report, null, 2));
    if (signal?.aborted) throw new Error('任务已取消');
    onPhase('committing', { encoder, stage: '保存结果' });
    await mkdir(finalDir); ownsFinal = true;
    for (const name of new Set(['depth.mp4', 'manifest.json', ...[0, Math.floor(report.frames / 2), report.frames - 1].map(n => `depth-frame-${String(n).padStart(4, '0')}.png`)])) {
      await link(path.join(work, name), path.join(finalDir, name));
    }
    published = true;
    return { output: path.join(finalDir, 'depth.mp4'), manifest: path.join(finalDir, 'manifest.json'), mode: 'depth', encoder,
      depthModel: report.model.id, device: report.device, frames: report.frames, duration: checked.duration, size: checked.size,
      sourceSize: metadata.size, seconds: report.seconds, warning: '单目相对深度，不是米制距离；动作迁移效果需在下游工作流验证' };
  } finally {
    await rm(work, { recursive: true, force: true });
    if (ownsFinal && !published) await rm(finalDir, { recursive: true, force: true });
  }
}
