const $ = id => document.getElementById(id);
const selected = new Map(), imported = new Map();
let environmentState;
let listing, queue = { jobs: [], paused: false }, ready = false, uploading = false, uploadRequest, abortUploads = false, submitting = false;
const formatSize = n => n >= 1024 ** 3 ? (n / 1024 ** 3).toFixed(2) + ' GB' : n >= 1024 ** 2 ? (n / 1024 ** 2).toFixed(1) + ' MB' : (n / 1024).toFixed(0) + ' KB';
const labels = { queued: '等待转换', probing: '检查素材', running: '正在转换', verifying: '校验输出', committing: '保存结果', completed: '已完成', failed: '转换失败', canceled: '已取消', canceling: '正在取消', interrupted: '服务中断' };
const terminal = ['completed', 'failed', 'canceled', 'interrupted'];
function notice(message = '') { $('notice').textContent = message; $('notice').hidden = !message; }
function el(tag, className, text) { const node = document.createElement(tag); if (className) node.className = className; if (text !== undefined) node.textContent = text; return node; }
async function api(url, options = {}) {
  const res = await fetch(url, { ...options, headers: { 'Content-Type': 'application/json', ...options.headers } });
  const data = await res.json(); if (!res.ok) throw new Error(data.error || '请求失败'); return data;
}
const post = (url, data = {}) => api(url, { method: 'POST', body: JSON.stringify(data) });
function action(label, handler) {
  const button = el('button', 'small-button', label);
  button.addEventListener('click', async () => { button.disabled = true; try { await handler(); } catch (e) { notice(e.message); } finally { button.disabled = false; } }); return button;
}
function updateSelection() {
  $('selected-count').textContent = `已选 ${selected.size} 个`;
  $('convert-count').textContent = selected.size ? `${selected.size} 个视频 →` : '→';
  $('convert').disabled = !selected.size || !ready || uploading || submitting;
  const files = listing?.items.filter(f => !f.directory) || [];
  $('select-all').checked = files.length > 0 && files.every(f => selected.has(f.id));
  $('select-all').indeterminate = files.some(f => selected.has(f.id)) && !$('select-all').checked;
}
function fileRow(file) {
  const row = el('div', 'file-row');
  if (file.directory) { const button = el('button', 'folder-button', `▱  ${file.name}  ›`); button.onclick = () => loadFiles(file.id).catch(e => notice(e.message)); row.append(button); return row; }
  const label = el('label'), checkbox = el('input'); checkbox.type = 'checkbox'; checkbox.checked = selected.has(file.id); checkbox.setAttribute('aria-label', `选择 ${file.name}`);
  checkbox.onchange = () => { if (checkbox.checked) selected.set(file.id, file); else selected.delete(file.id); updateSelection(); };
  const name = el('span', 'file-name', file.name); name.title = file.name;
  label.append(checkbox, el('span', 'file-icon', '▷'), name); row.append(label, el('span', 'file-size', formatSize(file.size)));
  if (file.imported && !queue.jobs.some(j => j.source.id === file.id)) row.append(action('移除', async () => { await api(`/api/imports/${file.id}`, { method: 'DELETE' }); selected.delete(file.id); imported.delete(file.id); renderFiles(); }));
  return row;
}
function renderFiles() {
  $('files').replaceChildren(...(listing?.items.length ? listing.items.map(fileRow) : [el('p', 'empty', '目录中没有视频，可拖拽文件或切换子目录。')]));
  $('imports').replaceChildren(...[...imported.values()].map(fileRow)); $('imported-section').hidden = !imported.size; updateSelection();
}
async function loadFiles(id = 'root') {
  listing = await api(`/api/files?directoryId=${encodeURIComponent(id)}`);
  $('directory-label').textContent = listing.label; $('parent').hidden = !listing.parentId; renderFiles();
}
function renderJobs() {
  $('nav-count').textContent = queue.jobs.length;
  const completed = queue.jobs.filter(j => j.status === 'completed').length, failed = queue.jobs.filter(j => j.status === 'failed').length;
  $('queue-summary').textContent = `${queue.jobs.length} 个任务 · ${completed} 已完成${failed ? ` · ${failed} 失败` : ''}${queue.paused ? ' · 队列已暂停' : ''}`;
  $('pause').textContent = queue.paused ? '▶ 继续队列' : 'Ⅱ 暂停队列';
  if (!queue.jobs.length) {
    const empty = el('div', 'queue-empty'); empty.append(el('span', '', '☷'), el('strong', '', '光影，即将就绪'), el('p', '', '添加视频后，转换进度和结果会出现在这里。'));
    $('jobs').replaceChildren(empty); return;
  }
  const nodes = queue.jobs.map(job => {
    const row = el('div', `job ${job.status}`); row.dataset.jobId = job.id;
    const info = el('div'); info.append(el('div', 'job-title', job.source.name));
    const meta = [formatSize(job.source.size), job.options?.mode === 'depth' ? '相对深度' : '灰度', job.encoder, job.result ? `${formatSize(job.result.size)} · ${job.result.seconds.toFixed(1)}s` : `第 ${job.attempt} 次`].filter(Boolean).join(' · ');
    info.append(el('div', 'job-meta', meta));
    const progress = el('div'), status = el('div', 'job-status');
    status.append(el('span', '', job.status === 'running' && job.stage ? job.stage : (labels[job.status] || job.status)), el('span', '', job.percent == null ? `${(job.elapsed || 0).toFixed(1)}s` : `${Math.floor(job.percent || 0)}%`));
    const track = el('div', 'job-progress');
    // A progress element avoids inline styles, keeping the strict content policy intact.
    const bar = el('progress'); bar.max = 100; bar.value = job.percent ?? 0; bar.setAttribute('aria-label', `${job.source.name} 转换进度`); track.append(bar); progress.append(status, track);
    const actions = el('div', 'job-actions');
    if (!terminal.includes(job.status) && job.status !== 'committing') actions.append(action('取消', () => post(`/api/jobs/${job.id}/cancel`)));
    if (['failed', 'canceled', 'interrupted'].includes(job.status)) actions.append(action('重试', () => post(`/api/jobs/${job.id}/retry`)));
    if (job.status === 'completed') {
      actions.append(action('播放', async () => { $('player-title').textContent = job.source.name; $('player-detail').textContent = job.result.output; $('player').src = `/api/jobs/${job.id}/output`; $('player-dialog').showModal(); }));
      actions.append(action('定位', () => post(`/api/jobs/${job.id}/reveal`)));
    }
    row.append(info, progress, actions);
    const message = job.error || job.fallback || job.warning; if (message) row.append(el('div', 'job-error', message));
    return row;
  });
  $('jobs').replaceChildren(...nodes);
  if (queue.persistenceError) notice(queue.persistenceError);
}
async function upload(files) {
  if (uploading) { notice('请等待当前导入完成'); return; }
  uploading = true; abortUploads = false; updateSelection(); $('upload-status').hidden = false; notice();
  try {
    for (const [index, file] of [...files].entries()) {
      if (abortUploads) break;
      $('upload-label').textContent = `${index + 1}/${files.length} · ${file.name}`; $('upload-progress').value = 0;
      try {
        const source = await new Promise((resolve, reject) => {
          const xhr = uploadRequest = new XMLHttpRequest(); xhr.open('POST', `/api/imports?name=${encodeURIComponent(file.name)}`);
          xhr.upload.onprogress = e => { if (e.lengthComputable) $('upload-progress').value = e.loaded / e.total * 100; };
          xhr.onload = () => { try { const data = JSON.parse(xhr.responseText); xhr.status < 300 ? resolve(data) : reject(new Error(data.error)); } catch { reject(new Error('导入失败')); } };
          xhr.onerror = () => reject(new Error('连接中断，导入失败')); xhr.onabort = () => reject(new Error('已取消导入'));
          xhr.send(file);
        });
        imported.set(source.id, source); selected.set(source.id, source); renderFiles();
      } catch (error) { notice(`${file.name}：${error.message}`); }
    }
  } finally { uploading = false; uploadRequest = null; $('upload-status').hidden = true; $('file-input').value = ''; updateSelection(); }
}
$('choose').onclick = () => $('file-input').click(); $('file-input').onchange = e => upload(e.target.files);
$('cancel-upload').onclick = () => { abortUploads = true; uploadRequest?.abort(); };
$('dropzone').ondragover = e => { e.preventDefault(); $('dropzone').classList.add('drag'); };
$('dropzone').ondragleave = () => $('dropzone').classList.remove('drag');
$('dropzone').ondrop = e => { e.preventDefault(); $('dropzone').classList.remove('drag'); upload(e.dataTransfer.files); };
$('select-all').onchange = e => { for (const file of listing.items.filter(f => !f.directory)) { if (e.target.checked) selected.set(file.id, file); else selected.delete(file.id); } renderFiles(); };
$('refresh-files').onclick = () => loadFiles(listing?.directoryId).catch(e => notice(e.message));
$('parent').onclick = () => loadFiles(listing.parentId).catch(e => notice(e.message));
$('clear-ended').onclick = async () => {
  try {
    await post('/api/queue/clear-ended');
    const sources = await api('/api/imports'); imported.clear(); sources.forEach(s => imported.set(s.id, s));
    for (const [id, source] of selected) if (source.imported && !imported.has(id)) selected.delete(id);
    renderFiles(); notice('已清理结束任务的记录和暂存副本，原片与导出结果均保留。');
  } catch (e) { notice(e.message); }
};
$('pause').onclick = async () => { try { await post(`/api/queue/${queue.paused ? 'resume' : 'pause'}`); } catch (e) { notice(e.message); } };
$('convert').onclick = async () => {
  submitting = true; updateSelection(); notice();
  const ids = [...selected.keys()];
  try {
    await post('/api/jobs', { sourceIds: ids, options: { mode: $('mode').value, preset: $('preset').value, audio: $('audio').value, depthSize: Number($('depth-size').value), invertDepth: $('invert-depth').checked }, requestId: crypto.randomUUID() });
    ids.forEach(id => selected.delete(id)); renderFiles(); $('queue').scrollIntoView({ behavior: 'smooth', block: 'nearest' });
  } catch (e) { notice(e.message); } finally { submitting = false; updateSelection(); }
};
$('close-player').onclick = () => $('player-dialog').close();
$('player-dialog').onclose = () => { $('player').pause(); $('player').removeAttribute('src'); $('player').load(); };
$('player').onerror = () => { $('player-detail').textContent += ' · 浏览器播放失败，可使用“定位”在本机播放器打开。'; };
$('help').onclick = () => $('help-dialog').showModal(); $('close-help').onclick = () => $('help-dialog').close();
function updateMode() {
  const depth = $('mode').value === 'depth';
  $('depth-controls').hidden = !depth;
  ready = Boolean(environmentState?.ready && (!depth || environmentState.depth?.ready));
  $('mode-hint').textContent = depth ? '本地模型估计相对远近；单帧模型可能有轻微闪烁。' : '去掉颜色，保留原画面亮暗；不包含深度信息。';
  $('mode-note').textContent = depth ? '✓ 相对深度，保留结构与遮挡' : '✓ 普通灰度，去除颜色';
  if (environmentState?.ready) {
    $('engine-title').textContent = ready ? '本地转换引擎已就绪' : '需要安装深度模型';
    $('engine-detail').textContent = depth ? (ready ? 'Depth Anything V2 Small · 本地推理' : '终端执行 npm run setup:depth 后刷新') : 'FFmpeg · 普通灰度转换';
    $('engine-dot').classList.toggle('ready', ready);
  }
  updateSelection();
}
$('mode').onchange = updateMode;
async function init() {
  const token = new URLSearchParams(location.hash.slice(1)).get('token');
  if (token) { await post('/api/session', { token }); history.replaceState(null, '', location.pathname); }
  const environment = environmentState = await api('/api/environment'); ready = environment.ready;
  $('output-path').textContent = environment.outputDir;
  $('engine-title').textContent = ready ? '本地转换引擎已就绪' : '需要安装 FFmpeg';
  $('engine-detail').textContent = ready ? `FFmpeg · ${environment.hardware ? '硬件编码可用' : '软件编码'} · ${environment.arch}` : environment.errors.join('；');
  $('engine-dot').classList.toggle('ready', ready);
  if (!ready) notice(`${environment.errors.join('\n')}\nmacOS 安装：brew install ffmpeg，然后重启本地服务。`);
  (await api('/api/imports')).forEach(s => imported.set(s.id, s));
  await loadFiles(); queue = await api('/api/jobs'); renderJobs();
  const events = new EventSource('/api/events');
  events.onmessage = e => { queue = JSON.parse(e.data); renderJobs(); $('connection').textContent = '● 已连接 · 仅本机处理'; };
  events.onerror = () => { $('connection').textContent = '○ 连接中断 · 自动重连中'; };
  updateMode();
}
init().catch(e => { notice(e.message); $('connection').textContent = '○ 未连接'; });
