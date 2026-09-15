import path from 'node:path';
import { createHash, randomUUID } from 'node:crypto';
import { mkdir, realpath, readdir, stat, rm, readFile, writeFile, rename } from 'node:fs/promises';
import { extensions } from '../core/media.js';

export function within(root, target) {
  const relative = path.relative(root, target);
  return relative === '' || (!relative.startsWith(`..${path.sep}`) && relative !== '..' && !path.isAbsolute(relative));
}
export class Library {
  sources = new Map();
  directories = new Map();
  constructor(inputDir, outputDir, dataDir) {
    this.inputDir = path.resolve(inputDir); this.outputDir = path.resolve(outputDir); this.dataDir = path.resolve(dataDir);
  }
  async init() {
    await mkdir(this.outputDir, { recursive: true }); await mkdir(this.dataDir, { recursive: true, mode: 0o700 });
    this.inputDir = await realpath(this.inputDir); this.outputDir = await realpath(this.outputDir); this.dataDir = await realpath(this.dataDir);
    if (within(this.outputDir, this.inputDir) || within(this.dataDir, this.inputDir)) throw new Error('输入目录不能位于输出目录或应用数据目录内');
    this.directories.set('root', this.inputDir);
    const imports = path.join(this.dataDir, 'imports');
    await mkdir(imports, { recursive: true, mode: 0o700 });
    for (const entry of await readdir(imports, { withFileTypes: true })) {
      if (!entry.isDirectory()) continue;
      try {
        const source = JSON.parse(await readFile(path.join(imports, entry.name, '.source.json'), 'utf8'));
        await this.validate(source); this.sources.set(source.id, source);
      } catch { /* Interrupted imports remain on disk for manual inspection. */ }
    }
  }
  id(file) { return createHash('sha256').update(file).digest('hex').slice(0, 24); }
  excluded(file) { return within(this.outputDir, file) || within(this.dataDir, file); }
  async validate(source) {
    const file = await realpath(source.path);
    const allowed = source.imported ? within(path.join(this.dataDir, 'imports'), file) : within(this.inputDir, file) && !this.excluded(file);
    if (!allowed || !(await stat(file)).isFile()) throw new Error('素材已移动或不在授权目录内');
    return file;
  }
  async list(id = 'root') {
    const stored = this.directories.get(id);
    if (!stored) throw new Error('未知目录');
    const directory = await realpath(stored);
    if (!within(this.inputDir, directory) || this.excluded(directory)) throw new Error('目录不在授权范围');
    const items = [];
    for (const entry of (await readdir(directory, { withFileTypes: true })).sort((a, b) => a.name.localeCompare(b.name))) {
      if (entry.name.startsWith('.') || entry.isSymbolicLink()) continue;
      const file = path.join(directory, entry.name);
      if (this.excluded(file)) continue;
      if (entry.isDirectory()) { const childId = this.id(file); this.directories.set(childId, file); items.push({ id: childId, name: entry.name, directory: true }); }
      else if (entry.isFile() && extensions.has(path.extname(entry.name).toLowerCase())) {
        const source = { id: this.id(file), name: entry.name, path: file, size: (await stat(file)).size, imported: false };
        this.sources.set(source.id, source); items.push(this.public(source));
      }
    }
    const parent = path.dirname(directory), parentId = directory === this.inputDir ? null : (parent === this.inputDir ? 'root' : this.id(parent));
    if (parentId) this.directories.set(parentId, parent);
    return { items, parentId, directoryId: id, label: path.relative(this.inputDir, directory) || '授权目录' };
  }
  public(source) { return { id: source.id, name: source.name, size: source.size, imported: source.imported }; }
  async prepareImport(name) {
    if (typeof name !== 'string' || name.length > 200 || name !== path.basename(name) || /[\\/\x00-\x1f]/.test(name) || name.startsWith('.') || !extensions.has(path.extname(name).toLowerCase())) throw new Error('不支持的文件名或视频扩展名');
    const id = randomUUID(); const directory = path.join(this.dataDir, 'imports', id);
    await mkdir(directory, { recursive: true, mode: 0o700 });
    return { id, name, path: path.join(directory, name), imported: true };
  }
  async commitImport(source) {
    const file = path.join(path.dirname(source.path), '.source.json');
    await writeFile(file + '.tmp', JSON.stringify(source), { mode: 0o600 });
    await rename(file + '.tmp', file); this.sources.set(source.id, source);
  }
  async discardImport(source) {
    const root = path.join(this.dataDir, 'imports');
    const directory = path.dirname(source.path);
    if (source.imported && within(root, directory) && directory !== root) await rm(directory, { recursive: true, force: true });
    this.sources.delete(source.id);
  }
}
