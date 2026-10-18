/* ================================================================
   app.js — UI State Machine, Tab Switching, Queue Management,
   Workflow Execution, and Summary Table Rendering
   ================================================================ */

(() => {
  'use strict';

  // ─── STATE ─── ─────────────────────────────────────────────────
  const queues = {
    imageConvert: [],
    pdfToImage:   [],
    imageToPdf:   [],
    pdfCompress:  [],
    excelToPdf:   [],
  };

  const ACCEPTED = {
    imageConvert: new Set(['png','jpg','jpeg','webp','avif','bmp','gif','svg','tif','tiff','heic','heif']),
    pdfToImage:   new Set(['pdf']),
    imageToPdf:   new Set(['png','jpg','jpeg','webp','avif','bmp','gif','svg','tif','tiff','heic','heif']),
    pdfCompress:  new Set(['pdf']),
    excelToPdf:   new Set(['xlsx','xls','csv','ods']),
  };

  let processing = false;

  // ─── DOM HELPERS ─── ──────────────────────────────────────────
  const $ = (sel) => document.querySelector(sel);
  const $$ = (sel) => document.querySelectorAll(sel);

  // ─── TAB SWITCHING ─── ────────────────────────────────────────
  $$('.tab-btn').forEach((btn) => {
    btn.addEventListener('click', () => {
      if (processing) return;
      const tab = btn.dataset.tab;
      $$('.tab-btn').forEach(b => { b.classList.remove('active'); b.setAttribute('aria-selected', 'false'); });
      btn.classList.add('active');
      btn.setAttribute('aria-selected', 'true');
      $$('.tab-panel').forEach(p => p.classList.remove('active'));
      $(`#panel-${tab}`).classList.add('active');
    });
  });

  // ─── RADIO CARD SELECTION ─── ─────────────────────────────────
  document.addEventListener('change', (e) => {
    if (e.target.type !== 'radio') return;
    const group = e.target.closest('.radio-group');
    if (!group) return;
    group.querySelectorAll('.radio-card').forEach(c => c.classList.remove('active'));
    e.target.closest('.radio-card').classList.add('active');

    // Handle resize mode sub-control visibility
    const name = e.target.name;
    if (name.startsWith('resizeMode-')) {
      const tab = name.replace('resizeMode-', '');
      updateResizeControls(tab, e.target.value);
    }
  });

  function updateResizeControls(tab, mode) {
    ['percentage', 'dimensions', 'filesize'].forEach(m => {
      const el = $(`#ctrl-${m}-${tab}`);
      if (el) el.style.display = (m === mode) ? 'block' : 'none';
    });
  }

  // ─── PERCENTAGE SLIDERS ─── ───────────────────────────────────
  ['imageConvert', 'pdfToImage', 'imageToPdf', 'pdfCompress', 'excelToPdf'].forEach(tab => {
    const slider = $(`#pctSlider-${tab}`);
    const label = $(`#pctValue-${tab}`);
    if (slider && label) {
      slider.addEventListener('input', () => { label.textContent = slider.value; });
    }
  });

  // ─── DRAG & DROP + FILE INPUT ─── ─────────────────────────────
  ['imageConvert', 'pdfToImage', 'imageToPdf', 'pdfCompress'].forEach(tab => {
    const dropZone = $(`#dropZone-${tab}`);
    const fileInput = $(`#fileInput-${tab}`);

    // Drag events
    dropZone.addEventListener('dragover', (e) => { e.preventDefault(); dropZone.classList.add('drag-over'); });
    dropZone.addEventListener('dragleave', () => { dropZone.classList.remove('drag-over'); });
    dropZone.addEventListener('drop', (e) => {
      e.preventDefault();
      dropZone.classList.remove('drag-over');
      addFiles(tab, Array.from(e.dataTransfer.files));
    });

    // Click to trigger file input
    dropZone.addEventListener('click', (e) => {
      if (e.target.closest('.file-browse') || e.target === fileInput) return;
      fileInput.click();
    });

    fileInput.addEventListener('change', () => {
      addFiles(tab, Array.from(fileInput.files));
      fileInput.value = '';
    });

    // Clear queue
    $(`#clearQueue-${tab}`).addEventListener('click', () => {
      queues[tab] = [];
      renderQueue(tab);
    });
  });

  function addFiles(tab, files) {
    const accepted = ACCEPTED[tab];
    const valid = files.filter(f => {
      const ext = f.name.split('.').pop().toLowerCase();
      return accepted.has(ext);
    });
    if (valid.length === 0) return;
    queues[tab].push(...valid);
    renderQueue(tab);
  }

  function renderQueue(tab) {
    const list = $(`#queueList-${tab}`);
    const section = $(`#queueSection-${tab}`);
    const count = $(`#queueCount-${tab}`);
    const settings = $(`#settings-${tab}`);
    const actionBar = $(`#actionBar-${tab}`);
    const q = queues[tab];

    if (q.length === 0) {
      section.style.display = 'none';
      if (settings) settings.style.display = 'none';
      if (actionBar) actionBar.style.display = 'none';
      return;
    }

    section.style.display = 'block';
    if (settings) settings.style.display = 'grid';
    if (actionBar) actionBar.style.display = 'flex';
    count.textContent = q.length;

    list.innerHTML = q.map((f, i) => `
      <div class="queue-item">
        <span class="queue-item-name" title="${escHtml(f.name)}">${escHtml(f.name)}</span>
        <span class="queue-item-size">${FileEngine.formatBytes(f.size)}</span>
        <button class="queue-item-remove" data-tab="${tab}" data-index="${i}" title="Remove">✕</button>
      </div>
    `).join('');
  }

  // Remove individual file
  document.addEventListener('click', (e) => {
    const btn = e.target.closest('.queue-item-remove');
    if (!btn) return;
    const tab = btn.dataset.tab;
    const idx = parseInt(btn.dataset.index, 10);
    queues[tab].splice(idx, 1);
    renderQueue(tab);
  });

  function escHtml(str) {
    return str.replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;');
  }

  // ─── SETTINGS GATHERER ─── ────────────────────────────────────
  function gatherSettings(tab) {
    const resizeMode = document.querySelector(`input[name="resizeMode-${tab}"]:checked`)?.value || 'original';
    const profile = document.querySelector(`input[name="compProfile-${tab}"]:checked`)?.value || 'balanced';

    const s = { resizeMode, profile };

    // Output format (not for imageToPdf or pdfCompress)
    if (tab !== 'imageToPdf' && tab !== 'pdfCompress') {
      s.outputFormat = document.querySelector(`input[name="outputFormat-${tab}"]:checked`)?.value || 'webp';
    }

    // PDF layout (imageToPdf only)
    if (tab === 'imageToPdf') {
      s.pdfLayout = document.querySelector(`input[name="pdfLayout-${tab}"]:checked`)?.value || 'fitImage';
    }

    // Resize sub-settings
    if (resizeMode === 'percentage') {
      s.percentage = parseInt($(`#pctSlider-${tab}`)?.value || '100', 10);
    }
    if (resizeMode === 'dimensions') {
      s.dimW = parseInt($(`#dimW-${tab}`)?.value, 10) || 0;
      s.dimH = parseInt($(`#dimH-${tab}`)?.value, 10) || 0;
      s.aspectLock = $(`#aspectLock-${tab}`)?.checked !== false;
    }
    if (resizeMode === 'filesize') {
      s.targetSize = $(`#targetSize-${tab}`)?.value || '500';
      s.targetUnit = $(`#targetUnit-${tab}`)?.value || 'KB';
    }

    // Excel-specific settings
    if (tab === 'excelToPdf') {
      s.excelPageSize = document.querySelector(`input[name="pageSize-${tab}"]:checked`)?.value || 'a4';
      s.excelOrientation = document.querySelector(`input[name="orientation-${tab}"]:checked`)?.value || 'auto';
      s.excelTableStyle = document.querySelector(`input[name="tableStyle-${tab}"]:checked`)?.value || 'striped';
      s.excelFontSize = document.querySelector(`input[name="fontSize-${tab}"]:checked`)?.value || '10';
    }

    return s;
  }

  // ─── PROGRESS UI ─── ──────────────────────────────────────────
  function showProgress(title) {
    processing = true;
    $('#progressOverlay').style.display = 'flex';
    $('#progressTitle').textContent = title || 'Processing…';
    $('#progressStatus').textContent = 'Initializing…';
    $('#progressBarFill').style.width = '0%';
    $('#progressPct').textContent = '0%';
  }

  function updateProgress(status, fraction) {
    const pct = Math.round(fraction * 100);
    $('#progressStatus').textContent = status;
    $('#progressBarFill').style.width = pct + '%';
    $('#progressPct').textContent = pct + '%';
  }

  function hideProgress() {
    processing = false;
    $('#progressOverlay').style.display = 'none';
  }

  // ─── DOWNLOAD HELPER ─── ──────────────────────────────────────
  function downloadBlob(blob, filename) {
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = filename;
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    setTimeout(() => URL.revokeObjectURL(url), 5000);
  }

  // ─── SUMMARY TABLE ─── ────────────────────────────────────────
  function showSummary(rows) {
    const section = $('#summarySection');
    const body = $('#summaryBody');

    body.innerHTML = rows.map(r => {
      const saved = r.originalSize > 0 ? ((1 - r.newSize / r.originalSize) * 100) : 0;
      const savedClass = saved >= 0 ? 'saved-positive' : 'saved-negative';
      return `<tr>
        <td>${escHtml(r.filename)}</td>
        <td>${FileEngine.formatBytes(r.originalSize)}</td>
        <td>${FileEngine.formatBytes(r.newSize)}</td>
        <td>${r.width}×${r.height}</td>
        <td class="${savedClass}">${saved >= 0 ? '' : '+'}${saved.toFixed(1)}%</td>
      </tr>`;
    }).join('');

    section.style.display = 'block';
    section.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
  }

  // ─── WORKFLOW: IMAGE CONVERT ─── ──────────────────────────────
  $(`#processBtn-imageConvert`).addEventListener('click', async () => {
    const files = queues.imageConvert;
    if (files.length === 0 || processing) return;

    const settings = gatherSettings('imageConvert');
    showProgress('Converting Images…');

    try {
      const results = [];
      for (let i = 0; i < files.length; i++) {
        updateProgress(`Processing ${files[i].name}…`, i / files.length);
        const result = await FileEngine.processImage(files[i], settings, (s) => updateProgress(s, i / files.length));
        results.push(result);
      }

      updateProgress('Packaging download…', 0.95);

      if (results.length === 1) {
        downloadBlob(results[0].blob, results[0].filename);
      } else {
        const zipBlob = await FileEngine.buildZip(results);
        downloadBlob(zipBlob, 'converted_images.zip');
      }

      showSummary(results);
    } catch (err) {
      console.error(err);
      alert('Error during processing: ' + err.message);
    } finally {
      hideProgress();
    }
  });

  // ─── WORKFLOW: PDF TO IMAGE ─── ───────────────────────────────
  $(`#processBtn-pdfToImage`).addEventListener('click', async () => {
    const files = queues.pdfToImage;
    if (files.length === 0 || processing) return;

    const settings = gatherSettings('pdfToImage');
    showProgress('Converting PDF to Images…');

    try {
      const allResults = [];

      for (let fi = 0; fi < files.length; fi++) {
        const fileResults = await FileEngine.pdfToImages(files[fi], settings, (status, frac) => {
          const overallFrac = (fi + frac) / files.length;
          updateProgress(status, overallFrac);
        });
        allResults.push(...fileResults);
      }

      updateProgress('Building ZIP archive…', 0.95);
      const zipBlob = await FileEngine.buildZip(allResults);
      downloadBlob(zipBlob, 'pdf_pages.zip');

      showSummary(allResults.map(r => ({
        filename: r.filename,
        originalSize: r.originalSize,
        newSize: r.newSize,
        width: r.width,
        height: r.height,
      })));
    } catch (err) {
      console.error(err);
      alert('Error during processing: ' + err.message);
    } finally {
      hideProgress();
    }
  });

  // ─── WORKFLOW: IMAGE TO PDF ─── ───────────────────────────────
  $(`#processBtn-imageToPdf`).addEventListener('click', async () => {
    const files = queues.imageToPdf;
    if (files.length === 0 || processing) return;

    const settings = gatherSettings('imageToPdf');
    showProgress('Building PDF from Images…');

    try {
      const result = await FileEngine.imagesToPdf(files, settings, (status, frac) => {
        updateProgress(status, frac);
      });

      updateProgress('Downloading…', 1);
      downloadBlob(result.blob, result.filename);

      showSummary([{
        filename: result.filename,
        originalSize: result.originalSize,
        newSize: result.newSize,
        width: result.pages[0]?.width || 0,
        height: result.pages[0]?.height || 0,
      }]);
    } catch (err) {
      console.error(err);
      alert('Error during processing: ' + err.message);
    } finally {
      hideProgress();
    }
  });

  // ─── WORKFLOW: PDF COMPRESS ─── ───────────────────────────────
  $(`#processBtn-pdfCompress`).addEventListener('click', async () => {
    const files = queues.pdfCompress;
    if (files.length === 0 || processing) return;

    const settings = gatherSettings('pdfCompress');
    showProgress('Compressing PDF…');

    try {
      const results = [];

      for (let i = 0; i < files.length; i++) {
        const result = await FileEngine.compressPdf(files[i], settings, (status, frac) => {
          const overall = (i + frac) / files.length;
          updateProgress(status, overall);
        });
        results.push(result);
      }

      updateProgress('Packaging download…', 0.95);

      if (results.length === 1) {
        downloadBlob(results[0].blob, results[0].filename);
      } else {
        const zipBlob = await FileEngine.buildZip(results);
        downloadBlob(zipBlob, 'compressed_pdfs.zip');
      }

      showSummary(results.map(r => ({
        filename: r.filename,
        originalSize: r.originalSize,
        newSize: r.newSize,
        width: r.width,
        height: r.height,
      })));
    } catch (err) {
      console.error(err);
      alert('Error during processing: ' + err.message);
    } finally {
      hideProgress();
    }
  });

  // ─── WORKFLOW: EXCEL TO PDF ─── ────────────────────────────────
  $(`#processBtn-excelToPdf`).addEventListener('click', async () => {
    const files = queues.excelToPdf;
    if (files.length === 0 || processing) return;

    const settings = gatherSettings('excelToPdf');
    showProgress('Converting Excel to PDF…');

    try {
      const results = [];

      for (let i = 0; i < files.length; i++) {
        const result = await FileEngine.excelToPdf(files[i], settings, (status, frac) => {
          const overall = (i + frac) / files.length;
          updateProgress(status, overall);
        });
        results.push(result);
      }

      updateProgress('Packaging download…', 0.95);

      if (results.length === 1) {
        downloadBlob(results[0].blob, results[0].filename);
      } else {
        const zipBlob = await FileEngine.buildZip(results);
        downloadBlob(zipBlob, 'excel_pdfs.zip');
      }

      showSummary(results.map(r => ({
        filename: r.filename,
        originalSize: r.originalSize,
        newSize: r.newSize,
        width: 0,
        height: 0,
      })));
    } catch (err) {
      console.error(err);
      alert('Error during processing: ' + err.message);
    } finally {
      hideProgress();
    }
  });

})();
