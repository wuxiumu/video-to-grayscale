import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { access } from 'node:fs/promises';
import { spawn } from 'node:child_process';
const root = fileURLToPath(new URL('../', import.meta.url));
const python = path.join(root, '.venv', process.platform === 'win32' ? 'Scripts/python.exe' : 'bin/python');
function execute(binary, args) {
  return new Promise((resolve, reject) => {
    const child = spawn(binary, args, { cwd: root, stdio: 'inherit', shell: false });
    child.on('error', reject); child.on('close', code => code === 0 ? resolve() : reject(new Error(`安装步骤失败（${code}）`)));
  });
}
try {
  if (!await access(python).then(() => true, () => false)) await execute(process.platform === 'win32' ? 'python' : 'python3', ['-m', 'venv', '.venv']);
  await execute(python, ['-m', 'pip', 'install', '-r', 'requirements-depth.txt']);
  await execute(python, ['python/setup_depth.py']);
} catch (error) { console.error(error.message); process.exitCode = 1; }
