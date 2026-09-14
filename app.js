const APP_VERSION = '0.1.3';
const MODEL_URL = './models/u2netp.onnx';
const MODEL_SHA256 = '309c8469258dda742793dce0ebea8e6dd393174f89934733ecc8b14c76f4ddd8';
const ORT_BASE = 'https://cdn.jsdelivr.net/npm/onnxruntime-web@1.27.0/dist/';
const CDN = {
  pdfLib: 'https://cdn.jsdelivr.net/npm/pdf-lib@1.17.1/+esm',
  pdfJs: 'https://cdn.jsdelivr.net/npm/pdfjs-dist@6.1.200/build/pdf.min.mjs',
  pdfWorker: 'https://cdn.jsdelivr.net/npm/pdfjs-dist@6.1.200/build/pdf.worker.min.mjs',
  zip: 'https://cdn.jsdelivr.net/npm/jszip@3.10.1/+esm',
  ort: `${ORT_BASE}ort.webgpu.min.mjs`,
};

const pageMeta = {
  home: ['首页', '一个网页，处理日常文件'],
  cutout: ['智能抠图', 'U²-NetP 本地推理，批量输出透明 PNG'],
  image: ['图片工具', '格式转换、压缩、缩放和批量导出'],
  media: ['音视频', '浏览器可解码媒体的提取、裁剪与合并'],
  recorder: ['录音工具', '麦克风、分享音频与混音录制'],
  documents: ['文档转换', '图片、文本、Markdown 与 PDF 互转'],
  pdf: ['PDF 工具', '合并、拆分、重排、装饰和区域替换'],
  settings: ['设置与许可', '主题、缓存、依赖状态和开源许可'],
};

const state = {
  page: 'home',
  tabs: { documents: 'images', pdf: 'merge', media: 'extract' },
  queues: { cutout: [], image: [], media: [], documents: [], pdf: [] },
  deps: {},
  ortSession: null,
  installPrompt: null,
  recorder: { stream: null, micStream: null, displayStream: null, mediaRecorder: null, chunks: [], startedAt: 0, pausedAt: 0, pausedTotal: 0, timerId: null, analyser: null, animationId: null, audioContext: null, sourceNodes: [] },
};

const $ = (sel, root = document) => root.querySelector(sel);
const $$ = (sel, root = document) => [...root.querySelectorAll(sel)];
const content = $('#content');

function escapeHtml(value = '') {
  return String(value).replace(/[&<>'"]/g, ch => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', "'": '&#39;', '"': '&quot;' })[ch]);
}
function formatBytes(bytes) {
  if (!Number.isFinite(bytes) || bytes <= 0) return '0 B';
  const units = ['B', 'KB', 'MB', 'GB'];
  const index = Math.min(Math.floor(Math.log(bytes) / Math.log(1024)), units.length - 1);
  return `${(bytes / 1024 ** index).toFixed(index ? 1 : 0)} ${units[index]}`;
}
function safeName(name) {
  const cleaned = name.replace(/[<>:"/\\|?*\x00-\x1F]/g, '_').replace(/\s+/g, ' ').trim();
  return cleaned || 'rockwell-output';
}
function stem(name) { return safeName(name.replace(/\.[^.]+$/, '')); }
function ext(name) { const i = name.lastIndexOf('.'); return i >= 0 ? name.slice(i + 1).toLowerCase() : ''; }

const MEDIA_EXTENSIONS = new Set(['mp3', 'mp4', 'm4a', 'aac', 'wav', 'flac', 'ogg', 'oga', 'opus', 'webm', 'weba', 'mov', 'm4v', '3gp']);
const MEDIA_ACCEPT = 'audio/*,video/*,.mp3,.mp4,.m4a,.aac,.wav,.flac,.ogg,.oga,.opus,.webm,.weba,.mov,.m4v,.3gp';
function isMediaFile(file) {
  return file.type.startsWith('audio/') || file.type.startsWith('video/') || MEDIA_EXTENSIONS.has(ext(file.name));
}
function downloadBlob(blob, filename) {
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url; a.download = safeName(filename); a.click();
  setTimeout(() => URL.revokeObjectURL(url), 3000);
}
function toast(message, type = '') {
  const el = document.createElement('div');
  el.className = `toast ${type}`;
  el.textContent = message;
  $('#toastHost').appendChild(el);
  setTimeout(() => el.remove(), 4500);
}
function setProgress(id, percent, text = '') {
  const bar = $(`#${id} .progress-bar i`);
  const label = $(`#${id} .progress-label`);
  if (bar) bar.style.width = `${Math.max(0, Math.min(100, percent))}%`;
  if (label) label.textContent = text || `${Math.round(percent)}%`;
}
function readArrayBuffer(file) { return file.arrayBuffer(); }
function fileFromEvent(event) { return [...(event.dataTransfer?.files || event.target.files || [])]; }
function getQueue(key) { return state.queues[key]; }
function temporaryObjectUrl(file) { const url = URL.createObjectURL(file); setTimeout(() => URL.revokeObjectURL(url), 60000); return url; }
function clearQueue(key) { state.queues[key] = []; renderPage(); }
function moveItem(key, index, delta) {
  const q = getQueue(key); const to = index + delta;
  if (to < 0 || to >= q.length) return;
  [q[index], q[to]] = [q[to], q[index]]; renderPage();
}
function removeItem(key, index) { getQueue(key).splice(index, 1); renderPage(); }
function addFiles(key, files, predicate = () => true) {
  const queue = getQueue(key); let added = 0;
  for (const file of files) {
    if (!predicate(file)) continue;
    if (queue.some(x => x.name === file.name && x.size === file.size && x.lastModified === file.lastModified)) continue;
    queue.push(file); added++;
  }
  if (!added) toast('没有加入新文件：格式不匹配或文件已在队列中。');
  renderPage();
}

function queueHtml(key, empty = '尚未添加文件') {
  const q = getQueue(key);
  if (!q.length) return `<div class="notice">${empty}</div>`;
  return `<div class="queue">${q.map((file, i) => `
    <div class="queue-item">
      <div class="queue-thumb">${file.type.startsWith('image/') ? `<img src="${temporaryObjectUrl(file)}" alt="">` : escapeHtml(ext(file.name).toUpperCase() || 'FILE')}</div>
      <div class="queue-meta"><b title="${escapeHtml(file.name)}">${escapeHtml(file.name)}</b><span>${formatBytes(file.size)} · ${escapeHtml(file.type || '未知类型')}</span></div>
      <div class="queue-actions"><button data-qmove="${key}:${i}:-1" title="上移">↑</button><button data-qmove="${key}:${i}:1" title="下移">↓</button><button data-qremove="${key}:${i}" title="删除">×</button></div>
    </div>`).join('')}</div>`;
}

function dropzoneHtml(key, acceptText, buttonText = '选择文件') {
  return `<div class="dropzone" data-dropzone="${key}">
    <div><div class="dropzone-icon">＋</div><h3>把文件拖到这里</h3><p>${acceptText}，支持一次选择多个文件</p><button class="button secondary" data-pick="${key}">${buttonText}</button></div>
  </div>`;
}
function progressHtml(id) {
  return `<div id="${id}" class="progress-wrap hidden"><div class="progress-bar"><i></i></div><div class="progress-text"><span class="progress-message">正在准备</span><span class="progress-label">0%</span></div></div>`;
}

async function dynamicImport(url, key) {
  if (!state.deps[key]) state.deps[key] = Promise.race([
    import(url),
    new Promise((_, reject) => setTimeout(() => reject(new Error('加载超时')), 30000)),
  ]);
  try { return await state.deps[key]; }
  catch (error) { delete state.deps[key]; throw new Error(`无法加载网页处理引擎（${key}）。请检查网络或把依赖改为同域托管。\n${error.message}`); }
}
async function getPdfLib() { return dynamicImport(CDN.pdfLib, 'pdf-lib'); }
async function getZip() { const m = await dynamicImport(CDN.zip, 'jszip'); return m.default || m.JSZip || m; }
async function getPdfJs() {
  const m = await dynamicImport(CDN.pdfJs, 'pdfjs');
  m.GlobalWorkerOptions.workerSrc = CDN.pdfWorker;
  return m;
}
async function getOrt() {
  const ort = await dynamicImport(CDN.ort, 'onnxruntime');
  ort.env.wasm.wasmPaths = ORT_BASE;
  ort.env.wasm.numThreads = 1;
  return ort;
}

function renderPage() {
  const [title, subtitle] = pageMeta[state.page];
  $('#pageTitle').textContent = title;
  $('#pageSubtitle').textContent = subtitle;
  $$('.nav-item').forEach(b => b.classList.toggle('active', b.dataset.page === state.page));
  const renderer = { home: renderHome, cutout: renderCutout, image: renderImage, media: renderMedia, recorder: renderRecorder, documents: renderDocuments, pdf: renderPdf, settings: renderSettings }[state.page];
  content.innerHTML = renderer();
  bindCommon();
}

function bindCommon() {
  $$('[data-page-go]').forEach(el => el.addEventListener('click', () => navigate(el.dataset.pageGo)));
  $$('[data-tab]').forEach(el => el.addEventListener('click', () => { const [group, tab] = el.dataset.tab.split(':'); state.tabs[group] = tab; renderPage(); }));
  $$('[data-qremove]').forEach(el => el.addEventListener('click', () => { const [key, i] = el.dataset.qremove.split(':'); removeItem(key, Number(i)); }));
  $$('[data-qmove]').forEach(el => el.addEventListener('click', () => { const [key, i, d] = el.dataset.qmove.split(':'); moveItem(key, Number(i), Number(d)); }));
  $$('[data-clear]').forEach(el => el.addEventListener('click', () => clearQueue(el.dataset.clear)));
  $$('[data-pick]').forEach(el => el.addEventListener('click', () => pickFiles(el.dataset.pick)));
  $$('[data-dropzone]').forEach(zone => {
    zone.addEventListener('dragover', e => { e.preventDefault(); zone.classList.add('dragover'); });
    zone.addEventListener('dragleave', () => zone.classList.remove('dragover'));
    zone.addEventListener('drop', e => { e.preventDefault(); zone.classList.remove('dragover'); routeFiles(zone.dataset.dropzone, fileFromEvent(e)); });
  });
  bindPageActions();
}

function pickFiles(key) {
  const picker = $('#globalFilePicker');
  const accepts = { cutout: 'image/*', image: 'image/*', media: MEDIA_ACCEPT, documents: 'image/*,.txt,.md,.pdf', pdf: '.pdf,application/pdf' };
  picker.accept = accepts[key] || '*/*'; picker.value = '';
  picker.onchange = e => routeFiles(key, fileFromEvent(e));
  picker.click();
}
function routeFiles(key, files) {
  const predicates = {
    cutout: f => f.type.startsWith('image/'), image: f => f.type.startsWith('image/'),
    media: isMediaFile,
    documents: f => f.type.startsWith('image/') || ['txt','md','pdf'].includes(ext(f.name)),
    pdf: f => f.type === 'application/pdf' || ext(f.name) === 'pdf',
  };
  addFiles(key, files, predicates[key]);
}
function navigate(page) {
  const recorder = state.recorder.mediaRecorder;
  if (recorder && recorder.state !== 'inactive' && page !== 'recorder') { toast('录音进行中，请先停止录音再离开本页。'); return; }
  state.page = page; $('#sidebar').classList.remove('open'); history.replaceState(null, '', `#${page}`); renderPage();
}

function renderHome() {
  return `
    <section class="hero"><div class="hero-grid"><div><h2>真正免费的<br>本地文件工具箱</h2><p>不登录、不上传、不加水印。图片、音视频、录音、文档和 PDF 都在你的浏览器中处理。AI 模型由本站同域提供；高级处理库首次使用时下载并由浏览器缓存。</p><div class="hero-actions"><button class="button" data-page-go="cutout">开始抠图</button><button class="button secondary" data-page-go="pdf">处理 PDF</button></div></div><div class="hero-stat"><div class="stat-card"><b>6</b><span>实用模块</span></div><div class="stat-card"><b>0</b><span>文件上传</span></div><div class="stat-card"><b>PWA</b><span>可安装应用</span></div><div class="stat-card"><b>批量</b><span>队列与 ZIP 导出</span></div></div></div></section>
    <div class="section-title"><div><h2>选择工具</h2><p>每个模块都支持拖放，适合的功能会自动启用批量队列。</p></div></div>
    <div class="module-grid">
      ${moduleCard('cutout','✦','智能抠图','U²-NetP 本地推理，透明背景或纯色背景。',['批量','透明 PNG','WebGPU/WASM'])}
      ${moduleCard('image','▧','图片工具','PNG、JPEG、WebP 转换、压缩和尺寸限制。',['格式转换','压缩','缩放'])}
      ${moduleCard('media','▶','音视频','浏览器可解码媒体转 WAV、裁剪与音频合并。',['提取音频','裁剪','合并'])}
      ${moduleCard('recorder','●','录音工具','麦克风、标签页/系统分享音频与混音录制。',['麦克风','分享音频','混音导出'])}
      ${moduleCard('documents','▤','文档转换','图片/TXT/Markdown 转 PDF，PDF 转图片。',['图片转 PDF','文本转 PDF','PDF 转图片'])}
      ${moduleCard('pdf','PDF','PDF 工具','合并、拆分、重排、旋转、水印、页码和区域替换。',['页面管理','批量','区域替换'])}
    </div>
    <div class="section-title"><div><h3>网页端边界</h3></div></div>
    <div class="notice warning">浏览器不能稳定完成 Windows 全系统声音录制、高保真 DOCX 转 PDF、证书数字签名和超大视频转码。网页端不会用假按钮掩盖这些限制；更重的工作由 Windows 版承担。</div>`;
}
function moduleCard(page, icon, title, desc, chips) {
  return `<article class="module-card" data-page-go="${page}"><div class="module-icon">${icon}</div><h3>${title}</h3><p>${desc}</p><div class="chips">${chips.map(x=>`<span class="chip">${x}</span>`).join('')}</div></article>`;
}

function renderCutout() {
  return `<div class="workspace"><div>
    <section class="panel"><h2>自动去除背景</h2><p class="panel-subtitle">第一次运行会下载约 4.6 MB 的 U²-NetP 模型。推理在浏览器中执行，图片本身不会离开设备。</p>
      ${dropzoneHtml('cutout','PNG、JPEG、WebP、BMP 等图片')}
      <div class="section-title"><div><h3>处理队列</h3><p>${getQueue('cutout').length} 个文件</p></div><button class="button danger small" data-clear="cutout">清空</button></div>${queueHtml('cutout')}
    </section>
    <section class="panel"><h3>输出设置</h3><div class="form-grid">
      <div class="field"><label>背景</label><select id="cutoutBackground"><option value="transparent">透明背景</option><option value="solid">纯色背景</option></select></div>
      <div class="field"><label>背景颜色</label><div class="color-row"><input id="cutoutColor" type="color" value="#ffffff"><input id="cutoutColorText" value="#ffffff"></div></div>
      <div class="field"><label>蒙版阈值</label><input id="cutoutThreshold" type="number" min="0" max="1" step="0.01" value="0.45"><small>越高越容易删除半透明边缘。</small></div>
      <div class="field"><label>边缘柔化</label><input id="cutoutFeather" type="number" min="0" max="0.4" step="0.01" value="0.08"><small>平滑主体边缘，避免锯齿。</small></div>
    </div><div class="action-row"><button id="runCutout" class="button">开始批量抠图</button><button id="warmCutout" class="button secondary">仅加载 AI 引擎</button></div>${progressHtml('cutoutProgress')}</section>
  </div><aside><section class="panel"><h3>处理状态</h3><div id="cutoutStatus" class="notice">AI 引擎尚未加载。</div></section><section class="panel"><h3>质量提示</h3><p class="panel-subtitle">U²-NetP 是轻量通用显著目标模型。毛发、玻璃、复杂阴影和多个同等主体可能需要 Windows 版的蒙版画笔继续修整。</p></section></aside></div>`;
}

function renderImage() {
  return `<div class="workspace"><div><section class="panel"><h2>图片转换与压缩</h2><p class="panel-subtitle">浏览器 Canvas 本地解码，支持批量转换；多个结果自动打包为 ZIP。</p>${dropzoneHtml('image','浏览器支持的图片格式')}
    <div class="section-title"><div><h3>处理队列</h3><p>${getQueue('image').length} 个文件</p></div><button class="button danger small" data-clear="image">清空</button></div>${queueHtml('image')}</section></div>
    <aside><section class="panel"><h3>输出设置</h3><div class="form-grid">
      <div class="field"><label>输出格式</label><select id="imageFormat"><option value="image/webp">WebP</option><option value="image/jpeg">JPEG</option><option value="image/png">PNG</option></select></div>
      <div class="field"><label>质量</label><input id="imageQuality" type="number" min="1" max="100" value="85"></div>
      <div class="field"><label>最大边长</label><input id="imageMaxEdge" type="number" min="0" max="16000" value="2560"><small>填 0 保持原尺寸。</small></div>
      <div class="field"><label>JPEG 背景色</label><input id="imageBg" type="color" value="#ffffff"></div>
    </div><div class="action-row"><button id="runImage" class="button">批量转换</button></div>${progressHtml('imageProgress')}</section></aside></div>`;
}

function renderMedia() {
  const tab = state.tabs.media;
  return `<div class="workspace"><div><section class="panel"><h2>音视频本地处理</h2><p class="panel-subtitle">使用浏览器 Web Audio 解码并输出标准 WAV。支持的输入取决于 Edge/Chrome 自身解码能力。</p>
    <div class="tabs">${tabButton('media','extract','提取/转 WAV',tab)}${tabButton('media','trim','裁剪音频',tab)}${tabButton('media','merge','合并音频',tab)}</div>
    ${dropzoneHtml('media','MP3、MP4、M4A、AAC、WAV、FLAC、OGG、WebM，以及浏览器可解码的其他音视频')}
    <div class="section-title"><div><h3>媒体队列</h3><p>${getQueue('media').length} 个文件</p></div><button class="button danger small" data-clear="media">清空</button></div>${queueHtml('media')}</section></div>
    <aside><section class="panel"><h3>${tab === 'merge' ? '合并设置' : tab === 'trim' ? '裁剪设置' : '导出设置'}</h3>
      ${tab === 'trim' ? `<div class="form-grid"><div class="field"><label>开始时间（秒）</label><input id="mediaStart" type="number" min="0" step="0.1" value="0"></div><div class="field"><label>结束时间（秒）</label><input id="mediaEnd" type="number" min="0" step="0.1" value="30"></div></div>` : ''}
      <div class="form-grid"><div class="field"><label>采样率</label><select id="mediaRate"><option value="48000">48 kHz</option><option value="44100">44.1 kHz</option><option value="32000">32 kHz</option></select></div><div class="field"><label>声道</label><select id="mediaChannels"><option value="2">立体声</option><option value="1">单声道</option></select></div></div>
      <div class="notice warning" style="margin-top:14px">网页第一版输出 WAV，保证不依赖服务器。MP3/FLAC/视频转码将在自托管 ffmpeg.wasm 资源加入后启用。</div>
      <div class="action-row"><button id="runMedia" class="button">${tab === 'merge' ? '合并并导出' : tab === 'trim' ? '裁剪并导出' : '转换并导出'}</button></div>${progressHtml('mediaProgress')}
    </section></aside></div>`;
}
function tabButton(group, key, label, active) { return `<button class="tab ${active === key ? 'active':''}" data-tab="${group}:${key}">${label}</button>`; }

function renderRecorder() {
  return `<div class="workspace"><div><section class="panel"><h2>网页录音</h2><p class="panel-subtitle">支持麦克风、浏览器标签页/系统分享音频，以及两者混音。需要 HTTPS；录音数据只保存在当前标签页。</p>
    <div class="recorder-display"><div id="recordDot" class="record-dot">●</div><div id="recordTimer" class="timer">00:00:00</div><div id="recordLevel" class="level">${Array.from({length:36},()=>'<i style="height:5px"></i>').join('')}</div><div id="recordState" class="notice">尚未开始录音。</div>
    <div class="action-row" style="justify-content:center"><button id="startRecord" class="button">开始录音</button><button id="pauseRecord" class="button secondary" disabled>暂停</button><button id="stopRecord" class="button danger" disabled>停止并下载</button></div></div></section></div>
    <aside><section class="panel"><h3>录音设置</h3><div class="field"><label>录音来源</label><select id="recordSource"><option value="microphone">麦克风</option><option value="display">标签页 / 系统分享音频</option><option value="mix">麦克风 + 分享音频混音</option></select><small>录制分享音频时，请在 Edge/Chrome 的分享窗口中勾选“共享标签页音频”或“共享系统音频”。</small></div><div class="field" style="margin-top:12px"><label>编码格式</label><select id="recordMime"><option value="auto">自动选择兼容格式</option><option value="audio/webm;codecs=opus">WebM / Opus</option><option value="audio/ogg;codecs=opus">OGG / Opus</option><option value="audio/webm">WebM</option></select><small>Edge/Chrome 通常导出 WebM/Opus；网页无法原生保证 MP3 编码。</small></div><div class="field" style="margin-top:12px"><label>音频码率</label><select id="recordBitrate"><option value="128000">128 kbps</option><option value="192000" selected>192 kbps</option><option value="256000">256 kbps</option></select></div></section><section class="panel"><h3>网页限制</h3><p class="panel-subtitle">系统声音捕获能力由浏览器和操作系统决定。Windows 桌面版后续仍使用 WASAPI，才能稳定录制全部系统声音并导出 MP3/FLAC。</p></section></aside></div>`;
}

function renderDocuments() {
  const tab = state.tabs.documents;
  return `<div class="workspace"><div><section class="panel"><h2>文档转换</h2><p class="panel-subtitle">图片与文本生成 PDF 时全部在浏览器完成；中文文本会先绘制到页面画布，再嵌入 PDF，避免字体缺失。</p>
    <div class="tabs">${tabButton('documents','images','图片转 PDF',tab)}${tabButton('documents','text','TXT / Markdown 转 PDF',tab)}${tabButton('documents','pdf-images','PDF 转图片',tab)}</div>
    ${tab !== 'text' ? dropzoneHtml('documents', tab === 'pdf-images' ? 'PDF 文件' : 'PNG、JPEG、WebP 等图片') : `<div class="field"><label>文档内容</label><textarea id="documentText" rows="16" placeholder="# 标题\n\n输入 TXT 或 Markdown 内容……"></textarea></div>`}
    ${tab !== 'text' ? `<div class="section-title"><div><h3>文件队列</h3><p>${getQueue('documents').length} 个文件</p></div><button class="button danger small" data-clear="documents">清空</button></div>${queueHtml('documents')}` : ''}
    </section></div><aside><section class="panel"><h3>转换设置</h3>
      ${tab === 'images' ? `<div class="form-grid"><div class="field"><label>页面</label><select id="docPageSize"><option value="a4">A4</option><option value="letter">Letter</option><option value="original">原图尺寸</option></select></div><div class="field"><label>方向</label><select id="docOrientation"><option value="auto">自动</option><option value="portrait">纵向</option><option value="landscape">横向</option></select></div><div class="field"><label>边距（mm）</label><input id="docMargin" type="number" min="0" max="60" value="10"></div><div class="field"><label>适配</label><select id="docFit"><option value="contain">完整显示</option><option value="cover">填满页面</option></select></div></div>` : ''}
      ${tab === 'text' ? `<div class="form-grid"><div class="field"><label>格式</label><select id="docTextMode"><option value="markdown">Markdown</option><option value="plain">纯文本</option></select></div><div class="field"><label>字号</label><input id="docFontSize" type="number" min="10" max="36" value="18"></div><div class="field"><label>页面</label><select id="docTextPage"><option value="a4">A4</option><option value="letter">Letter</option></select></div><div class="field"><label>页码</label><select id="docPageNumber"><option value="yes">显示</option><option value="no">隐藏</option></select></div></div>` : ''}
      ${tab === 'pdf-images' ? `<div class="form-grid"><div class="field"><label>页码</label><input id="pdfImagePages" value="all" placeholder="all 或 1,3-5"></div><div class="field"><label>格式</label><select id="pdfImageFormat"><option value="image/png">PNG</option><option value="image/jpeg">JPEG</option></select></div><div class="field"><label>清晰度</label><select id="pdfImageScale"><option value="1.5">普通</option><option value="2">高清</option><option value="3">超清</option></select></div><div class="field"><label>JPEG 质量</label><input id="pdfImageQuality" type="number" min="40" max="100" value="90"></div></div>` : ''}
      <div class="action-row"><button id="runDocuments" class="button">开始转换</button></div>${progressHtml('documentProgress')}
      <div class="notice warning" style="margin-top:14px">网页端暂不承诺高保真 DOCX 转 PDF。复杂 Office 文档请使用 Windows 版和本机 LibreOffice。</div>
    </section></aside></div>`;
}

function renderPdf() {
  const tab = state.tabs.pdf;
  return `<div class="workspace"><div><section class="panel"><h2>PDF 页面工具</h2><p class="panel-subtitle">不会覆盖原文件。处理完成后浏览器会下载一个新 PDF 或 ZIP。</p>
    <div class="tabs">${tabButton('pdf','merge','合并',tab)}${tabButton('pdf','split','拆分',tab)}${tabButton('pdf','reorder','重排/旋转',tab)}${tabButton('pdf','decorate','水印/页码',tab)}${tabButton('pdf','replace','区域替换文字',tab)}</div>
    ${dropzoneHtml('pdf','PDF 文件')}
    <div class="section-title"><div><h3>PDF 队列</h3><p>${getQueue('pdf').length} 个文件</p></div><button class="button danger small" data-clear="pdf">清空</button></div>${queueHtml('pdf')}</section></div>
    <aside><section class="panel"><h3>操作设置</h3>
      ${tab === 'merge' ? `<p class="panel-subtitle">按队列顺序合并。使用 ↑↓ 调整文件顺序。</p>` : ''}
      ${tab === 'split' ? `<div class="field"><label>拆分分组</label><input id="pdfSplitGroups" value="1-3;4;5-8" placeholder="1-3;4;5-8"><small>分号分隔输出文件，每组支持逗号和范围。</small></div>` : ''}
      ${tab === 'reorder' ? `<div class="form-grid"><div class="field full"><label>新页面顺序</label><input id="pdfOrder" value="1-3" placeholder="3,1,2,2 或 8-1"><small>省略页面即删除，重复页码即复制。</small></div><div class="field"><label>统一旋转</label><select id="pdfRotate"><option value="0">不旋转</option><option value="90">90°</option><option value="180">180°</option><option value="270">270°</option></select></div></div>` : ''}
      ${tab === 'decorate' ? `<div class="form-grid"><div class="field full"><label>水印文字</label><input id="pdfWatermark" value="RockwellTools" placeholder="留空则只加页码"></div><div class="field"><label>水印透明度</label><input id="pdfOpacity" type="number" min="0.05" max="1" step="0.05" value="0.2"></div><div class="field"><label>页码</label><select id="pdfPageNumbers"><option value="yes">添加页码</option><option value="no">不添加</option></select></div></div>` : ''}
      ${tab === 'replace' ? `<div class="form-grid"><div class="field full"><label>页面</label><input id="replacePages" value="1" placeholder="1,3-5"></div><div class="field"><label>X（%）</label><input id="replaceX" type="number" min="0" max="100" value="10"></div><div class="field"><label>Y（%）</label><input id="replaceY" type="number" min="0" max="100" value="10"><small>从页面左上角计算。</small></div><div class="field"><label>宽度（%）</label><input id="replaceW" type="number" min="1" max="100" value="50"></div><div class="field"><label>高度（%）</label><input id="replaceH" type="number" min="1" max="100" value="10"></div><div class="field"><label>背景色</label><input id="replaceBg" type="color" value="#ffffff"></div><div class="field"><label>文字颜色</label><input id="replaceColor" type="color" value="#111111"></div><div class="field full"><label>新文字</label><textarea id="replaceText">新的文字</textarea></div></div><div class="notice warning" style="margin-top:12px">这是视觉覆盖。原文字对象通常仍在下层；敏感信息不能只靠此功能删除。</div>` : ''}
      <div class="action-row"><button id="runPdf" class="button">执行并下载</button><button id="previewPdf" class="button secondary">预览第一页</button></div>${progressHtml('pdfProgress')}
    </section><section class="panel"><h3>预览</h3><div id="pdfPreview" class="preview-card"><span class="panel-subtitle">选择一个 PDF 后点击预览</span></div></section></aside></div>`;
}

function renderSettings() {
  return `<div class="settings-grid"><section class="panel"><h2>外观</h2><div class="form-grid"><div class="field"><label>主题</label><select id="themeSelect"><option value="system">跟随系统</option><option value="light">浅色</option><option value="dark">深色</option></select></div><div class="field"><label>强调色</label><input id="accentColor" type="color" value="${localStorage.getItem('rockwell-accent') || '#6d5dfc'}"></div></div></section>
    <section class="panel"><h2>PWA 与缓存</h2><p class="panel-subtitle">安装后可以像应用一样从开始菜单启动。浏览器会缓存界面和已使用的处理引擎。</p><div class="action-row"><button id="settingsInstall" class="button">安装网页应用</button><button id="clearCaches" class="button danger">清除网页缓存</button></div></section>
    <section class="panel"><h2>隐私状态</h2><div class="notice success">所有已实现转换均在当前浏览器中执行。RockwellTools Web 没有文件上传 API、账号系统或遥测脚本。</div><div id="dependencyStatus" class="chips" style="margin-top:14px"><span class="chip">PDF：按需加载</span><span class="chip">AI：按需加载</span><span class="chip">Web Audio：浏览器原生</span></div></section>
    <section class="panel"><h2>版本</h2><p class="panel-subtitle">RockwellTools Web ${APP_VERSION}<br>发布者：Rockwell576<br>目标：免费、无广告、无水印、无订阅、无上传。</p></section>
    <section class="panel" style="grid-column:1/-1"><h2>第三方许可</h2><table class="license-table"><thead><tr><th>组件</th><th>用途</th><th>许可</th></tr></thead><tbody><tr><td>pdf-lib 1.17.1</td><td>创建和修改 PDF</td><td>MIT</td></tr><tr><td>PDF.js 6.1.200</td><td>PDF 渲染</td><td>Apache-2.0</td></tr><tr><td>ONNX Runtime Web 1.27.0</td><td>浏览器 AI 推理</td><td>MIT</td></tr><tr><td>U²-Net / U²-NetP</td><td>显著目标分割模型</td><td>Apache-2.0（原项目）</td></tr><tr><td>JSZip 3.10.1</td><td>批量结果打包</td><td>MIT / GPL-3.0-or-later 双许可</td></tr></tbody></table></section></div>`;
}

function bindPageActions() {
  if ($('#runCutout')) $('#runCutout').addEventListener('click', runCutoutBatch);
  if ($('#warmCutout')) $('#warmCutout').addEventListener('click', async () => { try { await ensureCutoutEngine(); toast('AI 引擎与模型已加载。','success'); } catch(e) { toast(e.message,'error'); } });
  if ($('#runImage')) $('#runImage').addEventListener('click', runImageBatch);
  if ($('#runMedia')) $('#runMedia').addEventListener('click', runMediaTool);
  if ($('#startRecord')) $('#startRecord').addEventListener('click', startRecording);
  if ($('#pauseRecord')) $('#pauseRecord').addEventListener('click', togglePauseRecording);
  if ($('#stopRecord')) $('#stopRecord').addEventListener('click', stopRecording);
  if ($('#runDocuments')) $('#runDocuments').addEventListener('click', runDocumentsTool);
  if ($('#runPdf')) $('#runPdf').addEventListener('click', runPdfTool);
  if ($('#previewPdf')) $('#previewPdf').addEventListener('click', previewPdfFirstPage);
  if ($('#themeSelect')) {
    $('#themeSelect').value = localStorage.getItem('rockwell-theme') || 'system';
    $('#themeSelect').addEventListener('change', e => { localStorage.setItem('rockwell-theme', e.target.value); applyTheme(); });
  }
  if ($('#accentColor')) $('#accentColor').addEventListener('input', e => { localStorage.setItem('rockwell-accent', e.target.value); applyTheme(); });
  if ($('#clearCaches')) $('#clearCaches').addEventListener('click', clearWebCaches);
  if ($('#settingsInstall')) $('#settingsInstall').addEventListener('click', installPwa);
}

async function imageBitmap(fileOrBlob) {
  try { return await createImageBitmap(fileOrBlob, { imageOrientation: 'from-image' }); }
  catch {
    const url = URL.createObjectURL(fileOrBlob);
    try {
      const img = new Image(); img.decoding = 'async'; img.src = url; await img.decode(); return img;
    } finally { setTimeout(() => URL.revokeObjectURL(url), 1000); }
  }
}
function canvasBlob(canvas, type = 'image/png', quality = .92) {
  return new Promise((resolve, reject) => canvas.toBlob(blob => blob ? resolve(blob) : reject(new Error('浏览器无法编码该图片格式。')), type, quality));
}
function fitSize(width, height, maxEdge) {
  if (!maxEdge || Math.max(width,height) <= maxEdge) return [width,height];
  const scale = maxEdge / Math.max(width,height); return [Math.max(1,Math.round(width*scale)),Math.max(1,Math.round(height*scale))];
}

async function runImageBatch() {
  const files = getQueue('image'); if (!files.length) return toast('请先添加图片。');
  const type = $('#imageFormat').value; const quality = Number($('#imageQuality').value)/100; const maxEdge = Number($('#imageMaxEdge').value); const bg = $('#imageBg').value;
  const progress = $('#imageProgress'); progress.classList.remove('hidden');
  try {
    const outputs = [];
    for (let i=0;i<files.length;i++) {
      setProgress('imageProgress', i/files.length*100, `正在转换 ${files[i].name}`);
      const bitmap = await imageBitmap(files[i]); const [w,h] = fitSize(bitmap.width,bitmap.height,maxEdge);
      const canvas = document.createElement('canvas'); canvas.width=w; canvas.height=h; const ctx=canvas.getContext('2d');
      if (type === 'image/jpeg') { ctx.fillStyle=bg; ctx.fillRect(0,0,w,h); }
      ctx.drawImage(bitmap,0,0,w,h); bitmap.close?.();
      const blob = await canvasBlob(canvas,type,quality);
      const suffix = type === 'image/png' ? 'png' : type === 'image/jpeg' ? 'jpg' : 'webp';
      outputs.push({ name:`${stem(files[i].name)}.${suffix}`, blob });
    }
    setProgress('imageProgress',100,'转换完成'); await downloadOutputs(outputs,'RockwellTools-images.zip'); toast(`已完成 ${outputs.length} 张图片。`,'success');
  } catch(e) { toast(e.message,'error'); } finally { setTimeout(()=>progress.classList.add('hidden'),1500); }
}

async function downloadOutputs(outputs, zipName) {
  if (outputs.length === 1) return downloadBlob(outputs[0].blob, outputs[0].name);
  try {
    const JSZip = await getZip(); const zip = new JSZip(); outputs.forEach(x => zip.file(x.name,x.blob));
    const blob = await zip.generateAsync({type:'blob',compression:'DEFLATE',compressionOptions:{level:6}}); downloadBlob(blob,zipName);
  } catch {
    outputs.forEach((item, index) => setTimeout(() => downloadBlob(item.blob, item.name), index * 250));
    toast('ZIP 引擎不可用，已改为逐个下载结果。');
  }
}

async function ensureCutoutEngine() {
  if (state.ortSession) return state.ortSession;
  const status = $('#cutoutStatus');
  if (status) status.textContent = '正在加载 ONNX Runtime 与站内 U²-NetP 模型……';

  const ort = await getOrt();
  let response;
  try {
    response = await fetch(MODEL_URL, { cache: 'no-cache', credentials: 'same-origin' });
  } catch (error) {
    throw new Error(`无法读取站内 AI 模型：${MODEL_URL}\n${error.message}`);
  }

  if (!response.ok) {
    throw new Error(
      `AI 模型尚未部署：${MODEL_URL} 返回 HTTP ${response.status}。` +
      '请把 u2netp.onnx 上传到网站 models 目录后刷新页面。'
    );
  }

  const model = await response.arrayBuffer();
  if (model.byteLength < 4_000_000) {
    throw new Error(
      `AI 模型文件不完整（当前 ${Math.round(model.byteLength / 1024)} KB）。` +
      '请重新上传完整的 models/u2netp.onnx。'
    );
  }

  if (globalThis.crypto?.subtle) {
    const digest = await crypto.subtle.digest('SHA-256', model);
    const actual = [...new Uint8Array(digest)].map(value => value.toString(16).padStart(2, '0')).join('');
    if (actual !== MODEL_SHA256) {
      throw new Error(
        `AI 模型校验失败。期望 ${MODEL_SHA256}，实际 ${actual}。` +
        '请删除损坏文件并重新部署。'
      );
    }
  }

  const providers = navigator.gpu ? ['webgpu', 'wasm'] : ['wasm'];
  try {
    state.ortSession = await ort.InferenceSession.create(model, {
      executionProviders: providers,
      graphOptimizationLevel: 'all',
    });
  } catch {
    state.ortSession = await ort.InferenceSession.create(model, {
      executionProviders: ['wasm'],
      graphOptimizationLevel: 'all',
    });
  }

  if (status) {
    status.className = 'notice success';
    status.textContent = `AI 引擎已加载：${navigator.gpu ? 'WebGPU 优先' : 'WASM CPU'}；模型来自本站。`;
  }
  return state.ortSession;
}

async function runCutoutBatch() {
  const files = getQueue('cutout'); if (!files.length) return toast('请先添加图片。');
  const progress = $('#cutoutProgress'); progress.classList.remove('hidden');
  try {
    const session = await ensureCutoutEngine(); const ort = await getOrt(); const outputs=[];
    for (let i=0;i<files.length;i++) {
      setProgress('cutoutProgress',i/files.length*100,`AI 正在处理 ${files[i].name}`);
      const result = await cutoutOne(files[i],session,ort);
      outputs.push({name:`${stem(files[i].name)}-cutout.png`,blob:result});
    }
    setProgress('cutoutProgress',100,'抠图完成'); await downloadOutputs(outputs,'RockwellTools-cutout.zip'); toast(`已完成 ${outputs.length} 张抠图。`,'success');
  } catch(e) { toast(e.message,'error'); } finally { setTimeout(()=>progress.classList.add('hidden'),1600); }
}

async function cutoutOne(file, session, ort) {
  const bitmap = await imageBitmap(file); const size=320;
  const scale=Math.min(size/bitmap.width,size/bitmap.height); const cw=Math.max(1,Math.round(bitmap.width*scale)); const ch=Math.max(1,Math.round(bitmap.height*scale)); const ox=Math.floor((size-cw)/2); const oy=Math.floor((size-ch)/2);
  const inputCanvas=document.createElement('canvas'); inputCanvas.width=size; inputCanvas.height=size; const ictx=inputCanvas.getContext('2d',{willReadFrequently:true}); ictx.fillStyle='black'; ictx.fillRect(0,0,size,size); ictx.drawImage(bitmap,ox,oy,cw,ch);
  const pixels=ictx.getImageData(0,0,size,size).data; const data=new Float32Array(3*size*size); const mean=[.485,.456,.406],std=[.229,.224,.225];
  for(let i=0,p=0;i<size*size;i++,p+=4){data[i]=(pixels[p]/255-mean[0])/std[0];data[size*size+i]=(pixels[p+1]/255-mean[1])/std[1];data[2*size*size+i]=(pixels[p+2]/255-mean[2])/std[2];}
  const tensor=new ort.Tensor('float32',data,[1,3,size,size]); const feeds={}; feeds[session.inputNames[0]]=tensor; const result=await session.run(feeds); const out=result[session.outputNames[0]].data;
  let min=Infinity,max=-Infinity; for(let i=0;i<size*size;i++){const v=out[i]; if(v<min)min=v;if(v>max)max=v;} const range=Math.max(1e-6,max-min);
  const maskCanvas=document.createElement('canvas'); maskCanvas.width=size;maskCanvas.height=size;const mctx=maskCanvas.getContext('2d');const image=mctx.createImageData(size,size);
  for(let i=0;i<size*size;i++){const v=Math.max(0,Math.min(1,(out[i]-min)/range)); const c=Math.round(v*255); const p=i*4; image.data[p]=image.data[p+1]=image.data[p+2]=c; image.data[p+3]=255;} mctx.putImageData(image,0,0);
  const fullMask=document.createElement('canvas'); fullMask.width=bitmap.width;fullMask.height=bitmap.height;const fctx=fullMask.getContext('2d',{willReadFrequently:true});fctx.imageSmoothingQuality='high';fctx.drawImage(maskCanvas,ox,oy,cw,ch,0,0,bitmap.width,bitmap.height);
  const maskData=fctx.getImageData(0,0,bitmap.width,bitmap.height); const threshold=Math.max(0,Math.min(1,Number($('#cutoutThreshold').value))); const feather=Math.max(.001,Number($('#cutoutFeather').value));
  const output=document.createElement('canvas');output.width=bitmap.width;output.height=bitmap.height;const octx=output.getContext('2d',{willReadFrequently:true});octx.drawImage(bitmap,0,0); const src=octx.getImageData(0,0,output.width,output.height);
  const solid=$('#cutoutBackground').value==='solid'; const bg=hexRgb($('#cutoutColor').value);
  for(let p=0;p<src.data.length;p+=4){const v=maskData.data[p]/255; const alpha=smoothstep(threshold-feather,threshold+feather,v); if(solid){src.data[p]=Math.round(src.data[p]*alpha+bg.r*(1-alpha));src.data[p+1]=Math.round(src.data[p+1]*alpha+bg.g*(1-alpha));src.data[p+2]=Math.round(src.data[p+2]*alpha+bg.b*(1-alpha));src.data[p+3]=255;} else src.data[p+3]=Math.round(src.data[p+3]*alpha);}
  octx.putImageData(src,0,0); bitmap.close?.(); return canvasBlob(output,'image/png');
}
function smoothstep(a,b,x){const t=Math.max(0,Math.min(1,(x-a)/(b-a)));return t*t*(3-2*t);}
function hexRgb(hex){const h=hex.replace('#','');return{r:parseInt(h.slice(0,2),16),g:parseInt(h.slice(2,4),16),b:parseInt(h.slice(4,6),16)};}

async function runMediaTool() {
  const files=getQueue('media'); if(!files.length) return toast('请先添加音频或视频文件。');
  const tab=state.tabs.media; const rate=Number($('#mediaRate').value); const channels=Number($('#mediaChannels').value); const progress=$('#mediaProgress');progress.classList.remove('hidden');
  try{
    if(tab==='merge'){
      const buffers=[];
      for(let i=0;i<files.length;i++){setProgress('mediaProgress',i/files.length*65,`正在解码 ${files[i].name}`);buffers.push(await decodeAudioFile(files[i]));}
      setProgress('mediaProgress',72,'正在统一采样率并合并'); const merged=await mergeAudioBuffers(buffers,rate,channels); const blob=encodeWav(merged,channels,rate); downloadBlob(blob,'RockwellTools-merged.wav');
    }else{
      const outputs=[];
      for(let i=0;i<files.length;i++){
        setProgress('mediaProgress',i/files.length*90,`正在处理 ${files[i].name}`); const decoded=await decodeAudioFile(files[i]);
        let start=0,end=decoded.duration; if(tab==='trim'){start=Math.max(0,Number($('#mediaStart').value));end=Math.min(decoded.duration,Number($('#mediaEnd').value));if(!(end>start))throw new Error('结束时间必须大于开始时间。');}
        const sliced=await sliceAndResample(decoded,start,end,rate,channels); outputs.push({name:`${stem(files[i].name)}${tab==='trim'?'-trim':''}.wav`,blob:encodeWav(sliced,channels,rate)});
      }
      await downloadOutputs(outputs,'RockwellTools-audio.zip');
    }
    setProgress('mediaProgress',100,'处理完成');toast('音频处理完成。','success');
  }catch(e){toast(`媒体处理失败：${e.message}`,'error');}finally{setTimeout(()=>progress.classList.add('hidden'),1600);}
}
async function decodeAudioFile(file){
  const ctx=new (window.AudioContext||window.webkitAudioContext)();
  try{return await ctx.decodeAudioData((await file.arrayBuffer()).slice(0));}
  catch{throw new Error(`浏览器无法解码 ${file.name}。视频容器、无损编码或受保护媒体请使用 Windows 版。`);}
  finally{ctx.close();}
}
async function sliceAndResample(buffer,start,end,rate,channels){
  const frames=Math.max(1,Math.ceil((end-start)*rate)); const offline=new OfflineAudioContext(channels,frames,rate); const src=offline.createBufferSource();src.buffer=buffer;
  src.connect(offline.destination); src.start(0,start,end-start); return offline.startRendering();
}
async function mergeAudioBuffers(buffers,rate,channels){
  const durations=buffers.map(b=>b.duration);const total=durations.reduce((a,b)=>a+b,0);const offline=new OfflineAudioContext(channels,Math.ceil(total*rate),rate);let offset=0;
  for(const buffer of buffers){const src=offline.createBufferSource();src.buffer=buffer;src.connect(offline.destination);src.start(offset);offset+=buffer.duration;}
  return offline.startRendering();
}
function encodeWav(buffer,channels=2,rate=48000){
  const frames=buffer.length;const bytesPerSample=2;const blockAlign=channels*bytesPerSample;const out=new ArrayBuffer(44+frames*blockAlign);const view=new DataView(out);let o=0;
  const str=s=>{for(let i=0;i<s.length;i++)view.setUint8(o++,s.charCodeAt(i));};str('RIFF');view.setUint32(o,36+frames*blockAlign,true);o+=4;str('WAVE');str('fmt ');view.setUint32(o,16,true);o+=4;view.setUint16(o,1,true);o+=2;view.setUint16(o,channels,true);o+=2;view.setUint32(o,rate,true);o+=4;view.setUint32(o,rate*blockAlign,true);o+=4;view.setUint16(o,blockAlign,true);o+=2;view.setUint16(o,16,true);o+=2;str('data');view.setUint32(o,frames*blockAlign,true);o+=4;
  const channelData=Array.from({length:channels},(_,c)=>buffer.getChannelData(Math.min(c,buffer.numberOfChannels-1)));
  for(let i=0;i<frames;i++)for(let c=0;c<channels;c++){const s=Math.max(-1,Math.min(1,channelData[c][i]||0));view.setInt16(o,s<0?s*0x8000:s*0x7fff,true);o+=2;}
  return new Blob([out],{type:'audio/wav'});
}

function parsePageList(expr,total){
  const value=(expr||'all').trim().toLowerCase();if(value==='all'||value==='*')return Array.from({length:total},(_,i)=>i);
  const result=[];for(const token of value.split(',').map(x=>x.trim()).filter(Boolean)){
    const m=token.match(/^(\d+)\s*-\s*(\d+)$/);if(m){const a=Number(m[1]),b=Number(m[2]),step=a<=b?1:-1;for(let n=a;step>0?n<=b:n>=b;n+=step){if(n<1||n>total)throw new Error(`页码 ${n} 超出 1-${total}`);result.push(n-1);}}
    else{const n=Number(token);if(!Number.isInteger(n)||n<1||n>total)throw new Error(`页码 ${token} 无效，范围为 1-${total}`);result.push(n-1);}
  }if(!result.length)throw new Error('页码表达式为空。');return result;
}
function pageSizePoints(key){return key==='letter'?[612,792]:[595.28,841.89];}
async function imageForPdf(pdfDoc,file){
  if(file.type==='image/jpeg'||/\.jpe?g$/i.test(file.name))return {image:await pdfDoc.embedJpg(await file.arrayBuffer())};
  let blob=file;if(file.type!=='image/png'){const bitmap=await imageBitmap(file);const c=document.createElement('canvas');c.width=bitmap.width;c.height=bitmap.height;c.getContext('2d').drawImage(bitmap,0,0);blob=await canvasBlob(c,'image/png');bitmap.close?.();}
  return {image:await pdfDoc.embedPng(await blob.arrayBuffer())};
}
async function runDocumentsTool(){
  const tab=state.tabs.documents;const progress=$('#documentProgress');progress.classList.remove('hidden');
  try{
    if(tab==='images')await imagesToPdf();else if(tab==='text')await textToPdf();else await pdfToImages();setProgress('documentProgress',100,'转换完成');toast('文档转换完成。','success');
  }catch(e){toast(e.message,'error');}finally{setTimeout(()=>progress.classList.add('hidden'),1600);}
}
async function imagesToPdf(){
  const files=getQueue('documents').filter(f=>f.type.startsWith('image/'));if(!files.length)throw new Error('请添加图片。');const {PDFDocument}=await getPdfLib();const doc=await PDFDocument.create();const sizeKey=$('#docPageSize').value;const orientation=$('#docOrientation').value;const margin=Number($('#docMargin').value)*72/25.4;const fit=$('#docFit').value;
  for(let i=0;i<files.length;i++){setProgress('documentProgress',i/files.length*90,`正在加入 ${files[i].name}`);const {image}=await imageForPdf(doc,files[i]);let [pw,ph]=sizeKey==='original'?[image.width*72/96,image.height*72/96]:pageSizePoints(sizeKey);const wantsLandscape=orientation==='landscape'||(orientation==='auto'&&image.width>image.height);if(wantsLandscape&&ph>pw)[pw,ph]=[ph,pw];if(orientation==='portrait'&&pw>ph)[pw,ph]=[ph,pw];const page=doc.addPage([pw,ph]);const maxW=pw-margin*2,maxH=ph-margin*2;const scale=fit==='cover'?Math.max(maxW/image.width,maxH/image.height):Math.min(maxW/image.width,maxH/image.height);const w=image.width*scale,h=image.height*scale;page.drawImage(image,{x:(pw-w)/2,y:(ph-h)/2,width:w,height:h});}
  downloadBlob(new Blob([await doc.save()],{type:'application/pdf'}),'RockwellTools-images.pdf');
}
async function textToPdf(){
  const text=$('#documentText').value;if(!text.trim())throw new Error('请输入文本内容。');const mode=$('#docTextMode').value;const fontSize=Number($('#docFontSize').value);const pageKind=$('#docTextPage').value;const showPage=$('#docPageNumber').value==='yes';setProgress('documentProgress',12,'正在排版文本');const canvases=renderTextCanvases(text,{mode,fontSize,pageKind,showPage});const {PDFDocument}=await getPdfLib();const doc=await PDFDocument.create();const [pw,ph]=pageSizePoints(pageKind);
  for(let i=0;i<canvases.length;i++){setProgress('documentProgress',20+i/canvases.length*70,`正在生成第 ${i+1} 页`);const png=await canvasBlob(canvases[i],'image/png');const image=await doc.embedPng(await png.arrayBuffer());const page=doc.addPage([pw,ph]);page.drawImage(image,{x:0,y:0,width:pw,height:ph});}
  downloadBlob(new Blob([await doc.save()],{type:'application/pdf'}),'RockwellTools-document.pdf');
}
function renderTextCanvases(text,{mode,fontSize,pageKind,showPage}){
  const dims=pageKind==='letter'?[1275,1650]:[1240,1754],margin=105,lineGap=1.55;const pages=[];let canvas,ctx,y;const newPage=()=>{canvas=document.createElement('canvas');canvas.width=dims[0];canvas.height=dims[1];ctx=canvas.getContext('2d');ctx.fillStyle='#fff';ctx.fillRect(0,0,canvas.width,canvas.height);ctx.fillStyle='#171717';ctx.textBaseline='top';y=margin;pages.push(canvas);};newPage();
  const blocks=parseTextBlocks(text,mode);const ensure=height=>{if(y+height>dims[1]-margin-40)newPage();};
  for(const block of blocks){let size=fontSize,weight='400',indent=0,pre=false;if(block.type==='h1'){size=fontSize*1.8;weight='700';}else if(block.type==='h2'){size=fontSize*1.45;weight='700';}else if(block.type==='h3'){size=fontSize*1.2;weight='700';}else if(block.type==='quote'){indent=32;}else if(block.type==='code'){pre=true;size=fontSize*.88;}ctx.font=`${weight} ${size*1.5}px "Microsoft YaHei", "Noto Sans CJK SC", sans-serif`;const lineHeight=size*1.5*lineGap;const prefix=block.type==='li'?'• ':block.type==='ol'?`${block.index}. `:block.type==='quote'?'│ ':'';const lines=wrapCanvasText(ctx,prefix+block.text,dims[0]-margin*2-indent);ensure(lines.length*lineHeight+(block.type.startsWith('h')?20:12));if(pre){ctx.fillStyle='#f3f4f7';ctx.fillRect(margin+indent-12,y-8,dims[0]-margin*2-indent+24,lines.length*lineHeight+16);ctx.fillStyle='#222';}
    for(const line of lines){ctx.fillText(line,margin+indent,y);y+=lineHeight;}y+=block.type.startsWith('h')?18:12;
  }
  if(showPage)pages.forEach((p,i)=>{const c=p.getContext('2d');c.fillStyle='#777';c.font='22px sans-serif';c.textAlign='center';c.fillText(String(i+1),p.width/2,p.height-54);c.textAlign='left';});return pages;
}
function parseTextBlocks(text,mode){
  if(mode==='plain')return text.split(/\r?\n/).map(x=>({type:'p',text:x||' '}));const out=[];let inCode=false,code=[];let ol=0;
  for(const raw of text.split(/\r?\n/)){if(raw.trim().startsWith('```')){if(inCode){out.push({type:'code',text:code.join('\n')});code=[];}inCode=!inCode;continue;}if(inCode){code.push(raw);continue;}let m;if((m=raw.match(/^(#{1,3})\s+(.*)$/)))out.push({type:`h${m[1].length}`,text:m[2]});else if((m=raw.match(/^[-*+]\s+(.*)$/)))out.push({type:'li',text:m[1]});else if((m=raw.match(/^\d+[.)]\s+(.*)$/))){ol++;out.push({type:'ol',text:m[1],index:ol});}else if((m=raw.match(/^>\s?(.*)$/)))out.push({type:'quote',text:m[1]});else{ol=0;out.push({type:'p',text:raw||' '});}}
  if(code.length)out.push({type:'code',text:code.join('\n')});return out;
}
function wrapCanvasText(ctx,text,maxWidth){
  const lines=[];for(const paragraph of String(text).split('\n')){let line='';for(const char of paragraph){const next=line+char;if(ctx.measureText(next).width>maxWidth&&line){lines.push(line);line=char;}else line=next;}lines.push(line||' ');}return lines;
}
async function pdfToImages(){
  const files=getQueue('documents').filter(f=>ext(f.name)==='pdf'||f.type==='application/pdf');if(!files.length)throw new Error('请添加 PDF。');const pdfjs=await getPdfJs();const type=$('#pdfImageFormat').value,scale=Number($('#pdfImageScale').value),quality=Number($('#pdfImageQuality').value)/100;const outputs=[];
  for(let fi=0;fi<files.length;fi++){const pdf=await pdfjs.getDocument({data:new Uint8Array(await files[fi].arrayBuffer())}).promise;const pages=parsePageList($('#pdfImagePages').value,pdf.numPages);for(let pi=0;pi<pages.length;pi++){setProgress('documentProgress',(fi/files.length+pi/pages.length/files.length)*90,`渲染 ${files[fi].name} 第 ${pages[pi]+1} 页`);const page=await pdf.getPage(pages[pi]+1);const viewport=page.getViewport({scale});const canvas=document.createElement('canvas');canvas.width=Math.ceil(viewport.width);canvas.height=Math.ceil(viewport.height);const ctx=canvas.getContext('2d');if(type==='image/jpeg'){ctx.fillStyle='#fff';ctx.fillRect(0,0,canvas.width,canvas.height);}await page.render({canvasContext:ctx,viewport}).promise;const suffix=type==='image/png'?'png':'jpg';outputs.push({name:`${stem(files[fi].name)}-p${pages[pi]+1}.${suffix}`,blob:await canvasBlob(canvas,type,quality)});}}
  await downloadOutputs(outputs,'RockwellTools-pdf-images.zip');
}

async function runPdfTool(){
  const files=getQueue('pdf').filter(f=>ext(f.name)==='pdf'||f.type==='application/pdf');if(!files.length)return toast('请先添加 PDF。');const tab=state.tabs.pdf;const progress=$('#pdfProgress');progress.classList.remove('hidden');
  try{if(tab==='merge')await pdfMerge(files);else if(tab==='split')await pdfSplit(files[0]);else if(tab==='reorder')await pdfReorder(files[0]);else if(tab==='decorate')await pdfDecorate(files[0]);else await pdfReplace(files[0]);setProgress('pdfProgress',100,'处理完成');toast('PDF 处理完成。','success');}
  catch(e){toast(e.message,'error');}finally{setTimeout(()=>progress.classList.add('hidden'),1600);}
}
async function pdfMerge(files){
  const {PDFDocument}=await getPdfLib();const out=await PDFDocument.create();for(let i=0;i<files.length;i++){setProgress('pdfProgress',i/files.length*90,`正在合并 ${files[i].name}`);const src=await PDFDocument.load(await files[i].arrayBuffer(),{ignoreEncryption:false});const pages=await out.copyPages(src,src.getPageIndices());pages.forEach(p=>out.addPage(p));}downloadBlob(new Blob([await out.save()],{type:'application/pdf'}),'RockwellTools-merged.pdf');
}
async function pdfSplit(file){
  const {PDFDocument}=await getPdfLib();const src=await PDFDocument.load(await file.arrayBuffer());const groups=$('#pdfSplitGroups').value.split(';').map(x=>x.trim()).filter(Boolean);if(!groups.length)throw new Error('请输入拆分分组。');const outputs=[];for(let i=0;i<groups.length;i++){setProgress('pdfProgress',i/groups.length*90,`正在生成第 ${i+1} 组`);const indexes=parsePageList(groups[i],src.getPageCount());const doc=await PDFDocument.create();const pages=await doc.copyPages(src,indexes);pages.forEach(p=>doc.addPage(p));outputs.push({name:`${stem(file.name)}-part-${String(i+1).padStart(2,'0')}.pdf`,blob:new Blob([await doc.save()],{type:'application/pdf'})});}await downloadOutputs(outputs,`${stem(file.name)}-split.zip`);
}
async function pdfReorder(file){
  const {PDFDocument,degrees}=await getPdfLib();const src=await PDFDocument.load(await file.arrayBuffer());const indexes=parsePageList($('#pdfOrder').value,src.getPageCount());const rotate=Number($('#pdfRotate').value);const out=await PDFDocument.create();const pages=await out.copyPages(src,indexes);pages.forEach(p=>{if(rotate)p.setRotation(degrees((p.getRotation().angle+rotate)%360));out.addPage(p);});downloadBlob(new Blob([await out.save()],{type:'application/pdf'}),`${stem(file.name)}-reordered.pdf`);
}
async function pdfDecorate(file){
  const {PDFDocument,rgb,degrees,StandardFonts}=await getPdfLib();const doc=await PDFDocument.load(await file.arrayBuffer());const watermark=$('#pdfWatermark').value.trim();const opacity=Math.max(.05,Math.min(1,Number($('#pdfOpacity').value)));const pageNumbers=$('#pdfPageNumbers').value==='yes';const font=await doc.embedFont(StandardFonts.Helvetica);
  let markImage=null;if(watermark){const c=document.createElement('canvas');c.width=1200;c.height=220;const x=c.getContext('2d');x.clearRect(0,0,c.width,c.height);x.font='700 92px "Microsoft YaHei", sans-serif';x.textAlign='center';x.textBaseline='middle';x.fillStyle='rgba(65,65,80,.9)';x.fillText(watermark,c.width/2,c.height/2);markImage=await doc.embedPng(await (await canvasBlob(c,'image/png')).arrayBuffer());}
  doc.getPages().forEach((page,i)=>{const {width,height}=page.getSize();if(markImage){const w=Math.min(width*.72,markImage.width*.4),h=w/markImage.width*markImage.height;page.drawImage(markImage,{x:(width-w)/2,y:(height-h)/2,width:w,height:h,opacity});}if(pageNumbers){const text=String(i+1);page.drawText(text,{x:width/2-font.widthOfTextAtSize(text,10)/2,y:18,size:10,font,color:rgb(.35,.35,.4),opacity:.8});}});downloadBlob(new Blob([await doc.save()],{type:'application/pdf'}),`${stem(file.name)}-decorated.pdf`);
}
async function pdfReplace(file){
  const {PDFDocument,rgb}=await getPdfLib();const doc=await PDFDocument.load(await file.arrayBuffer());const indexes=parsePageList($('#replacePages').value,doc.getPageCount());const xP=Number($('#replaceX').value)/100,yP=Number($('#replaceY').value)/100,wP=Number($('#replaceW').value)/100,hP=Number($('#replaceH').value)/100;const bg=hexRgb($('#replaceBg').value),color=$('#replaceColor').value,text=$('#replaceText').value;
  for(const index of indexes){const page=doc.getPage(index);const {width,height}=page.getSize();const x=width*xP,w=width*wP,h=height*hP,y=height-(height*yP)-h;page.drawRectangle({x,y,width:w,height:h,color:rgb(bg.r/255,bg.g/255,bg.b/255)});const c=document.createElement('canvas');const scale=3;c.width=Math.max(100,Math.ceil(w*scale));c.height=Math.max(30,Math.ceil(h*scale));const ctx=c.getContext('2d');ctx.clearRect(0,0,c.width,c.height);ctx.fillStyle=color;let size=Math.min(44*scale,c.height*.45);ctx.font=`600 ${size}px "Microsoft YaHei", sans-serif`;ctx.textBaseline='top';const lines=wrapCanvasText(ctx,text,c.width-24*scale);while(lines.length*size*1.25>c.height-16*scale&&size>18){size-=2;ctx.font=`600 ${size}px "Microsoft YaHei", sans-serif`;}let yy=8*scale;for(const line of wrapCanvasText(ctx,text,c.width-24*scale)){if(yy+size*1.2>c.height)break;ctx.fillText(line,12*scale,yy);yy+=size*1.22;}const img=await doc.embedPng(await (await canvasBlob(c,'image/png')).arrayBuffer());page.drawImage(img,{x,y,width:w,height:h});}
  downloadBlob(new Blob([await doc.save()],{type:'application/pdf'}),`${stem(file.name)}-replaced.pdf`);
}
async function previewPdfFirstPage(){
  const file=getQueue('pdf')[0];if(!file)return toast('请先添加 PDF。');const host=$('#pdfPreview');host.innerHTML='<span class="panel-subtitle">正在渲染……</span>';
  try{const pdfjs=await getPdfJs();const pdf=await pdfjs.getDocument({data:new Uint8Array(await file.arrayBuffer())}).promise;const page=await pdf.getPage(1);const viewport=page.getViewport({scale:1.25});const canvas=document.createElement('canvas');canvas.width=Math.ceil(viewport.width);canvas.height=Math.ceil(viewport.height);await page.render({canvasContext:canvas.getContext('2d'),viewport}).promise;host.innerHTML='';host.appendChild(canvas);}catch(e){host.innerHTML=`<span class="panel-subtitle">${escapeHtml(e.message)}</span>`;}
}

function recorderErrorMessage(error) {
  const name = error?.name || '';
  if (name === 'NotAllowedError' || name === 'PermissionDeniedError') return '录音权限被拒绝。请在地址栏左侧的网站权限中允许麦克风/屏幕共享后重试。';
  if (name === 'NotFoundError' || name === 'DevicesNotFoundError') return '没有找到可用的麦克风或可分享的音频设备。';
  if (name === 'NotReadableError' || name === 'TrackStartError') return '录音设备正被其他程序占用，或浏览器无法读取该设备。';
  if (name === 'AbortError') return '录音授权或共享选择已取消。';
  return error?.message || '未知错误';
}
function supportedRecorderMime(requested) {
  const candidates = requested && requested !== 'auto'
    ? [requested, 'audio/webm;codecs=opus', 'audio/ogg;codecs=opus', 'audio/webm']
    : ['audio/webm;codecs=opus', 'audio/ogg;codecs=opus', 'audio/webm'];
  return candidates.find(type => MediaRecorder.isTypeSupported(type)) || '';
}
function stopStream(stream) { stream?.getTracks().forEach(track => track.stop()); }
async function buildRecordingStream(mode) {
  let micStream = null;
  let displayStream = null;
  let audioContext = null;
  try {
    if (mode === 'microphone' || mode === 'mix') {
      micStream = await navigator.mediaDevices.getUserMedia({ audio: { echoCancellation: false, noiseSuppression: false, autoGainControl: false } });
    }
    if (mode === 'display' || mode === 'mix') {
      if (!navigator.mediaDevices.getDisplayMedia) throw new Error('当前浏览器不支持标签页或系统音频捕获。请使用最新版 Edge/Chrome。');
      displayStream = await navigator.mediaDevices.getDisplayMedia({ video: true, audio: true });
      if (!displayStream.getAudioTracks().length) throw new Error('没有捕获到分享音频。请重新选择浏览器标签页，并勾选“共享标签页音频”或“共享系统音频”。');
    }
    audioContext = new AudioContext();
    await audioContext.resume();
    const destination = audioContext.createMediaStreamDestination();
    const sourceNodes = [];
    for (const input of [micStream, displayStream]) {
      if (!input?.getAudioTracks().length) continue;
      const source = audioContext.createMediaStreamSource(new MediaStream(input.getAudioTracks()));
      source.connect(destination); sourceNodes.push(source);
    }
    const stream = destination.stream;
    if (!stream.getAudioTracks().length) throw new Error('没有获得可录制的音频轨道。');
    return { stream, micStream, displayStream, audioContext, sourceNodes };
  } catch (error) {
    stopStream(micStream); stopStream(displayStream);
    if (audioContext && audioContext.state !== 'closed') await audioContext.close().catch(() => {});
    throw error;
  }
}
async function startRecording(){
  if (!window.isSecureContext) return toast('网页录音必须通过 HTTPS 打开。','error');
  if (!navigator.mediaDevices?.getUserMedia || !window.MediaRecorder) return toast('当前浏览器不支持网页录音，请使用最新版 Edge/Chrome。','error');
  const startButton = $('#startRecord');
  startButton.disabled = true;
  $('#recordState').className = 'notice';
  $('#recordState').textContent = '正在请求录音权限……';
  try{
    const mode = $('#recordSource').value;
    const inputs = await buildRecordingStream(mode);
    const requested = $('#recordMime').value;
    const mime = supportedRecorderMime(requested);
    const bitrate = Number($('#recordBitrate').value);
    const options = { audioBitsPerSecond: bitrate };
    if (mime) options.mimeType = mime;
    const recorder = new MediaRecorder(inputs.stream, options);
    state.recorder = { ...state.recorder, ...inputs, mediaRecorder: recorder, chunks: [], startedAt: performance.now(), pausedAt: 0, pausedTotal: 0 };
    recorder.ondataavailable = event => { if (event.data.size) state.recorder.chunks.push(event.data); };
    recorder.onerror = event => toast(`录音发生错误：${recorderErrorMessage(event.error)}`,'error');
    recorder.onstop = finishRecording;
    inputs.displayStream?.getTracks().forEach(track => track.addEventListener('ended', () => {
      const active = state.recorder.mediaRecorder;
      if (active && active.state !== 'inactive') active.stop();
    }, { once: true }));
    recorder.start(1000);
    startRecorderVisuals();
    $('#pauseRecord').disabled = false; $('#stopRecord').disabled = false;
    $('#recordDot').classList.add('live'); $('#recordState').className = 'notice success';
    $('#recordState').textContent = mode === 'microphone' ? '正在录制麦克风。' : mode === 'display' ? '正在录制分享音频。' : '正在混合录制麦克风与分享音频。';
  }catch(error){
    cleanupRecorderResources();
    startButton.disabled = false;
    $('#recordState').className = 'notice warning';
    $('#recordState').textContent = recorderErrorMessage(error);
    toast(`无法开始录音：${recorderErrorMessage(error)}`,'error');
  }
}
function togglePauseRecording(){
  const recorder = state.recorder.mediaRecorder; if(!recorder) return;
  if(recorder.state==='recording'){
    recorder.pause(); state.recorder.pausedAt=performance.now(); $('#pauseRecord').textContent='继续'; $('#recordState').textContent='录音已暂停。';
  } else if(recorder.state==='paused'){
    recorder.resume(); state.recorder.pausedTotal+=performance.now()-state.recorder.pausedAt; state.recorder.pausedAt=0; $('#pauseRecord').textContent='暂停'; $('#recordState').textContent='正在录音。';
  }
}
function stopRecording(){const recorder=state.recorder.mediaRecorder;if(recorder&&recorder.state!=='inactive')recorder.stop();}
function recordingExtension(mime='') { if (mime.includes('ogg')) return 'ogg'; if (mime.includes('mp4')) return 'm4a'; return 'webm'; }
function finishRecording(){
  const recorder=state.recorder.mediaRecorder; const mime=recorder?.mimeType||state.recorder.chunks[0]?.type||'audio/webm';
  const blob=new Blob(state.recorder.chunks,{type:mime}); const suffix=recordingExtension(mime);
  if (blob.size) downloadBlob(blob,`RockwellTools-recording-${new Date().toISOString().replace(/[:.]/g,'-')}.${suffix}`);
  stopRecorderVisuals(); cleanupRecorderResources();
  $('#startRecord').disabled=false; $('#pauseRecord').disabled=true; $('#stopRecord').disabled=true; $('#pauseRecord').textContent='暂停'; $('#recordDot').classList.remove('live');
  $('#recordState').className=blob.size?'notice success':'notice warning';
  $('#recordState').textContent=blob.size?`录音完成：${formatBytes(blob.size)}，已开始下载。`:'录音结束，但没有产生有效音频数据。';
  toast(blob.size?'录音已经导出。':'没有录到有效音频。',blob.size?'success':'error');
}
function startRecorderVisuals(){
  const ctx=state.recorder.audioContext; const source=ctx.createMediaStreamSource(state.recorder.stream); const analyser=ctx.createAnalyser(); analyser.fftSize=256; source.connect(analyser);
  state.recorder.analyser={node:analyser,ctx,source}; const data=new Uint8Array(analyser.frequencyBinCount); const bars=$$('#recordLevel i');
  const draw=()=>{analyser.getByteFrequencyData(data);const avg=data.reduce((a,b)=>a+b,0)/data.length;bars.forEach((bar,i)=>{const value=data[Math.floor(i/data.length*bars.length)]||avg;bar.style.height=`${Math.max(5,Math.min(38,value/255*40))}px`;bar.classList.toggle('on',value>30);});state.recorder.animationId=requestAnimationFrame(draw);};draw();
  state.recorder.timerId=setInterval(()=>{let elapsed=performance.now()-state.recorder.startedAt-state.recorder.pausedTotal;if(state.recorder.pausedAt)elapsed-=performance.now()-state.recorder.pausedAt;const sec=Math.max(0,Math.floor(elapsed/1000));const timer=$('#recordTimer');if(timer)timer.textContent=[Math.floor(sec/3600),Math.floor(sec%3600/60),sec%60].map(x=>String(x).padStart(2,'0')).join(':');},250);
}
function stopRecorderVisuals(){clearInterval(state.recorder.timerId);cancelAnimationFrame(state.recorder.animationId);try{state.recorder.analyser?.source?.disconnect();}catch{}}
function cleanupRecorderResources(){
  stopStream(state.recorder.stream); stopStream(state.recorder.micStream); stopStream(state.recorder.displayStream);
  state.recorder.sourceNodes?.forEach(node=>{try{node.disconnect();}catch{}});
  const ctx=state.recorder.audioContext; if(ctx&&ctx.state!=='closed')ctx.close().catch(()=>{});
  state.recorder={ stream:null,micStream:null,displayStream:null,mediaRecorder:null,chunks:[],startedAt:0,pausedAt:0,pausedTotal:0,timerId:null,analyser:null,animationId:null,audioContext:null,sourceNodes:[] };
}

async function clearWebCaches(){if(!('caches'in window))return toast('当前浏览器没有 Cache API。');const keys=await caches.keys();await Promise.all(keys.map(k=>caches.delete(k)));toast(`已清除 ${keys.length} 个网页缓存。`,'success');}
function applyTheme(){
  const theme=localStorage.getItem('rockwell-theme')||'system';const actual=theme==='system'?(matchMedia('(prefers-color-scheme: dark)').matches?'dark':'light'):theme;document.body.dataset.theme=actual;const accent=localStorage.getItem('rockwell-accent')||'#6d5dfc';document.documentElement.style.setProperty('--accent',accent);document.documentElement.style.setProperty('--accent-soft',`${accent}18`);
}
async function installPwa(){if(state.installPrompt){state.installPrompt.prompt();await state.installPrompt.userChoice;state.installPrompt=null;$('#installButton').hidden=true;}else toast('浏览器未提供安装提示。可在 Edge/Chrome 地址栏的“安装应用”按钮中安装。');}
function updateNetwork(){const badge=$('#networkBadge');if(navigator.onLine){badge.textContent='本地处理 · 在线';badge.classList.remove('offline');}else{badge.textContent='离线模式';badge.classList.add('offline');}}

function init(){
  applyTheme();const fromHash=location.hash.slice(1);if(pageMeta[fromHash])state.page=fromHash;
  $('#nav').addEventListener('click',e=>{const btn=e.target.closest('[data-page]');if(btn)navigate(btn.dataset.page);});$('#menuButton').addEventListener('click',()=>$('#sidebar').classList.toggle('open'));
  $('#installButton').addEventListener('click',installPwa);window.addEventListener('beforeinstallprompt',e=>{e.preventDefault();state.installPrompt=e;$('#installButton').hidden=false;});window.addEventListener('online',updateNetwork);window.addEventListener('offline',updateNetwork);updateNetwork();renderPage();
  if('serviceWorker'in navigator&&location.protocol!=='file:'){
    let refreshing=false;
    navigator.serviceWorker.addEventListener('controllerchange',()=>{if(refreshing)return;refreshing=true;const key=`rockwell-sw-reload-${APP_VERSION}`;if(!sessionStorage.getItem(key)){sessionStorage.setItem(key,'1');location.reload();}});
    navigator.serviceWorker.register(`./sw.js?v=${APP_VERSION}`, { updateViaCache: 'none' }).then(reg=>reg.update()).catch(()=>{});
  }
}
init();
