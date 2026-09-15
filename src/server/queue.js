import { EventEmitter } from 'node:events';
import { randomUUID } from 'node:crypto';
import path from 'node:path';
import { readFile, writeFile, rename, stat } from 'node:fs/promises';
import { convert, validateOptions } from '../core/media.js';

export class Queue extends EventEmitter {
  jobs = []; paused = false; active = null; revision = 0; saving = Promise.resolve(); closing = false; persistenceError = '';
  constructor(library, runner = convert) { super(); this.library = library; this.runner = runner; this.file = path.join(library.dataDir, 'jobs.json'); }
  async init() {
    let saved;
    try { saved = JSON.parse(await readFile(this.file, 'utf8')); }
    catch (error) { if (error.code !== 'ENOENT') throw new Error('任务记录损坏，保留 jobs.json 后再排查：' + error.message); }
    if (saved) {
      this.jobs = saved.jobs; this.paused = saved.paused || this.jobs.some(j => j.status === 'queued');
      for (const job of this.jobs) {
        job.options.mode ??= 'grayscale'; // Old jobs keep their original meaning when retried.
        this.library.sources.set(job.source.id, job.source);
        if (['running', 'probing', 'verifying', 'committing', 'canceling'].includes(job.status)) { job.status = 'interrupted'; job.error = '服务中断，可从头重试'; }
        if (job.status === 'completed' && !await stat(job.result.output).then(s => s.isFile(), () => false)) { job.status = 'failed'; job.error = '输出文件已被移动或删除'; }
      }
    }
    await this.save();
  }
  snapshot() {
    return { paused: this.paused, revision: this.revision, persistenceError: this.persistenceError, jobs: this.jobs.map(j => ({ ...j, source: this.library.public(j.source) })) };
  }
  save() {
    const content = JSON.stringify({ jobs: this.jobs, paused: this.paused });
    this.saving = this.saving.then(async () => {
      await writeFile(this.file + '.tmp', content, { mode: 0o600 }); await rename(this.file + '.tmp', this.file);
    }).catch(error => { this.persistenceError = '任务记录无法保存：' + error.message; this.paused = true; this.emit('update', this.snapshot()); throw error; });
    return this.saving;
  }
  publish(persist = true) {
    this.revision++; this.emit('update', this.snapshot());
    if (persist) this.save().catch(() => {});
  }
  async add(sourceIds, options, requestId) {
    if (this.persistenceError || this.closing) throw new Error('队列当前不可写');
    const previous = this.jobs.filter(j => j.requestId === requestId);
    if (previous.length) return previous;
    options = validateOptions(options);
    if (!Array.isArray(sourceIds) || !sourceIds.length || sourceIds.length > 200) throw new Error('每批请选择 1–200 个视频');
    const sources = [...new Set(sourceIds)].map(id => { const s = this.library.sources.get(id); if (!s) throw new Error('素材不存在，请重新选择'); return s; });
    const jobs = sources.map(source => ({ id: randomUUID(), requestId, source, options, status: 'queued', attempt: 1, percent: 0, createdAt: new Date().toISOString() }));
    this.jobs.push(...jobs); await this.save(); this.publish(false); this.pump(); return jobs;
  }
  async pause(value) { this.paused = value; await this.save(); this.publish(false); if (!value) this.pump(); }
  find(id) { const job = this.jobs.find(j => j.id === id); if (!job) throw new Error('任务不存在'); return job; }
  async cancel(id) {
    const job = this.find(id);
    if (job.status === 'queued') job.status = 'canceled';
    else if (this.active?.id === id && job.status !== 'committing') { job.status = 'canceling'; this.active.controller.abort(); }
    this.publish();
  }
  async retry(id) {
    const job = this.find(id);
    if (!['failed', 'canceled', 'interrupted'].includes(job.status)) throw new Error('当前任务不能重试');
    await this.library.validate(job.source);
    Object.assign(job, { status: 'queued', percent: 0, elapsed: 0, error: '', result: undefined, attempt: job.attempt + 1 });
    await this.save(); this.publish(false); this.pump();
  }
  async pump() {
    if (this.active || this.paused || this.closing || this.persistenceError) return;
    const job = this.jobs.find(j => j.status === 'queued'); if (!job) return;
    const controller = new AbortController(); this.active = { id: job.id, controller };
    job.status = 'probing'; job.startedAt = Date.now(); this.publish();
    try {
      const input = await this.library.validate(job.source);
      const result = await this.runner(input, this.library.outputDir, job.options, {
        signal: controller.signal,
        onPhase: (status, info) => { if (!controller.signal.aborted) { Object.assign(job, info, { status }); this.publish(); } },
        onProgress: progress => { if (!controller.signal.aborted) { Object.assign(job, progress); this.publish(false); } },
      });
      // Publication has completed at this point. Do not leave a committed result untracked.
      Object.assign(job, { status: 'completed', percent: 100, result, error: '' });
    } catch (error) { job.status = controller.signal.aborted ? 'canceled' : 'failed'; job.error = error.message; }
    finally {
      job.finishedAt = Date.now(); this.active = null;
      try { await this.save(); } catch { /* pause on persistence error */ }
      this.publish(false); this.pump();
    }
  }
  async clearEnded() {
    const ended = this.jobs.filter(j => ['completed', 'failed', 'canceled', 'interrupted'].includes(j.status));
    this.jobs = this.jobs.filter(j => !ended.includes(j));
    await this.save();
    const sources = new Map(ended.map(j => [j.source.id, j.source]));
    for (const source of sources.values()) {
      if (source.imported && !this.jobs.some(j => j.source.id === source.id)) await this.library.discardImport(source);
    }
    this.publish(false);
  }
  async close() {
    this.closing = true; this.active?.controller.abort();
    while (this.active) await new Promise(resolve => setTimeout(resolve, 30));
    await this.saving;
  }
}
