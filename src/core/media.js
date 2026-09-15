import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { mkdir, stat, realpath, link, unlink } from 'node:fs/promises';
import { run } from './process.js';
import { depthEnvironment, convertDepth } from './depth.js';

export const extensions = new Set(['.mp4', '.mov', '.mkv', '.m4v', '.webm', '.avi']);
const inputOptions = ['-protocol_whitelist', 'file', '-format_whitelist', 'mov,matroska,webm,avi'];
export function validateOptions(options = {}) {
  const preset = options.preset ?? 'quality', audio = options.audio ?? 'mute';
  if (!['quality', 'speed'].includes(preset)) throw new Error('preset 必须为 quality 或 speed');
  if (!['auto', 'aac', 'mute'].includes(audio)) throw new Error('audio 必须为 auto、aac 或 mute');
  const mode = options.mode ?? 'depth';
  if (!['depth', 'grayscale'].includes(mode)) throw new Error('mode 必须为 depth 或 grayscale');
  const depthSize = Number(options.depthSize ?? options['depth-size'] ?? 392);
  const depthDevice = options.depthDevice ?? options['depth-device'] ?? 'auto';
  const invertDepth = options.invertDepth ?? options['invert-depth'] ?? false;
  if (![392, 518].includes(depthSize)) throw new Error('depth-size 必须为 392 或 518');
  if (!['auto', 'mps', 'cpu'].includes(depthDevice)) throw new Error('depth-device 必须为 auto、mps 或 cpu');
  if (typeof invertDepth !== 'boolean') throw new Error('invertDepth 必须为布尔值');
  return { preset, audio, mode, depthSize, depthDevice, invertDepth };
}
export async function probe(file, { signal } = {}) {
  const info = await stat(file);
  if (!info.isFile()) throw new Error('输入必须是普通视频文件');
  const { stdout } = await run('ffprobe', ['-v', 'error', ...inputOptions, '-show_streams', '-show_format', '-of', 'json', file], { signal, timeout: 30000 });
  const data = JSON.parse(stdout);
  const video = data.streams.find(s => s.codec_type === 'video' && !s.disposition?.attached_pic);
  if (!video) throw new Error('未发现可转换的视频流');
  if (['smpte2084', 'arib-std-b67'].includes(video.color_transfer) || /DOVI|Dolby Vision/i.test(JSON.stringify(video.side_data_list))) {
    throw new Error('暂不支持 HDR / 杜比视界，请先将素材转换为 SDR');
  }
  const audio = data.streams.find(s => s.codec_type === 'audio');
  const duration = Number(video.duration || data.format.duration) || 0;
  return { video, audio, duration, size: info.size, streams: data.streams.length,
    warning: [data.streams.length > (audio ? 2 : 1) ? '仅保留主视频和首条音轨，其他流将被省略' : '',
      !video.color_transfer || video.color_transfer === 'unknown' ? '源视频未声明色彩传递特性，请确认是 SDR 素材' : ''].filter(Boolean).join('；') };
}
let capabilities;
export async function doctor({ refresh = false } = {}) {
  if (capabilities && !refresh) return { ...capabilities, depth: await depthEnvironment() };
  const checks = await Promise.allSettled([run('ffmpeg', ['-version']), run('ffprobe', ['-version'])]);
  const errors = checks.filter(r => r.status === 'rejected').map(r => r.reason.message);
  const versions = checks.map(r => r.status === 'fulfilled' ? r.value.stdout.split('\n')[0] : null);
  let software = false, hardware = false;
  if (!errors.length) {
    const test = codec => run('ffmpeg', ['-v', 'error', '-f', 'lavfi', '-i', 'color=size=128x128:rate=24', '-frames:v', '2', '-c:v', codec, ...(codec.includes('videotoolbox') ? ['-allow_sw', '0', '-b:v', '1M'] : []), '-f', 'null', '-'], { timeout: 10000 });
    software = await test('libx264').then(() => true, () => false);
    if (process.platform === 'darwin') hardware = await test('h264_videotoolbox').then(() => true, () => false);
    if (!software) errors.push('当前 FFmpeg 构建无法使用 libx264，请安装包含该编码器的版本');
  }
  capabilities = { ready: !errors.length, software, hardware, versions, errors, platform: process.platform, arch: process.arch, node: process.version };
  return { ...capabilities, depth: await depthEnvironment() };
}
export async function convert(input, outputDir, options = {}, { signal, onProgress = () => {}, onPhase = () => {} } = {}) {
  const settings = validateOptions(options);
  input = await realpath(input);
  const metadata = await probe(input, { signal });
  const env = await doctor();
  if (!env.ready) throw new Error(env.errors.join('\n'));
  if (settings.mode === 'depth') return convertDepth(input, outputDir, settings, metadata, { signal, onProgress, onPhase });
  await mkdir(outputDir, { recursive: true });
  outputDir = await realpath(outputDir);
  const id = randomUUID();
  const stem = path.basename(input, path.extname(input)).slice(0, 100);
  const output = path.join(outputDir, `${stem}-gray-${id.slice(0, 8)}.mp4`);
  const temporary = path.join(outputDir, `.${id}.partial.mp4`);
  const start = Date.now();
  let encoder = settings.preset === 'speed' && env.hardware ? 'h264_videotoolbox' : 'libx264';
  let fallback = settings.preset === 'speed' && !env.hardware ? '硬件编码不可用，已使用软件编码' : '';
  const makeArgs = () => [
    '-hide_banner', '-loglevel', 'error', '-nostdin', '-n', ...inputOptions, '-i', input,
    '-map', `0:${metadata.video.index}`, ...(metadata.audio && settings.audio !== 'mute' ? ['-map', `0:${metadata.audio.index}`] : []),
    '-vf', 'hue=s=0,pad=ceil(iw/2)*2:ceil(ih/2)*2,format=yuv420p',
    '-c:v', encoder,
    ...(encoder === 'libx264' ? ['-crf', '20', '-preset', 'medium'] : ['-allow_sw', '0', '-b:v', String(Math.max(1500000, Math.round(metadata.video.width * metadata.video.height * 5)))]),
    ...(metadata.audio && settings.audio !== 'mute' ? (settings.audio === 'auto' && metadata.audio.codec_name === 'aac' ? ['-c:a', 'copy'] : ['-c:a', 'aac', '-b:a', '192k']) : ['-an']),
    '-map_metadata', '-1', '-map_chapters', '-1', '-movflags', '+faststart',
    '-progress', 'pipe:1', '-nostats', temporary,
  ];
  const encode = () => {
    onPhase('running', { encoder, fallback, duration: metadata.duration, warning: metadata.warning });
    return run('ffmpeg', makeArgs(), { signal, onLine: line => {
      if (line.startsWith('out_time_us=')) {
        const elapsed = Number(line.split('=')[1]) / 1000000;
        if (Number.isFinite(elapsed)) onProgress({ elapsed, percent: metadata.duration ? Math.min(99, Math.max(0, elapsed / metadata.duration * 100)) : null });
      }
    } });
  };
  try {
    try { await encode(); }
    catch (error) {
      if (!signal?.aborted && encoder === 'h264_videotoolbox' && /hardware encoder|cannot create compression|Error.*VideoToolbox|cannot create.*session/i.test(error.message)) {
        await unlink(temporary).catch(() => {});
        encoder = 'libx264'; fallback = '硬件编码失败，已从头切换软件编码'; await encode();
      } else throw error;
    }
    onPhase('verifying', { encoder, fallback });
    const result = await probe(temporary, { signal });
    if (!result.duration || result.video.codec_name !== 'h264') throw new Error('输出视频校验失败');
    if (metadata.duration && Math.abs(result.duration - metadata.duration) > Math.max(0.25, metadata.duration * 0.01)) throw new Error('输出时长与源视频不符');
    if (Boolean(result.audio) !== Boolean(metadata.audio && settings.audio !== 'mute')) throw new Error('输出音轨不符合设置');
    await run('ffmpeg', ['-v', 'error', '-xerror', ...inputOptions, '-i', temporary, '-f', 'null', '-'], { signal, onLine: () => {} });
    if (signal?.aborted) throw new Error('任务已取消');
    // Hard-link publication fails on an existing destination; never overwrite originals/results.
    onPhase('committing', { encoder, fallback });
    await link(temporary, output);
    await unlink(temporary).catch(() => {});
    return { output, encoder, fallback, warning: metadata.warning, duration: result.duration, size: result.size, sourceSize: metadata.size, seconds: (Date.now() - start) / 1000 };
  } finally { await unlink(temporary).catch(() => {}); }
}
