import { spawn } from 'node:child_process';

/** Run without a shell, retaining a bounded diagnostic tail. */
export function run(binary, args, { signal, onLine, timeout = 0, maxOutput = 4 * 1024 * 1024 } = {}) {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) return reject(new Error('任务已取消'));
    const child = spawn(binary, args, { shell: false, stdio: ['ignore', 'pipe', 'pipe'] });
    let stdout = '', stderr = '', pending = '', failure, killTimer;
    const terminate = () => {
      child.kill('SIGTERM');
      killTimer ??= setTimeout(() => child.kill('SIGKILL'), 2000).unref();
    };
    const timer = timeout ? setTimeout(() => { failure = new Error('处理超时'); terminate(); }, timeout).unref() : null;
    signal?.addEventListener('abort', terminate, { once: true });
    child.stdout.on('data', data => {
      if (onLine) {
        pending += data.toString();
        const lines = pending.split('\n'); pending = lines.pop();
        for (const line of lines) onLine(line.trim());
      } else {
        stdout += data.toString();
        if (stdout.length > maxOutput) { failure = new Error('媒体探测结果过大'); terminate(); }
      }
    });
    child.stderr.on('data', data => { stderr = (stderr + data).slice(-12000); });
    child.on('error', error => { failure = new Error(error.code === 'ENOENT' ? `找不到 ${binary}，请先安装 FFmpeg 并检查 PATH` : error.message); });
    child.on('close', code => {
      clearTimeout(timer); clearTimeout(killTimer); signal?.removeEventListener('abort', terminate);
      if (signal?.aborted) reject(new Error('任务已取消'));
      else if (failure) reject(failure);
      else if (code !== 0) reject(new Error(`${binary} 处理失败：${stderr.trim() || `exit ${code}`}`));
      else resolve({ stdout, stderr });
    });
  });
}
