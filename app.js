/* ===== Squish – private, in-browser image compressor ===== */
(function () {
  'use strict';

  const C = window.APP_CONFIG || {};
  const $ = (id) => document.getElementById(id);

  // ---- Constants ----
  const FREE_MAX_FILES = 10;
  const FREE_MAX_BYTES = 10 * 1024 * 1024;
  const PRO_MAX_BYTES = 50 * 1024 * 1024;
  const CONCURRENCY = 3;
  const LS_KEY = 'squish_settings_v1';
  const FREE_PATTERN = '{name}-min.{ext}';
  const JSZIP_URL = 'https://cdn.jsdelivr.net/npm/jszip@3.10.1/dist/jszip.min.js';
  const ENCODABLE = ['image/jpeg', 'image/png', 'image/webp'];
  const EXT = { 'image/jpeg': 'jpg', 'image/png': 'png', 'image/webp': 'webp' };
  const LABEL = { 'image/jpeg': 'JPEG', 'image/png': 'PNG', 'image/webp': 'WebP' };

  const DEFAULTS = {
    quality: 75,
    format: 'keep',
    maxDim: 1920,
    keepSmaller: true,
    targetMode: false,
    targetKB: 200,
    pattern: '{name}-compressed.{ext}'
  };

  // ---- Elements ----
  const el = {};
  [
    'dropZone', 'fileInput', 'browseBtn', 'sampleBtn', 'limitsHint',
    'quality', 'qualityVal', 'qualityHint', 'format', 'formatHint', 'maxDim', 'keepSmaller',
    'targetMode', 'targetKB', 'targetRow', 'filenamePattern', 'patternHint', 'resetSettingsBtn',
    'resultsCard', 'countPill', 'recompressBtn', 'clearBtn',
    'sumOriginal', 'sumCompressed', 'sumSaved', 'progress', 'progressBar',
    'results', 'downloadAllBtn', 'downloadZipBtn', 'downloadHint',
    'compareModal', 'compareClose', 'compareTitle', 'compareMeta', 'compareStage',
    'compareOriginal', 'compareCompressed', 'compareHandle', 'compareSlider', 'proPrice'
  ].forEach((id) => { el[id] = $(id); });

  // ---- State ----
  let settings = loadSettings();
  let items = [];           // { id, file, name, origSize, origUrl, origW, origH, outBlob, outUrl, outSize, outW, outH, outType, usedQuality, status, note, error, el }
  let queue = [];
  let active = 0;
  let nextId = 1;
  let rerunTimer = null;
  let zipPromise = null;
  let batchStart = 0;

  // ---- Settings persistence ----
  function loadSettings() {
    try {
      const raw = localStorage.getItem(LS_KEY);
      if (!raw) return Object.assign({}, DEFAULTS);
      // Reviver drops prototype-polluting keys; only plain objects are merged.
      const saved = JSON.parse(raw, (k, v) => (k === '__proto__' || k === 'constructor' || k === 'prototype') ? undefined : v);
      const s = Object.assign({}, DEFAULTS, saved && typeof saved === 'object' && !Array.isArray(saved) ? saved : {});
      s.quality = clamp(parseInt(s.quality, 10) || DEFAULTS.quality, 10, 100);
      s.maxDim = clamp(parseInt(s.maxDim, 10) || 0, 0, 20000);
      s.pattern = typeof s.pattern === 'string' ? s.pattern.slice(0, 120) : DEFAULTS.pattern;
      s.targetKB = clamp(parseInt(s.targetKB, 10) || DEFAULTS.targetKB, 5, 50000);
      if (!['keep', 'image/jpeg', 'image/png', 'image/webp'].includes(s.format)) s.format = 'keep';
      return s;
    } catch (e) { return Object.assign({}, DEFAULTS); }
  }
  function saveSettings() {
    try { localStorage.setItem(LS_KEY, JSON.stringify(settings)); } catch (e) { /* storage unavailable */ }
  }
  function applySettingsToUI() {
    el.quality.value = settings.quality;
    el.qualityVal.textContent = settings.quality;
    el.format.value = settings.format;
    el.maxDim.value = String(settings.maxDim);
    if (el.maxDim.value !== String(settings.maxDim)) { settings.maxDim = 1920; el.maxDim.value = '1920'; }
    el.keepSmaller.checked = !!settings.keepSmaller;
    el.targetMode.checked = !!settings.targetMode && isPro();
    el.targetKB.value = settings.targetKB;
    el.filenamePattern.value = settings.pattern || DEFAULTS.pattern;
    updateHints();
  }
  function updateHints() {
    const pngOut = settings.format === 'image/png';
    el.qualityHint.textContent = pngOut
      ? 'PNG is lossless – the quality slider has no effect on PNG output.'
      : '75–85 is the sweet spot for photos. Ignored for PNG output (lossless).';
    const fh = {
      keep: 'Each image keeps its format. GIF/SVG/AVIF are re-encoded as PNG.',
      'image/jpeg': 'Best compatibility. Transparency becomes white.',
      'image/png': 'Lossless, keeps transparency. Great for screenshots and logos, large for photos.',
      'image/webp': 'WebP is ~30% smaller than JPEG at the same quality and keeps transparency.'
    };
    el.formatHint.textContent = fh[settings.format] || fh.keep;
    el.targetRow.classList.toggle('hidden', !(settings.targetMode && isPro()));
  }

  // ---- Helpers ----
  function clamp(n, a, b) { return Math.min(b, Math.max(a, n)); }
  function fmtBytes(b) {
    if (!isFinite(b)) return '–';
    if (b < 1024) return b + ' B';
    if (b < 1024 * 1024) return (b / 1024).toFixed(b < 10 * 1024 ? 1 : 0) + ' KB';
    return (b / (1024 * 1024)).toFixed(2) + ' MB';
  }
  function pct(orig, out) {
    if (!orig) return 0;
    return Math.round(((orig - out) / orig) * 100);
  }
  function esc(s) {
    return String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  }
  function baseName(name) { return (name || 'image').replace(/\.[^.]+$/, '') || 'image'; }
  // Extension is restricted to [a-z0-9] so it is safe in filenames and in the RegExp built in outputName().
  function extOf(name) { const m = /\.([a-z0-9]{1,8})$/i.exec(name || ''); return m ? m[1].toLowerCase() : ''; }
  function fitDims(w, h, maxDim) {
    if (!maxDim || (w <= maxDim && h <= maxDim)) return { w, h };
    const r = Math.min(maxDim / w, maxDim / h);
    return { w: Math.max(1, Math.round(w * r)), h: Math.max(1, Math.round(h * r)) };
  }
  function toBlob(canvas, type, q) {
    return new Promise((resolve, reject) => {
      try {
        canvas.toBlob((b) => (b ? resolve(b) : reject(new Error('Encoding failed. The image may be too large for your browser.'))), type, q);
      } catch (e) { reject(e); }
    });
  }
  function isImageFile(f) {
    if (!f) return false;
    if (f.type && f.type.startsWith('image/')) return true;
    return /\.(jpe?g|png|webp|gif|bmp|avif|svg|heic|heif|tiff?)$/i.test(f.name || '');
  }

  // ---- Decoding ----
  async function decodeImage(file) {
    const name = file.name || '';
    if (/^image\/hei[cf]/i.test(file.type) || /\.hei[cf]$/i.test(name)) {
      throw new Error('HEIC/HEIF photos cannot be opened by browsers. Export as JPEG first (iPhone: Settings → Camera → Formats → Most Compatible).');
    }
    if (file.type && !file.type.startsWith('image/')) throw new Error('This is not an image file.');
    if (typeof createImageBitmap === 'function') {
      try {
        return await createImageBitmap(file, { imageOrientation: 'from-image' });
      } catch (e) { /* fall through to <img> decoding (e.g. SVG) */ }
    }
    return await new Promise((resolve, reject) => {
      const url = URL.createObjectURL(file);
      const img = new Image();
      img.onload = () => { URL.revokeObjectURL(url); resolve(img); };
      img.onerror = () => { URL.revokeObjectURL(url); reject(new Error('Could not decode this image. It may be corrupted or in an unsupported format.')); };
      img.src = url;
    });
  }

  // ---- Target size: binary search on quality ----
  async function fitToTarget(canvas, type, targetBytes, startQ) {
    let lo = 10;
    let hi = Math.max(10, startQ);
    const first = await toBlob(canvas, type, hi / 100);
    if (first.size <= targetBytes) return { blob: first, q: hi, hit: true };
    let best = null;
    let bestQ = lo;
    for (let i = 0; i < 7 && hi - lo > 1; i++) {
      const mid = Math.round((lo + hi) / 2);
      const b = await toBlob(canvas, type, mid / 100);
      if (b.size <= targetBytes) { best = b; bestQ = mid; lo = mid; } else { hi = mid; }
    }
    if (!best) {
      const floor = await toBlob(canvas, type, 0.10);
      return { blob: floor, q: 10, hit: floor.size <= targetBytes };
    }
    return { blob: best, q: bestQ, hit: true };
  }

  // ---- Processing ----
  async function processItem(it) {
    it.status = 'processing';
    it.error = '';
    it.note = '';
    renderItem(it);
    const s = settings;
    let src = null;
    try {
      src = await decodeImage(it.file);
      it.origW = src.width || src.naturalWidth;
      it.origH = src.height || src.naturalHeight;
      if (!it.origW || !it.origH) throw new Error('Image has no dimensions (empty or unsupported SVG).');

      const dims = fitDims(it.origW, it.origH, s.maxDim);
      let outType = s.format === 'keep' ? (ENCODABLE.includes(it.file.type) ? it.file.type : 'image/png') : s.format;
      let note = '';
      if (s.format === 'keep' && !ENCODABLE.includes(it.file.type)) {
        note = (extOf(it.name) || it.file.type || 'This format').toUpperCase() + ' re-encoded as PNG' + (/gif/i.test(it.file.type) ? ' (animation not preserved)' : '');
      }

      const canvas = document.createElement('canvas');
      canvas.width = dims.w;
      canvas.height = dims.h;
      const ctx = canvas.getContext('2d');
      if (outType === 'image/jpeg') { ctx.fillStyle = '#ffffff'; ctx.fillRect(0, 0, dims.w, dims.h); }
      ctx.imageSmoothingEnabled = true;
      ctx.imageSmoothingQuality = 'high';
      ctx.drawImage(src, 0, 0, dims.w, dims.h);
      if (src.close) src.close();
      src = null;

      const lossy = outType !== 'image/png';
      let q = s.quality;
      let blob;
      if (s.targetMode && isPro()) {
        if (!lossy) {
          blob = await toBlob(canvas, outType);
          note = 'Target size needs JPEG or WebP output (PNG is lossless)';
        } else {
          const r = await fitToTarget(canvas, outType, s.targetKB * 1024, s.quality);
          blob = r.blob; q = r.q;
          note = r.hit ? 'Target ' + s.targetKB + ' KB reached at quality ' + q : 'Still above ' + s.targetKB + ' KB at minimum quality – try resizing';
        }
      } else {
        blob = await toBlob(canvas, outType, lossy ? q / 100 : undefined);
      }
      if (blob.type && blob.type !== outType) {
        // Browser does not support this encoder (e.g. WebP on old Safari) and fell back.
        note = (LABEL[outType] || outType) + ' not supported by this browser – saved as ' + (LABEL[blob.type] || blob.type);
        outType = blob.type;
      }
      // Free the canvas memory early.
      canvas.width = canvas.height = 1;

      it.usedQuality = lossy ? q : null;
      const sameFamily = s.format === 'keep' || outType === it.file.type;
      if (s.keepSmaller && sameFamily && blob.size >= it.origSize) {
        it.outBlob = it.file;
        it.outType = it.file.type || outType;
        it.outW = it.origW; it.outH = it.origH;
        it.status = 'kept';
        it.note = 'Already optimized – original kept (result would be ' + fmtBytes(blob.size) + ')';
      } else {
        it.outBlob = blob;
        it.outType = outType;
        it.outW = dims.w; it.outH = dims.h;
        it.status = 'done';
        it.note = note;
      }
      it.outSize = it.outBlob.size;
      if (it.outUrl) URL.revokeObjectURL(it.outUrl);
      it.outUrl = URL.createObjectURL(it.outBlob);
    } catch (e) {
      if (src && src.close) { try { src.close(); } catch (_) { /* noop */ } }
      it.status = 'error';
      it.error = (e && e.message) || 'Could not process this image.';
    }
    renderItem(it);
  }

  function pump() {
    while (active < CONCURRENCY && queue.length) {
      const it = queue.shift();
      if (it.removed) continue;
      active++;
      processItem(it).finally(() => {
        active--;
        if (it.rerun && !it.removed) {
          // Settings changed while this image was being processed: run it again with the new settings.
          it.rerun = false;
          if (it.outUrl) { URL.revokeObjectURL(it.outUrl); it.outUrl = null; }
          it.outBlob = null; it.outSize = 0; it.status = 'queued';
          queue.push(it);
          renderItem(it);
        }
        updateSummary();
        if (!queue.length && active === 0) onBatchDone();
        pump();
      });
    }
    updateSummary();
  }

  function onBatchDone() {
    const done = items.filter((i) => i.status === 'done' || i.status === 'kept');
    if (!done.length) return;
    const orig = done.reduce((a, i) => a + i.origSize, 0);
    const out = done.reduce((a, i) => a + i.outSize, 0);
    const saved = pct(orig, out);
    track('generate', { count: done.length, saved_pct: saved, ms: Date.now() - batchStart });
    toast(saved > 0 ? 'Done – saved ' + saved + '% (' + fmtBytes(orig - out) + ')' : 'Done – images were already optimized');
  }

  // ---- Adding files ----
  function addItem(file) {
    const it = {
      id: nextId++,
      file,
      name: file.name || 'image',
      origSize: file.size,
      origUrl: URL.createObjectURL(file),
      status: 'queued',
      el: null
    };
    items.push(it);
    queue.push(it);
    renderItem(it);
    return it;
  }

  function addFiles(list) {
    let files = Array.from(list || []).filter(isImageFile);
    if (!files.length) { toast('No image files found'); return; }
    const pro = isPro();
    const maxBytes = pro ? PRO_MAX_BYTES : FREE_MAX_BYTES;
    let limited = false;
    if (!pro) {
      const room = FREE_MAX_FILES - items.length;
      if (files.length > room) { files = files.slice(0, Math.max(0, room)); limited = true; }
    }
    const tooBig = files.filter((f) => f.size > maxBytes);
    files = files.filter((f) => f.size <= maxBytes);

    if (files.length) {
      if (!queue.length && active === 0) batchStart = Date.now();
      files.forEach(addItem);
      el.resultsCard.classList.remove('hidden');
      updateSummary();
      pump();
      track('add_files', { count: files.length });
    }
    if (limited) {
      toast('Free plan: up to ' + FREE_MAX_FILES + ' images per batch. Pro removes the limit.');
      openPro('limit');
    } else if (tooBig.length) {
      if (pro) toast(tooBig.length + ' file(s) over 50 MB were skipped');
      else { toast(tooBig.length + ' file(s) over 10 MB skipped – Pro allows 50 MB per file'); openPro('limit'); }
    }
  }

  async function filesFromDataTransfer(dt) {
    const dtItems = dt.items ? Array.from(dt.items) : [];
    const entries = dtItems.map((i) => (i.kind === 'file' && typeof i.webkitGetAsEntry === 'function' ? i.webkitGetAsEntry() : null));
    if (!entries.some((e) => e && e.isDirectory)) return Array.from(dt.files || []);
    const out = [];
    async function walk(entry) {
      if (!entry) return;
      if (entry.isFile) {
        const f = await new Promise((res, rej) => entry.file(res, rej)).catch(() => null);
        if (f) out.push(f);
      } else if (entry.isDirectory) {
        const reader = entry.createReader();
        let batch;
        do {
          batch = await new Promise((res, rej) => reader.readEntries(res, rej)).catch(() => []);
          for (const e of batch) await walk(e);
        } while (batch.length);
      }
    }
    for (const e of entries) await walk(e);
    return out;
  }

  // ---- Rendering ----
  function renderItem(it) {
    if (it.removed) return;
    if (!it.el) {
      const li = document.createElement('li');
      li.className = 'result';
      li.dataset.id = it.id;
      el.results.appendChild(li);
      it.el = li;
    }
    const li = it.el;
    li.className = 'result status-' + it.status;
    const thumbSrc = it.outUrl || it.origUrl;
    let body = '';
    if (it.status === 'queued' || it.status === 'processing') {
      body = '<div class="r-sizes"><span class="muted">' + fmtBytes(it.origSize) + '</span> → <span class="spinner" aria-hidden="true"></span> <span class="muted">' + (it.status === 'queued' ? 'Waiting…' : 'Compressing…') + '</span></div>';
    } else if (it.status === 'error') {
      body = '<div class="r-sizes"><span class="muted">' + fmtBytes(it.origSize) + '</span></div><div class="r-error">' + esc(it.error) + '</div>';
    } else {
      const saved = pct(it.origSize, it.outSize);
      const savedCls = saved > 0 ? 'saved' : 'saved zero';
      const savedTxt = saved > 0 ? '−' + saved + '%' : (it.status === 'kept' ? 'kept' : '±0%');
      const dims = (it.origW === it.outW && it.origH === it.outH)
        ? it.outW + '×' + it.outH
        : it.origW + '×' + it.origH + ' → ' + it.outW + '×' + it.outH;
      const fmt = LABEL[it.outType] || (extOf(it.name) || '').toUpperCase();
      const q = it.status === 'done' && it.usedQuality ? ' q' + it.usedQuality : '';
      body = '<div class="r-sizes"><span class="muted">' + fmtBytes(it.origSize) + '</span> → <strong>' + fmtBytes(it.outSize) + '</strong> <span class="' + savedCls + '">' + savedTxt + '</span></div>' +
        '<div class="r-meta">' + dims + ' · ' + esc(fmt) + q + (it.note ? ' · <span class="note">' + esc(it.note) + '</span>' : '') + '</div>';
    }
    const canCompare = it.status === 'done' || it.status === 'kept';
    li.innerHTML =
      '<button type="button" class="thumb-btn" data-action="compare" ' + (canCompare ? '' : 'disabled ') + 'aria-label="Compare before and after for ' + esc(it.name) + '">' +
        '<img class="thumb" src="' + esc(/^(blob:|data:image\/)/i.test(String(thumbSrc || '')) ? thumbSrc : '') + '" alt="" loading="lazy" decoding="async">' +
      '</button>' +
      '<div class="r-main" data-action="compare">' +
        '<div class="r-name" title="' + esc(it.name) + '">' + esc(it.name) + '</div>' + body +
      '</div>' +
      '<div class="r-actions">' +
        '<button type="button" class="btn btn-sm" data-action="download" ' + (canCompare ? '' : 'disabled ') + 'aria-label="Download ' + esc(it.name) + '">⬇</button>' +
        '<button type="button" class="btn btn-sm icon-btn" data-action="remove" aria-label="Remove ' + esc(it.name) + '">✕</button>' +
      '</div>';
  }

  function updateSummary() {
    const total = items.length;
    el.countPill.textContent = total;
    el.resultsCard.classList.toggle('hidden', total === 0);
    const done = items.filter((i) => i.status === 'done' || i.status === 'kept');
    const orig = done.reduce((a, i) => a + i.origSize, 0);
    const out = done.reduce((a, i) => a + i.outSize, 0);
    el.sumOriginal.textContent = fmtBytes(orig);
    el.sumCompressed.textContent = fmtBytes(out);
    const saved = pct(orig, out);
    el.sumSaved.textContent = (saved > 0 ? '−' : '') + Math.abs(saved) + '%';
    el.sumSaved.classList.toggle('zero', saved <= 0);
    const pending = items.filter((i) => i.status === 'queued' || i.status === 'processing').length;
    el.progress.classList.toggle('hidden', pending === 0);
    if (pending) el.progressBar.style.width = Math.round(((total - pending) / total) * 100) + '%';
    const hasDone = done.length > 0;
    el.downloadAllBtn.disabled = !hasDone;
    el.downloadZipBtn.disabled = !hasDone;
    el.downloadHint.textContent = pending
      ? 'Compressing ' + pending + ' of ' + total + '…'
      : (hasDone ? 'Click a result to compare before/after.' : '');
  }

  function removeItem(it) {
    it.removed = true;
    if (it.origUrl) URL.revokeObjectURL(it.origUrl);
    if (it.outUrl) URL.revokeObjectURL(it.outUrl);
    if (it.el && it.el.parentNode) it.el.parentNode.removeChild(it.el);
    items = items.filter((i) => i !== it);
    queue = queue.filter((i) => i !== it);
    updateSummary();
  }

  function clearAll() {
    items.slice().forEach(removeItem);
    el.results.innerHTML = '';
    updateSummary();
  }

  function rerunAll() {
    if (!items.length) return;
    batchStart = Date.now();
    items.forEach((it) => {
      if (it.status === 'processing') { it.rerun = true; return; } // re-queued automatically once it finishes
      if (it.outUrl) { URL.revokeObjectURL(it.outUrl); it.outUrl = null; }
      it.outBlob = null; it.outSize = 0; it.status = 'queued';
      if (!queue.includes(it)) queue.push(it);
      renderItem(it);
    });
    pump();
  }
  function scheduleRerun() {
    if (!items.length) return;
    clearTimeout(rerunTimer);
    rerunTimer = setTimeout(rerunAll, 400);
  }

  // ---- Filenames & downloads ----
  function outputName(it, index) {
    const base = baseName(it.name);
    const ext = EXT[it.outType] || extOf(it.name) || 'img';
    let pattern = isPro() ? (settings.pattern || DEFAULTS.pattern) : FREE_PATTERN;
    if (!/\{name\}/.test(pattern) && !/\{index\}/.test(pattern)) pattern = '{name}-' + pattern;
    let n = pattern
      .replace(/\{name\}/g, () => base)
      .replace(/\{ext\}/g, () => ext)
      .replace(/\{index\}/g, String((index || 0) + 1).padStart(2, '0'))
      .replace(/\{w\}/g, it.outW || '')
      .replace(/\{h\}/g, it.outH || '')
      .replace(/[\\/:*?"<>|\u0000-\u001f\u007f]/g, '_')
      .trim()
      .slice(0, 200);
    if (!n) n = base + '.' + ext;
    if (!new RegExp('\\.' + ext + '$', 'i').test(n)) n += '.' + ext;
    return n;
  }

  function saveBlob(blob, name) {
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = name;
    a.rel = 'noopener';
    document.body.appendChild(a);
    a.click();
    a.remove();
    setTimeout(() => URL.revokeObjectURL(url), 10000);
  }

  function downloadItem(it) {
    if (!it.outBlob) return;
    saveBlob(it.outBlob, outputName(it, items.indexOf(it)));
    track('download', { format: it.outType, saved_pct: pct(it.origSize, it.outSize) });
  }

  async function downloadAll() {
    let done = items.filter((i) => i.outBlob);
    if (!done.length) return;
    if (!isPro() && done.length > FREE_MAX_FILES) done = done.slice(0, FREE_MAX_FILES);
    track('download_all', { count: done.length });
    if (done.length > 1) toast('Downloading ' + done.length + ' files – allow multiple downloads if your browser asks');
    el.downloadAllBtn.disabled = true;
    for (let i = 0; i < done.length; i++) {
      saveBlob(done[i].outBlob, outputName(done[i], items.indexOf(done[i])));
      if (i < done.length - 1) await new Promise((r) => setTimeout(r, 400));
    }
    el.downloadAllBtn.disabled = false;
  }

  function loadJSZip() {
    if (window.JSZip) return Promise.resolve(window.JSZip);
    if (!zipPromise) {
      zipPromise = new Promise((resolve, reject) => {
        const s = document.createElement('script');
        s.src = JSZIP_URL;
        s.async = true;
        s.onload = () => (window.JSZip ? resolve(window.JSZip) : reject(new Error('ZIP library failed to initialize')));
        s.onerror = () => { zipPromise = null; reject(new Error('Could not load the ZIP library. Check your connection.')); };
        document.head.appendChild(s);
      });
    }
    return zipPromise;
  }

  async function downloadZip() {
    if (!isPro()) { openPro('zip'); return; }
    const done = items.filter((i) => i.outBlob);
    if (!done.length) return;
    const btn = el.downloadZipBtn;
    const original = btn.innerHTML;
    btn.disabled = true;
    btn.textContent = 'Preparing ZIP…';
    try {
      const JSZip = await loadJSZip();
      const zip = new JSZip();
      const used = new Set();
      done.forEach((it, i) => {
        let name = outputName(it, i);
        if (used.has(name.toLowerCase())) {
          const e = extOf(name); const b = baseName(name); let k = 2;
          while (used.has((b + '-' + k + '.' + e).toLowerCase())) k++;
          name = b + '-' + k + '.' + e;
        }
        used.add(name.toLowerCase());
        zip.file(name, it.outBlob);
      });
      const blob = await zip.generateAsync({ type: 'blob', compression: 'STORE' });
      const stamp = new Date().toISOString().slice(0, 10);
      saveBlob(blob, 'squish-' + stamp + '.zip');
      track('download_zip', { count: done.length, bytes: blob.size });
      toast('ZIP ready – ' + done.length + ' files, ' + fmtBytes(blob.size));
    } catch (e) {
      toast(e.message || 'Could not create ZIP');
    } finally {
      btn.innerHTML = original;
      btn.disabled = false;
      refreshUI();
    }
  }

  // ---- Compare modal ----
  let compareItem = null;
  function openCompare(it) {
    if (!it || !it.outUrl) return;
    compareItem = it;
    el.compareTitle.textContent = it.name;
    const saved = pct(it.origSize, it.outSize);
    el.compareMeta.innerHTML =
      '<span>Original: <strong>' + fmtBytes(it.origSize) + '</strong> · ' + it.origW + '×' + it.origH + '</span>' +
      '<span>Compressed: <strong>' + fmtBytes(it.outSize) + '</strong> · ' + it.outW + '×' + it.outH + ' · <span class="' + (saved > 0 ? 'saved' : 'saved zero') + '">' + (saved > 0 ? '−' + saved + '%' : '±0%') + '</span></span>';
    el.compareStage.style.aspectRatio = it.origW + ' / ' + it.origH;
    el.compareOriginal.src = it.origUrl;
    el.compareCompressed.src = it.outUrl;
    el.compareSlider.value = 50;
    setCompare(50);
    el.compareModal.classList.add('open');
    el.compareSlider.focus();
    track('compare_open', {});
  }
  function setCompare(v) {
    el.compareCompressed.style.clipPath = 'inset(0 0 0 ' + v + '%)';
    el.compareHandle.style.left = v + '%';
  }
  function closeCompare() {
    el.compareModal.classList.remove('open');
    compareItem = null;
  }

  // ---- Sample image (generated locally, no network) ----
  async function makeSample() {
    const w = 2400, h = 1600;
    const c = document.createElement('canvas');
    c.width = w; c.height = h;
    const ctx = c.getContext('2d');
    const sky = ctx.createLinearGradient(0, 0, 0, h);
    sky.addColorStop(0, '#1e3a8a'); sky.addColorStop(0.55, '#f472b6'); sky.addColorStop(1, '#fbbf24');
    ctx.fillStyle = sky; ctx.fillRect(0, 0, w, h);
    // sun
    const sun = ctx.createRadialGradient(w * 0.7, h * 0.48, 10, w * 0.7, h * 0.48, 260);
    sun.addColorStop(0, '#fff7ed'); sun.addColorStop(0.4, '#fde68a'); sun.addColorStop(1, 'rgba(253,230,138,0)');
    ctx.fillStyle = sun; ctx.fillRect(0, 0, w, h);
    // mountains
    const layers = [['#312e81', 0.55, 180], ['#4c1d95', 0.66, 140], ['#1e1b4b', 0.78, 100]];
    layers.forEach(([color, base, amp], li) => {
      ctx.fillStyle = color; ctx.beginPath(); ctx.moveTo(0, h);
      for (let x = 0; x <= w; x += 20) {
        const y = h * base - Math.abs(Math.sin(x / (260 - li * 60) + li)) * amp - Math.sin(x / 37) * 18;
        ctx.lineTo(x, y);
      }
      ctx.lineTo(w, h); ctx.closePath(); ctx.fill();
    });
    // water reflection stripes
    for (let y = h * 0.8; y < h; y += 6) {
      ctx.fillStyle = 'rgba(255,255,255,' + (0.03 + Math.random() * 0.08) + ')';
      ctx.fillRect(0, y, w, 2);
    }
    // text
    ctx.fillStyle = 'rgba(255,255,255,.92)';
    ctx.font = '700 110px system-ui, sans-serif';
    ctx.fillText('Squish sample', 120, 220);
    ctx.font = '400 54px system-ui, sans-serif';
    ctx.fillText('2400 × 1600 · generated in your browser', 124, 300);
    // film grain so the original is realistically heavy
    const img = ctx.getImageData(0, 0, w, h);
    const d = img.data;
    for (let i = 0; i < d.length; i += 4) {
      const n = (Math.random() - 0.5) * 28;
      d[i] += n; d[i + 1] += n; d[i + 2] += n;
    }
    ctx.putImageData(img, 0, 0);
    const blob = await toBlob(c, 'image/jpeg', 0.98);
    return new File([blob], 'sample-sunset.jpg', { type: 'image/jpeg' });
  }

  // ---- Pro UI ----
  function refreshUI() {
    const pro = isPro();
    document.body.classList.toggle('is-pro', pro);
    document.querySelectorAll('.pro-only-badge').forEach((b) => b.classList.toggle('hidden', pro));
    el.limitsHint.textContent = pro
      ? 'Pro: unlimited images per batch, 50 MB each · JPG, PNG, WebP'
      : 'Free: up to ' + FREE_MAX_FILES + ' images per batch, 10 MB each · JPG, PNG, WebP';
    el.filenamePattern.readOnly = !pro;
    el.filenamePattern.classList.toggle('locked', !pro);
    el.patternHint.textContent = pro
      ? 'Use {name}, {ext}, {index}, {w}, {h}. Example: {name}-{w}px.{ext}'
      : 'Use {name}, {ext}, {index}, {w}, {h}. Free plan uses ' + FREE_PATTERN + ' – unlock custom patterns with Pro.';
    el.targetMode.checked = pro && !!settings.targetMode;
    updateHints();
  }

  // ---- Events ----
  function bind() {
    // Price
    const price = C.PRO_PRICE || '$9';
    if (el.proPrice) el.proPrice.textContent = price;
    document.querySelectorAll('[data-pro-price]').forEach((n) => { n.textContent = price; });

    // Drop zone
    const dz = el.dropZone;
    ['dragenter', 'dragover'].forEach((ev) => dz.addEventListener(ev, (e) => { e.preventDefault(); e.stopPropagation(); dz.classList.add('drag'); }));
    ['dragleave', 'dragend'].forEach((ev) => dz.addEventListener(ev, (e) => { e.preventDefault(); if (e.target === dz) dz.classList.remove('drag'); }));
    dz.addEventListener('drop', async (e) => {
      e.preventDefault(); e.stopPropagation(); dz.classList.remove('drag');
      const files = await filesFromDataTransfer(e.dataTransfer);
      addFiles(files);
    });
    // Prevent the browser from navigating away when files are dropped outside the zone
    ['dragover', 'drop'].forEach((ev) => document.addEventListener(ev, (e) => { if (e.dataTransfer && Array.from(e.dataTransfer.types || []).includes('Files')) e.preventDefault(); }));
    dz.addEventListener('click', (e) => { if (e.target.closest('button')) return; el.fileInput.click(); });
    dz.addEventListener('keydown', (e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); el.fileInput.click(); } });
    el.browseBtn.addEventListener('click', (e) => { e.stopPropagation(); el.fileInput.click(); });
    el.fileInput.addEventListener('change', () => { addFiles(el.fileInput.files); el.fileInput.value = ''; });

    // Paste
    document.addEventListener('paste', (e) => {
      const dt = e.clipboardData;
      if (!dt) return;
      let files = Array.from(dt.files || []);
      if (!files.length && dt.items) {
        files = Array.from(dt.items).filter((i) => i.kind === 'file' && i.type.startsWith('image/')).map((i) => i.getAsFile()).filter(Boolean);
      }
      files = files.filter(isImageFile);
      if (!files.length) return;
      e.preventDefault();
      const stamped = files.map((f, i) => {
        if (f.name && f.name !== 'image.png') return f;
        const ext = EXT[f.type] || 'png';
        try { return new File([f], 'pasted-' + Date.now() + (i ? '-' + i : '') + '.' + ext, { type: f.type }); } catch (_) { return f; }
      });
      addFiles(stamped);
      toast('Pasted ' + stamped.length + ' image' + (stamped.length > 1 ? 's' : ''));
    });

    // Sample
    el.sampleBtn.addEventListener('click', async () => {
      el.sampleBtn.disabled = true;
      try { addFiles([await makeSample()]); track('sample', {}); }
      catch (e) { toast('Could not generate sample'); }
      el.sampleBtn.disabled = false;
    });

    // Settings
    el.quality.addEventListener('input', () => { settings.quality = parseInt(el.quality.value, 10); el.qualityVal.textContent = settings.quality; saveSettings(); });
    el.quality.addEventListener('change', scheduleRerun);
    el.format.addEventListener('change', () => { settings.format = el.format.value; saveSettings(); updateHints(); scheduleRerun(); });
    el.maxDim.addEventListener('change', () => { settings.maxDim = parseInt(el.maxDim.value, 10) || 0; saveSettings(); scheduleRerun(); });
    el.keepSmaller.addEventListener('change', () => { settings.keepSmaller = el.keepSmaller.checked; saveSettings(); scheduleRerun(); });
    el.targetMode.addEventListener('change', () => {
      if (!isPro()) { el.targetMode.checked = false; openPro('target_size'); return; }
      settings.targetMode = el.targetMode.checked; saveSettings(); updateHints(); scheduleRerun();
    });
    el.targetKB.addEventListener('change', () => {
      settings.targetKB = clamp(parseInt(el.targetKB.value, 10) || DEFAULTS.targetKB, 5, 50000);
      el.targetKB.value = settings.targetKB; saveSettings(); scheduleRerun();
    });
    el.filenamePattern.addEventListener('click', () => { if (!isPro()) openPro('filenames'); });
    el.filenamePattern.addEventListener('keydown', (e) => { if (!isPro() && e.key !== 'Tab') { e.preventDefault(); openPro('filenames'); } });
    el.filenamePattern.addEventListener('input', () => { if (!isPro()) return; settings.pattern = el.filenamePattern.value.trim().slice(0, 120) || DEFAULTS.pattern; saveSettings(); });
    el.resetSettingsBtn.addEventListener('click', () => {
      settings = Object.assign({}, DEFAULTS); saveSettings(); applySettingsToUI(); refreshUI(); toast('Settings reset'); scheduleRerun();
    });

    // Results
    el.results.addEventListener('click', (e) => {
      const btn = e.target.closest('[data-action]');
      if (!btn) return;
      const li = e.target.closest('.result');
      const it = items.find((i) => String(i.id) === li.dataset.id);
      if (!it) return;
      const action = btn.dataset.action;
      if (action === 'download') downloadItem(it);
      else if (action === 'remove') removeItem(it);
      else if (action === 'compare') openCompare(it);
    });
    el.recompressBtn.addEventListener('click', () => { rerunAll(); toast('Re-compressing with current settings'); });
    el.clearBtn.addEventListener('click', clearAll);
    el.downloadAllBtn.addEventListener('click', downloadAll);
    el.downloadZipBtn.addEventListener('click', downloadZip);

    // Compare modal
    el.compareSlider.addEventListener('input', () => setCompare(el.compareSlider.value));
    el.compareClose.addEventListener('click', closeCompare);
    el.compareModal.addEventListener('click', (e) => { if (e.target === el.compareModal) closeCompare(); });
    document.addEventListener('keydown', (e) => { if (e.key === 'Escape' && compareItem) closeCompare(); });
    // Drag directly on the image stage
    let dragging = false;
    const stagePos = (ev) => {
      const r = el.compareStage.getBoundingClientRect();
      const x = (ev.touches ? ev.touches[0].clientX : ev.clientX) - r.left;
      return clamp((x / r.width) * 100, 0, 100);
    };
    el.compareStage.addEventListener('pointerdown', (ev) => { dragging = true; el.compareStage.setPointerCapture(ev.pointerId); const v = stagePos(ev); el.compareSlider.value = v; setCompare(v); });
    el.compareStage.addEventListener('pointermove', (ev) => { if (!dragging) return; const v = stagePos(ev); el.compareSlider.value = v; setCompare(v); });
    ['pointerup', 'pointercancel'].forEach((ev) => el.compareStage.addEventListener(ev, () => { dragging = false; }));

    // Pro state
    document.addEventListener('pro:changed', () => { refreshUI(); applySettingsToUI(); });
    window.addEventListener('beforeunload', () => { items.forEach((i) => { if (i.origUrl) URL.revokeObjectURL(i.origUrl); if (i.outUrl) URL.revokeObjectURL(i.outUrl); }); });
  }

  // ---- Init ----
  function init() {
    if (!document.createElement('canvas').getContext) {
      toast('Your browser does not support canvas image processing.');
      return;
    }
    bind();
    applySettingsToUI();
    refreshUI();
    updateSummary();
  }
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', init);
  else init();
})();
