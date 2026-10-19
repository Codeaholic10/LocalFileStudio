/* ================================================================
   engine.js — FileEngine: Decoders, Canvas Scalers,
   Binary-Search Byte-Cap Solver, PDF.js/pdf-lib Pipelines
   ================================================================ */

// PDF.js loaded as ES module — we'll lazy-init it
let pdfjsLib = null;

const FileEngine = (() => {
  'use strict';

  // ─── CONSTANTS ─── ────────────────────────────────────────────
  const COMPRESSION_PROFILES = {
    balanced: { quality: 0.82, resolutionFactor: 1.0 },
    smallest: { quality: 0.42, resolutionFactor: 0.85 },
    lossless: { quality: 1.0, resolutionFactor: 1.0 },
  };

  const MIME_MAP = {
    webp: 'image/webp',
    jpeg: 'image/jpeg',
    png:  'image/png',
    avif: 'image/avif',
    bmp:  'image/bmp',
  };

  const EXT_MAP = {
    webp: '.webp',
    jpeg: '.jpg',
    png:  '.png',
    avif: '.avif',
    bmp:  '.bmp',
  };

  // PDF page sizes in points (72 dpi)
  const PAGE_SIZES = {
    a4:     { width: 595.28, height: 841.89 },
    letter: { width: 612, height: 792 },
  };
  const PDF_MARGIN = 36; // 0.5 inch

  // ─── UTILITIES ─── ────────────────────────────────────────────
  function formatBytes(bytes) {
    if (bytes === 0) return '0 B';
    const units = ['B', 'KB', 'MB', 'GB'];
    const i = Math.floor(Math.log(bytes) / Math.log(1024));
    return (bytes / Math.pow(1024, i)).toFixed(i === 0 ? 0 : 2) + ' ' + units[i];
  }

  function baseName(filename) {
    return filename.replace(/\.[^/.]+$/, '');
  }

  function targetBytesFromInput(value, unit) {
    const num = parseFloat(value);
    if (isNaN(num) || num <= 0) return null;
    return unit === 'MB' ? num * 1024 * 1024 : num * 1024;
  }

  // ─── PDF.js LOADER ─── ────────────────────────────────────────
  async function ensurePdfJs() {
    if (pdfjsLib) return pdfjsLib;
    pdfjsLib = await import('./libs/pdf.min.mjs');
    pdfjsLib.GlobalWorkerOptions.workerSrc = './libs/pdf.worker.min.mjs';
    return pdfjsLib;
  }

  // ─── DECODERS ─── ─────────────────────────────────────────────
  // Returns an ImageBitmap or an HTMLImageElement with width/height
  async function decodeFile(file) {
    const ext = file.name.split('.').pop().toLowerCase();

    // HEIC/HEIF
    if (ext === 'heic' || ext === 'heif') {
      const blob = await heic2any({ blob: file, toType: 'image/png', quality: 1 });
      const resultBlob = Array.isArray(blob) ? blob[0] : blob;
      return loadImageFromBlob(resultBlob);
    }

    // TIFF/TIF
    if (ext === 'tif' || ext === 'tiff') {
      return decodeTiff(file);
    }

    // SVG — render via Image element to rasterize
    if (ext === 'svg') {
      return loadImageFromBlob(file);
    }

    // Standard browser-decodable formats
    return loadImageFromBlob(file);
  }

  async function decodeTiff(file) {
    const buf = await file.arrayBuffer();
    const ifds = UTIF.decode(buf);
    UTIF.decodeImage(buf, ifds[0]);
    const rgba = UTIF.toRGBA8(ifds[0]);
    const w = ifds[0].width;
    const h = ifds[0].height;
    const canvas = new OffscreenCanvas(w, h);
    const ctx = canvas.getContext('2d');
    const imgData = new ImageData(new Uint8ClampedArray(rgba.buffer), w, h);
    ctx.putImageData(imgData, 0, 0);
    return createImageBitmap(canvas);
  }

  function loadImageFromBlob(blob) {
    return new Promise((resolve, reject) => {
      const url = URL.createObjectURL(blob);
      const img = new Image();
      img.onload = () => {
        URL.revokeObjectURL(url);
        resolve(img);
      };
      img.onerror = () => {
        URL.revokeObjectURL(url);
        reject(new Error('Failed to decode image'));
      };
      img.src = url;
    });
  }

  // ─── CANVAS RESIZE / DRAW ─── ─────────────────────────────────
  function computeDimensions(srcW, srcH, settings) {
    const mode = settings.resizeMode;

    if (mode === 'percentage') {
      const scale = (settings.percentage || 100) / 100;
      return { width: Math.round(srcW * scale), height: Math.round(srcH * scale) };
    }

    if (mode === 'dimensions') {
      let tw = settings.dimW || 0;
      let th = settings.dimH || 0;
      const lock = settings.aspectLock !== false;

      if (tw > 0 && th > 0) {
        if (lock) {
          // Fit within bounding box
          const ratio = Math.min(tw / srcW, th / srcH);
          return { width: Math.round(srcW * ratio), height: Math.round(srcH * ratio) };
        }
        return { width: tw, height: th };
      }
      if (tw > 0) {
        const ratio = tw / srcW;
        return { width: tw, height: Math.round(srcH * ratio) };
      }
      if (th > 0) {
        const ratio = th / srcH;
        return { width: Math.round(srcW * ratio), height: th };
      }
      return { width: srcW, height: srcH };
    }

    // 'original' or 'filesize' — keep original dims (filesize adjusts later)
    return { width: srcW, height: srcH };
  }

  function applyProfileSubsampling(w, h, profile, resizeMode) {
    // Only apply resolution subsampling for "smallest" profile in original-size mode
    if (profile === 'smallest' && resizeMode === 'original') {
      const factor = COMPRESSION_PROFILES.smallest.resolutionFactor;
      return { width: Math.round(w * factor), height: Math.round(h * factor) };
    }
    return { width: w, height: h };
  }

  function drawToCanvas(img, width, height, format) {
    const canvas = document.createElement('canvas');
    canvas.width = width;
    canvas.height = height;
    const ctx = canvas.getContext('2d');

    // Alpha safety: composite onto white for JPEG/BMP
    const needsWhiteBg = (format === 'jpeg' || format === 'bmp');
    if (needsWhiteBg) {
      ctx.fillStyle = '#FFFFFF';
      ctx.fillRect(0, 0, width, height);
    }

    // High-quality bicubic smoothing
    ctx.imageSmoothingEnabled = true;
    ctx.imageSmoothingQuality = 'high';
    ctx.drawImage(img, 0, 0, width, height);
    return canvas;
  }

  // ─── FORMAT ENCODING ─── ──────────────────────────────────────
  async function canvasToBlob(canvas, format, quality) {
    // AVIF: check browser support, fall back to WEBP
    let mime = MIME_MAP[format];
    let actualFormat = format;

    if (format === 'avif') {
      const testCanvas = document.createElement('canvas');
      testCanvas.width = 1;
      testCanvas.height = 1;
      const testBlob = await new Promise(r => testCanvas.toBlob(r, 'image/avif', 0.5));
      if (!testBlob || testBlob.type !== 'image/avif') {
        // Fallback to WEBP
        mime = 'image/webp';
        actualFormat = 'webp';
      }
    }

    const blob = await new Promise((resolve) => {
      canvas.toBlob((b) => resolve(b), mime, quality);
    });

    return { blob, actualFormat };
  }

  // ─── BINARY SEARCH QUALITY SOLVER ─── ─────────────────────────
  // 6 iterations binary search between q=0.05 and q=0.95
  // + up to 7 multi-pass resolution down-steps (0.72x per pass)
  async function solveForTargetSize(img, targetW, targetH, format, targetBytes) {
    let bestBlob = null;
    let bestW = targetW;
    let bestH = targetH;
    let currentW = targetW;
    let currentH = targetH;

    for (let pass = 0; pass < 7; pass++) {
      let lo = 0.05, hi = 0.95;
      let passBlob = null;

      for (let iter = 0; iter < 6; iter++) {
        const mid = (lo + hi) / 2;
        const canvas = drawToCanvas(img, currentW, currentH, format);
        const { blob } = await canvasToBlob(canvas, format, mid);

        if (blob.size <= targetBytes) {
          passBlob = blob;
          bestBlob = blob;
          bestW = currentW;
          bestH = currentH;
          lo = mid; // try higher quality
        } else {
          hi = mid; // need lower quality
        }
      }

      // If we found a result under budget, done
      if (passBlob && passBlob.size <= targetBytes) {
        return { blob: bestBlob, width: bestW, height: bestH };
      }

      // Down-step resolution by 0.72x
      currentW = Math.max(16, Math.round(currentW * 0.72));
      currentH = Math.max(16, Math.round(currentH * 0.72));
    }

    // Final attempt at minimum quality and reduced resolution
    if (!bestBlob || bestBlob.size > targetBytes) {
      const canvas = drawToCanvas(img, currentW, currentH, format);
      const { blob } = await canvasToBlob(canvas, format, 0.05);
      return { blob, width: currentW, height: currentH };
    }

    return { blob: bestBlob, width: bestW, height: bestH };
  }

  // ─── MAIN IMAGE PROCESSING PIPELINE ─── ───────────────────────
  async function processImage(file, settings, onStatus) {
    if (onStatus) onStatus(`Decoding ${file.name}…`);
    const img = await decodeFile(file);
    const srcW = img.naturalWidth || img.width;
    const srcH = img.naturalHeight || img.height;

    const profile = COMPRESSION_PROFILES[settings.profile || 'balanced'];
    const format = settings.outputFormat || 'webp';

    // Compute target dimensions
    let { width, height } = computeDimensions(srcW, srcH, settings);

    // Apply profile subsampling
    ({ width, height } = applyProfileSubsampling(width, height, settings.profile, settings.resizeMode));

    if (onStatus) onStatus(`Resizing ${file.name} to ${width}×${height}…`);

    // Target file size mode
    if (settings.resizeMode === 'filesize') {
      const targetBytes = targetBytesFromInput(settings.targetSize, settings.targetUnit);
      if (targetBytes) {
        const result = await solveForTargetSize(img, width, height, format, targetBytes);
        const ext = EXT_MAP[result.actualFormat || format] || EXT_MAP[format];
        return {
          blob: result.blob,
          filename: baseName(file.name) + ext,
          originalSize: file.size,
          newSize: result.blob.size,
          width: result.width,
          height: result.height,
        };
      }
    }

    // Standard encoding
    const canvas = drawToCanvas(img, width, height, format);
    const { blob, actualFormat } = await canvasToBlob(canvas, format, profile.quality);
    const ext = EXT_MAP[actualFormat] || EXT_MAP[format];

    return {
      blob,
      filename: baseName(file.name) + ext,
      originalSize: file.size,
      newSize: blob.size,
      width,
      height,
    };
  }

  // ─── PDF TO IMAGE PIPELINE ─── ────────────────────────────────
  async function pdfToImages(file, settings, onProgress) {
    const pdfjs = await ensurePdfJs();
    const buf = await file.arrayBuffer();
    const doc = await pdfjs.getDocument({ data: buf }).promise;
    const numPages = doc.numPages;
    const results = [];
    const profile = COMPRESSION_PROFILES[settings.profile || 'balanced'];
    const format = settings.outputFormat || 'webp';
    const pdfName = baseName(file.name);

    // Base DPI scale factor
    let dpiScale = 2.0; // High DPI rendering
    if (settings.profile === 'smallest') dpiScale = 1.2;
    if (settings.profile === 'lossless') dpiScale = 3.0;

    // Per-page target bytes for filesize mode
    let perPageBytes = null;
    if (settings.resizeMode === 'filesize') {
      const totalBytes = targetBytesFromInput(settings.targetSize, settings.targetUnit);
      if (totalBytes) perPageBytes = totalBytes / numPages;
    }

    for (let i = 1; i <= numPages; i++) {
      if (onProgress) onProgress(`Rendering ${file.name} page ${i}/${numPages}…`, (i - 1) / numPages);

      const page = await doc.getPage(i);
      const viewport = page.getViewport({ scale: dpiScale });

      const canvas = document.createElement('canvas');
      canvas.width = viewport.width;
      canvas.height = viewport.height;
      const ctx = canvas.getContext('2d');

      // White background for PDFs
      ctx.fillStyle = '#FFFFFF';
      ctx.fillRect(0, 0, canvas.width, canvas.height);

      await page.render({ canvasContext: ctx, viewport }).promise;

      // Create image from canvas
      const imgBitmap = await createImageBitmap(canvas);
      const srcW = canvas.width;
      const srcH = canvas.height;

      let { width, height } = computeDimensions(srcW, srcH, settings);
      ({ width, height } = applyProfileSubsampling(width, height, settings.profile, settings.resizeMode));

      let result;
      if (perPageBytes) {
        result = await solveForTargetSize(imgBitmap, width, height, format, perPageBytes);
      } else {
        const outCanvas = drawToCanvas(imgBitmap, width, height, format);
        const { blob, actualFormat } = await canvasToBlob(outCanvas, format, profile.quality);
        result = { blob, width, height, actualFormat };
      }

      const ext = EXT_MAP[result.actualFormat || format] || EXT_MAP[format];
      results.push({
        blob: result.blob,
        filename: `${pdfName}_page_${i}${ext}`,
        originalSize: file.size,
        newSize: result.blob.size,
        width: result.width || width,
        height: result.height || height,
        pageIndex: i,
        totalPages: numPages,
      });
    }

    return results;
  }

  // ─── IMAGE TO PDF PIPELINE ─── ────────────────────────────────
  async function imagesToPdf(files, settings, onProgress) {
    const { PDFDocument } = PDFLib;
    const pdfDoc = await PDFDocument.create();
    const profile = COMPRESSION_PROFILES[settings.profile || 'balanced'];
    const layout = settings.pdfLayout || 'fitImage';
    const results = [];
    let totalOrigSize = 0;

    for (let i = 0; i < files.length; i++) {
      const file = files[i];
      if (onProgress) onProgress(`Processing image ${i + 1}/${files.length}: ${file.name}…`, i / files.length);

      totalOrigSize += file.size;
      const img = await decodeFile(file);
      const srcW = img.naturalWidth || img.width;
      const srcH = img.naturalHeight || img.height;

      let { width, height } = computeDimensions(srcW, srcH, settings);
      ({ width, height } = applyProfileSubsampling(width, height, settings.profile, settings.resizeMode));

      // Render as JPEG for embedding (pdf-lib supports JPEG and PNG)
      let embedFormat = 'jpeg';
      const canvas = drawToCanvas(img, width, height, embedFormat);

      let blob;
      if (settings.resizeMode === 'filesize') {
        const totalBytes = targetBytesFromInput(settings.targetSize, settings.targetUnit);
        const perImageBytes = totalBytes ? totalBytes / files.length : null;
        if (perImageBytes) {
          const r = await solveForTargetSize(img, width, height, embedFormat, perImageBytes);
          blob = r.blob;
          width = r.width;
          height = r.height;
        } else {
          ({ blob } = await canvasToBlob(canvas, embedFormat, profile.quality));
        }
      } else {
        ({ blob } = await canvasToBlob(canvas, embedFormat, profile.quality));
      }

      const imgBytes = new Uint8Array(await blob.arrayBuffer());
      const embeddedImg = await pdfDoc.embedJpg(imgBytes);

      // Page layout
      let pageW, pageH, drawX, drawY, drawW, drawH;

      if (layout === 'fitImage') {
        pageW = width;
        pageH = height;
        drawX = 0;
        drawY = 0;
        drawW = width;
        drawH = height;
      } else {
        const pageSize = PAGE_SIZES[layout] || PAGE_SIZES.a4;
        pageW = pageSize.width;
        pageH = pageSize.height;
        const availW = pageW - 2 * PDF_MARGIN;
        const availH = pageH - 2 * PDF_MARGIN;
        const ratio = Math.min(availW / width, availH / height, 1);
        drawW = width * ratio;
        drawH = height * ratio;
        drawX = PDF_MARGIN + (availW - drawW) / 2;
        drawY = PDF_MARGIN + (availH - drawH) / 2;
      }

      const page = pdfDoc.addPage([pageW, pageH]);
      page.drawImage(embeddedImg, {
        x: drawX,
        y: drawY,
        width: drawW,
        height: drawH,
      });

      results.push({
        filename: file.name,
        originalSize: file.size,
        width,
        height,
      });
    }

    if (onProgress) onProgress('Building PDF…', 0.95);
    const pdfBytes = await pdfDoc.save();
    const pdfBlob = new Blob([pdfBytes], { type: 'application/pdf' });

    return {
      blob: pdfBlob,
      filename: files.length === 1 ? baseName(files[0].name) + '.pdf' : 'images_combined.pdf',
      originalSize: totalOrigSize,
      newSize: pdfBlob.size,
      pages: results,
    };
  }

  // ─── PDF COMPRESS PIPELINE ─── ────────────────────────────────
  async function compressPdf(file, settings, onProgress) {
    const pdfjs = await ensurePdfJs();
    const { PDFDocument } = PDFLib;

    const buf = await file.arrayBuffer();
    const srcDoc = await pdfjs.getDocument({ data: buf }).promise;
    const numPages = srcDoc.numPages;
    const outDoc = await PDFDocument.create();
    const profile = COMPRESSION_PROFILES[settings.profile || 'balanced'];

    // DPI scale based on profile
    let dpiScale = 1.5;
    if (settings.profile === 'smallest') dpiScale = 1.0;
    if (settings.profile === 'lossless') dpiScale = 2.5;

    // Per-page target bytes for filesize mode
    let perPageBytes = null;
    if (settings.resizeMode === 'filesize') {
      const totalBytes = targetBytesFromInput(settings.targetSize, settings.targetUnit);
      if (totalBytes) perPageBytes = totalBytes / numPages;
    }

    const pageResults = [];

    for (let i = 1; i <= numPages; i++) {
      if (onProgress) onProgress(`Compressing page ${i}/${numPages}…`, (i - 1) / numPages);

      const page = await srcDoc.getPage(i);
      const vp = page.getViewport({ scale: dpiScale });

      const canvas = document.createElement('canvas');
      canvas.width = vp.width;
      canvas.height = vp.height;
      const ctx = canvas.getContext('2d');
      ctx.fillStyle = '#FFFFFF';
      ctx.fillRect(0, 0, canvas.width, canvas.height);
      await page.render({ canvasContext: ctx, viewport: vp }).promise;

      const srcW = canvas.width;
      const srcH = canvas.height;
      let { width, height } = computeDimensions(srcW, srcH, settings);
      ({ width, height } = applyProfileSubsampling(width, height, settings.profile, settings.resizeMode));

      let blob;
      const imgBitmap = await createImageBitmap(canvas);

      if (perPageBytes) {
        const r = await solveForTargetSize(imgBitmap, width, height, 'jpeg', perPageBytes);
        blob = r.blob;
        width = r.width;
        height = r.height;
      } else {
        const outCanvas = drawToCanvas(imgBitmap, width, height, 'jpeg');
        ({ blob } = await canvasToBlob(outCanvas, 'jpeg', profile.quality));
      }

      const imgBytes = new Uint8Array(await blob.arrayBuffer());
      const embeddedImg = await outDoc.embedJpg(imgBytes);

      // Use original page dimensions (in points)
      const origVp = page.getViewport({ scale: 1.0 });
      const outPage = outDoc.addPage([origVp.width, origVp.height]);
      outPage.drawImage(embeddedImg, {
        x: 0, y: 0,
        width: origVp.width,
        height: origVp.height,
      });

      pageResults.push({ width, height });
    }

    if (onProgress) onProgress('Saving compressed PDF…', 0.95);
    const pdfBytes = await outDoc.save();
    const pdfBlob = new Blob([pdfBytes], { type: 'application/pdf' });

    return {
      blob: pdfBlob,
      filename: baseName(file.name) + '_compressed.pdf',
      originalSize: file.size,
      newSize: pdfBlob.size,
      width: pageResults[0]?.width || 0,
      height: pageResults[0]?.height || 0,
      numPages,
    };
  }

  // ─── EXCEL TO PDF PIPELINE ─── ─────────────────────────────────
  // Page sizes in points (72 DPI)
  const EXCEL_PAGE_SIZES = {
    a4:     { width: 595.28, height: 841.89 },
    letter: { width: 612, height: 792 },
    a3:     { width: 841.89, height: 1190.55 },
    legal:  { width: 612, height: 1008 },
  };

  // Cache of character encodability in PDF StandardFonts (WinAnsi)
  const encodableCharCache = new Map();
  function normalizeText(text) {
    if (text === null || text === undefined) return '';
    return String(text)
      .replace(/[\u2018\u2019]/g, "'")
      .replace(/[\u201C\u201D]/g, '"')
      .replace(/\u2014/g, '--')
      .replace(/\u2013/g, '-')
      .replace(/\u2026/g, '...')
      .replace(/\u2022/g, '*')
      .replace(/\u00A0/g, ' ')
      .replace(/\t/g, '    ');
  }

  function isCharEncodable(char, fontObj) {
    const code = char.charCodeAt(0);
    if (code >= 32 && code <= 126) return true;
    if (code < 32 && char !== '\n' && char !== '\r') return false;
    if (encodableCharCache.has(char)) return encodableCharCache.get(char);
    try {
      fontObj.widthOfTextAtSize(char, 10);
      encodableCharCache.set(char, true);
      return true;
    } catch {
      encodableCharCache.set(char, false);
      return false;
    }
  }

  function cleanTextForPdf(text, fontObj) {
    if (!text) return '';
    const normalized = normalizeText(text);
    let out = '';
    for (let i = 0; i < normalized.length; i++) {
      const ch = normalized[i];
      out += isCharEncodable(ch, fontObj) ? ch : '?';
    }
    return out;
  }

  function getCellFormattedText(cell) {
    if (!cell) return '';
    // cell.w contains the exact formatted representation from Excel (e.g., "$1,234.50", "15.0%", "2024-05-12")
    if (cell.w !== undefined && cell.w !== null) {
      return String(cell.w);
    }
    if (cell.v !== undefined && cell.v !== null) {
      if (cell.v instanceof Date) {
        return cell.v.toLocaleDateString();
      }
      return String(cell.v);
    }
    return '';
  }

  function wrapText(text, maxPixelWidth, fontObj, fontSize) {
    if (!text || maxPixelWidth <= 0) return [''];
    const clean = cleanTextForPdf(text, fontObj);
    const paragraphs = clean.split(/\r\n|\r|\n/);
    const resultLines = [];

    for (const para of paragraphs) {
      if (!para.trim()) {
        resultLines.push('');
        continue;
      }
      const words = para.split(' ');
      let currentLine = '';

      for (let i = 0; i < words.length; i++) {
        const word = words[i];
        const testLine = currentLine ? `${currentLine} ${word}` : word;
        const testW = fontObj.widthOfTextAtSize(testLine, fontSize);

        if (testW <= maxPixelWidth || !currentLine) {
          currentLine = testLine;
        } else {
          resultLines.push(currentLine);
          currentLine = word;
        }
      }
      if (currentLine) {
        resultLines.push(currentLine);
      }
    }

    return resultLines.length > 0 ? resultLines : [''];
  }

  function getCellAlignment(cell, isHeaderRow) {
    if (cell?.s?.alignment?.horizontal) {
      return cell.s.alignment.horizontal;
    }
    if (isHeaderRow) return 'center';
    if (!cell) return 'left';
    if (cell.t === 'n') return 'right';
    if (cell.t === 'b' || cell.t === 'e') return 'center';
    const text = getCellFormattedText(cell).trim();
    if (/^[\$\€\£\¥]?\s*[\-\+]?[\d,]+(\.\d+)?\s*\%?$/.test(text) && !/[a-zA-Z]{3,}/.test(text)) {
      return 'right';
    }
    return 'left';
  }

  function parseCellColor(colorObj, defaultColor) {
    if (!colorObj) return defaultColor;
    if (colorObj.rgb && typeof colorObj.rgb === 'string' && colorObj.rgb.length >= 6) {
      const hex = colorObj.rgb.slice(-6);
      const r = parseInt(hex.substring(0, 2), 16) / 255;
      const g = parseInt(hex.substring(2, 4), 16) / 255;
      const b = parseInt(hex.substring(4, 6), 16) / 255;
      if (!isNaN(r) && !isNaN(g) && !isNaN(b)) {
        return PDFLib.rgb(r, g, b);
      }
    }
    return defaultColor;
  }

  async function excelToPdf(file, settings, onProgress) {
    const { PDFDocument, rgb, StandardFonts } = PDFLib;

    if (onProgress) onProgress(`Reading ${file.name}…`, 0);

    // Parse Excel workbook with SheetJS preserving formatting, merges & styles
    const buf = await file.arrayBuffer();
    const workbook = XLSX.read(buf, {
      type: 'array',
      cellDates: true,
      cellStyles: true,
      cellNF: true,
      sheetStubs: true,
    });

    if (!workbook || !workbook.SheetNames || workbook.SheetNames.length === 0) {
      throw new Error('No sheets found in spreadsheet');
    }

    const pdfDoc = await PDFDocument.create();
    const font = await pdfDoc.embedFont(StandardFonts.Helvetica);
    const fontBold = await pdfDoc.embedFont(StandardFonts.HelveticaBold);

    const pageSize = settings.excelPageSize || 'a4';
    const orientationPref = settings.excelOrientation || 'auto';
    const tableStyle = settings.excelTableStyle || 'excel';
    const fontSizePref = settings.excelFontSize || 'auto';

    const margin = 32; // Points (clean ~0.44 inch margin for maximum table area)
    const cellPadding = 4;

    const totalSheets = workbook.SheetNames.length;
    let sheetsProcessed = 0;

    for (const sheetName of workbook.SheetNames) {
      if (onProgress) onProgress(`Processing sheet: ${sheetName}…`, sheetsProcessed / totalSheets);

      const worksheet = workbook.Sheets[sheetName];
      if (!worksheet || !worksheet['!ref']) {
        sheetsProcessed++;
        continue;
      }

      const range = XLSX.utils.decode_range(worksheet['!ref']);
      const numRows = range.e.r - range.s.r + 1;
      const numCols = range.e.c - range.s.c + 1;

      if (numRows <= 0 || numCols <= 0) {
        sheetsProcessed++;
        continue;
      }

      // Trim trailing empty rows so we don't output dozens of blank lines
      let effectiveEndRow = range.e.r;
      while (effectiveEndRow >= range.s.r) {
        let rowHasData = false;
        for (let c = range.s.c; c <= range.e.c; c++) {
          const addr = XLSX.utils.encode_cell({ r: effectiveEndRow, c });
          if (worksheet[addr] && getCellFormattedText(worksheet[addr]).trim() !== '') {
            rowHasData = true;
            break;
          }
        }
        if (rowHasData) break;
        effectiveEndRow--;
      }

      if (effectiveEndRow < range.s.r) {
        // Completely blank sheet
        sheetsProcessed++;
        continue;
      }

      const totalActiveRows = effectiveEndRow - range.s.r + 1;

      // Determine page orientation
      let landscape = false;
      if (orientationPref === 'landscape') {
        landscape = true;
      } else if (orientationPref === 'portrait') {
        landscape = false;
      } else {
        // Auto: landscape if more than 6 columns or wide sheet
        landscape = numCols > 6;
      }

      const pageDims = EXCEL_PAGE_SIZES[pageSize] || EXCEL_PAGE_SIZES.a4;
      const pageW = landscape ? pageDims.height : pageDims.width;
      const pageH = landscape ? pageDims.width : pageDims.height;

      const usableW = Math.max(100, pageW - 2 * margin);
      const usableH = Math.max(100, pageH - 2 * margin);

      // Determine base font size
      let fontSize;
      if (fontSizePref === 'auto') {
        if (numCols <= 6) fontSize = 10;
        else if (numCols <= 9) fontSize = 9;
        else if (numCols <= 13) fontSize = 8;
        else if (numCols <= 18) fontSize = 7;
        else fontSize = 6;
      } else {
        fontSize = parseInt(fontSizePref, 10) || 10;
      }

      const lineHeight = fontSize * 1.25;

      // Map merged cells
      const merges = worksheet['!merges'] || [];
      const mergeMap = new Map();
      for (const m of merges) {
        const colspan = m.e.c - m.s.c + 1;
        const rowspan = m.e.r - m.s.r + 1;
        for (let r = m.s.r; r <= m.e.r; r++) {
          for (let c = m.s.c; c <= m.e.c; c++) {
            if (r === m.s.r && c === m.s.c) {
              mergeMap.set(`${r},${c}`, { isMaster: true, colspan, rowspan });
            } else {
              mergeMap.set(`${r},${c}`, { isMaster: false, masterR: m.s.r, masterC: m.s.c });
            }
          }
        }
      }

      // Calculate column widths: respect worksheet['!cols'] if present, else content width
      const colExplicit = worksheet['!cols'] || [];
      const rawColWidths = [];

      for (let c = range.s.c; c <= range.e.c; c++) {
        const colIdx = c - range.s.c;
        const colDef = colExplicit[c];
        let w = 0;

        if (colDef) {
          if (colDef.wpx) w = colDef.wpx * 0.75;
          else if (colDef.wch) w = colDef.wch * 7.0;
          else if (colDef.width) w = colDef.width * 7.0;
        }

        if (w <= 0) {
          // Content-based measurement
          let maxChars = 3;
          for (let r = range.s.r; r <= effectiveEndRow; r++) {
            const addr = XLSX.utils.encode_cell({ r, c });
            const cell = worksheet[addr];
            const text = getCellFormattedText(cell);
            if (text.length > maxChars) {
              maxChars = Math.min(text.length, 50);
            }
          }
          w = maxChars * (fontSize * 0.58) + cellPadding * 2 + 6;
        }

        rawColWidths[colIdx] = Math.max(w, 20);
      }

      // Proportional normalization to exactly fit usableW
      const totalRawW = rawColWidths.reduce((a, b) => a + b, 0);
      const colWidths = rawColWidths.map(w => Math.max(16, (w / totalRawW) * usableW));
      const normalizedTotalW = colWidths.reduce((a, b) => a + b, 0);
      for (let i = 0; i < colWidths.length; i++) {
        colWidths[i] = (colWidths[i] / normalizedTotalW) * usableW;
      }

      // Detect header row (row 0 or range.s.r)
      const firstRowIdx = range.s.r;
      let hasHeader = false;
      if (worksheet['!autofilter']) {
        hasHeader = true;
      } else {
        let textCount = 0;
        for (let c = range.s.c; c <= range.e.c; c++) {
          const addr = XLSX.utils.encode_cell({ r: firstRowIdx, c });
          const cell = worksheet[addr];
          if (cell && (cell.t === 's' || typeof cell.v === 'string') && String(cell.v).trim().length > 0 && isNaN(Number(cell.v))) {
            textCount++;
          }
        }
        hasHeader = textCount >= Math.min(2, numCols);
      }

      // Colors matching authentic Excel styling
      const excelGridBorder = rgb(0.83, 0.85, 0.88); // #D4D8DE - subtle Excel gridline
      const excelHeaderBg = rgb(0.95, 0.96, 0.98);   // #F1F5F9 - clean header tint
      const excelStripeBg = rgb(0.97, 0.98, 0.99);   // #F8FAFC - gentle stripe
      const textPrimary = rgb(0.06, 0.09, 0.16);     // #0F172A - crisp dark text
      const textHeader = rgb(0.12, 0.16, 0.23);      // #1E293B - bold header text
      const borderDark = rgb(0.68, 0.72, 0.78);      // #AEB8C6 - structured border

      // Pre-calculate wrapped lines and row heights for every row
      const preppedRows = [];
      const rowHeights = [];

      for (let r = range.s.r; r <= effectiveEndRow; r++) {
        const rowIdx = r - range.s.r;
        const isHeaderRow = hasHeader && r === firstRowIdx;
        const cells = [];
        let maxRowH = fontSize + cellPadding * 2 + 4;

        for (let c = range.s.c; c <= range.e.c; c++) {
          const colIdx = c - range.s.c;
          const mergeInfo = mergeMap.get(`${r},${c}`);

          if (mergeInfo && !mergeInfo.isMaster) {
            cells.push({ isCovered: true });
            continue;
          }

          const colspan = mergeInfo ? mergeInfo.colspan : 1;
          const rowspan = mergeInfo ? mergeInfo.rowspan : 1;

          // Compute cell width spanning merged columns
          let cellW = 0;
          for (let k = 0; k < colspan && (colIdx + k) < colWidths.length; k++) {
            cellW += colWidths[colIdx + k];
          }

          const addr = XLSX.utils.encode_cell({ r, c });
          const cell = worksheet[addr];
          const text = getCellFormattedText(cell);
          const isBold = isHeaderRow || !!cell?.s?.font?.bold;
          const fontToUse = isBold ? fontBold : font;
          const align = getCellAlignment(cell, isHeaderRow);
          const customBg = cell?.s?.fill ? parseCellColor(cell.s.fill.fgColor, null) : null;

          const lines = wrapText(text, cellW - cellPadding * 2, fontToUse, fontSize);

          if (rowspan === 1) {
            const neededH = lines.length * lineHeight + cellPadding * 2 + 2;
            if (neededH > maxRowH) maxRowH = neededH;
          }

          cells.push({
            isCovered: false,
            text,
            lines,
            align,
            colspan,
            rowspan,
            cellW,
            isBold,
            customBg,
          });
        }

        // Check worksheet['!rows'] for explicit row height
        if (worksheet['!rows'] && worksheet['!rows'][r]?.hpt) {
          maxRowH = Math.max(maxRowH, worksheet['!rows'][r].hpt);
        }

        rowHeights[rowIdx] = maxRowH;
        preppedRows[rowIdx] = { isHeaderRow, cells };
      }

      // Paginate rows
      const headerSpace = 32; // Title banner at top of page
      const availableTableH = usableH - headerSpace;
      const headerRowH = hasHeader ? rowHeights[0] : 0;
      const startDataRowIdx = hasHeader ? 1 : 0;

      const pageRowSlices = [];
      let currentSlice = [];
      let currentSliceH = 0;

      for (let i = startDataRowIdx; i < preppedRows.length; i++) {
        const h = rowHeights[i];
        if (currentSlice.length > 0 && currentSliceH + h + headerRowH > availableTableH) {
          pageRowSlices.push(currentSlice);
          currentSlice = [i];
          currentSliceH = h;
        } else {
          currentSlice.push(i);
          currentSliceH += h;
        }
      }
      if (currentSlice.length > 0 || pageRowSlices.length === 0) {
        pageRowSlices.push(currentSlice);
      }

      const totalSheetPages = pageRowSlices.length;

      // Render each page
      for (let pIdx = 0; pIdx < totalSheetPages; pIdx++) {
        const page = pdfDoc.addPage([pageW, pageH]);
        let y = pageH - margin;

        // Top Sheet Banner: Sheet name (left), Page number (right)
        const displaySheetTitle = totalSheets > 1 ? `${file.name} — ${sheetName}` : `${file.name.replace(/\.[^/.]+$/, '')} — ${sheetName}`;
        page.drawText(cleanTextForPdf(displaySheetTitle, fontBold), {
          x: margin,
          y: y - 10,
          size: 11,
          font: fontBold,
          color: textPrimary,
        });

        const pageLabel = `Page ${pIdx + 1} of ${totalSheetPages}`;
        const pageLabelW = font.widthOfTextAtSize(pageLabel, 9);
        page.drawText(pageLabel, {
          x: pageW - margin - pageLabelW,
          y: y - 10,
          size: 9,
          font: font,
          color: rgb(0.45, 0.49, 0.56),
        });

        // Banner divider line
        page.drawLine({
          start: { x: margin, y: y - 18 },
          end: { x: margin + usableW, y: y - 18 },
          thickness: 0.75,
          color: borderDark,
        });

        y -= headerSpace;

        // Rows to render on this page: header row (if exists) + current slice of data rows
        const rowsToDraw = [];
        if (hasHeader) {
          rowsToDraw.push({ rowIdx: 0, isHeader: true });
        }
        for (const rowIdx of pageRowSlices[pIdx]) {
          rowsToDraw.push({ rowIdx, isHeader: false });
        }

        // Draw each row
        for (const item of rowsToDraw) {
          const rowIdx = item.rowIdx;
          const isHeader = item.isHeader;
          const rowData = preppedRows[rowIdx];
          if (!rowData) continue;

          const rowH = rowHeights[rowIdx];
          let currentX = margin;

          for (let colIdx = 0; colIdx < rowData.cells.length; colIdx++) {
            const cellInfo = rowData.cells[colIdx];
            const colW = colWidths[colIdx];

            if (cellInfo.isCovered) {
              currentX += colW;
              continue;
            }

            const cellW = cellInfo.cellW;
            let cellH = rowH;
            if (cellInfo.rowspan > 1) {
              cellH = 0;
              for (let s = 0; s < cellInfo.rowspan && (rowIdx + s) < rowHeights.length; s++) {
                cellH += rowHeights[rowIdx + s];
              }
            }

            // Cell Background
            let bg = rgb(1, 1, 1);
            if (cellInfo.customBg) {
              bg = cellInfo.customBg;
            } else if (isHeader) {
              bg = excelHeaderBg;
            } else if (tableStyle === 'striped' && (rowIdx % 2 === 1)) {
              bg = excelStripeBg;
            }

            page.drawRectangle({
              x: currentX,
              y: y - cellH,
              width: cellW,
              height: cellH,
              color: bg,
            });

            // Cell Border
            if (tableStyle !== 'minimal') {
              const bColor = isHeader ? borderDark : (tableStyle === 'bordered' ? borderDark : excelGridBorder);
              page.drawRectangle({
                x: currentX,
                y: y - cellH,
                width: cellW,
                height: cellH,
                borderColor: bColor,
                borderWidth: isHeader ? 0.75 : 0.5,
              });
            } else {
              // Minimal style: bottom border on rows
              page.drawLine({
                start: { x: currentX, y: y - cellH },
                end: { x: currentX + cellW, y: y - cellH },
                thickness: isHeader ? 1.0 : 0.5,
                color: isHeader ? borderDark : excelGridBorder,
              });
            }

            // Cell Text
            if (cellInfo.lines && cellInfo.lines.length > 0) {
              const fontToUse = cellInfo.isBold ? fontBold : font;
              const textColor = isHeader ? textHeader : textPrimary;
              const totalTextH = cellInfo.lines.length * lineHeight;
              const topPad = Math.max(cellPadding, (cellH - totalTextH) / 2);

              for (let lIdx = 0; lIdx < cellInfo.lines.length; lIdx++) {
                const line = cellInfo.lines[lIdx];
                if (!line) continue;

                const cleanLine = cleanTextForPdf(line, fontToUse);
                if (!cleanLine) continue;

                const textW = fontToUse.widthOfTextAtSize(cleanLine, fontSize);
                let textX;
                if (cellInfo.align === 'right') {
                  textX = currentX + cellW - cellPadding - textW;
                } else if (cellInfo.align === 'center') {
                  textX = currentX + (cellW - textW) / 2;
                } else {
                  textX = currentX + cellPadding;
                }

                const textY = y - topPad - (lIdx + 1) * lineHeight + (fontSize * 0.22);
                page.drawText(cleanLine, {
                  x: Math.max(currentX + 1, textX),
                  y: textY,
                  size: fontSize,
                  font: fontToUse,
                  color: textColor,
                });
              }
            }

            currentX += colW;
          }

          y -= rowH;
        }

        // Draw clean bottom bounding line for the table
        page.drawLine({
          start: { x: margin, y },
          end: { x: margin + usableW, y },
          thickness: 0.75,
          color: borderDark,
        });
      }

      sheetsProcessed++;
    }

    // Ensure at least one page exists
    if (pdfDoc.getPageCount() === 0) {
      const pageDims = EXCEL_PAGE_SIZES[pageSize] || EXCEL_PAGE_SIZES.a4;
      const page = pdfDoc.addPage([pageDims.width, pageDims.height]);
      page.drawText('The spreadsheet contains no data or empty sheets.', {
        x: margin,
        y: pageDims.height - margin - 20,
        size: 11,
        font: font,
        color: rgb(0.1, 0.1, 0.2),
      });
    }

    if (onProgress) onProgress('Saving PDF…', 0.95);
    const pdfBytes = await pdfDoc.save();
    const pdfBlob = new Blob([pdfBytes], { type: 'application/pdf' });

    return {
      blob: pdfBlob,
      filename: baseName(file.name) + '.pdf',
      originalSize: file.size,
      newSize: pdfBlob.size,
      sheets: totalSheets,
      pages: pdfDoc.getPageCount(),
    };
  }

  // ─── ZIP BUILDER ─── ──────────────────────────────────────────
  async function buildZip(items) {
    const zip = new JSZip();
    for (const item of items) {
      zip.file(item.filename, item.blob);
    }
    return zip.generateAsync({ type: 'blob', compression: 'DEFLATE', compressionOptions: { level: 6 } });
  }

  // ─── PUBLIC API ─── ───────────────────────────────────────────
  return {
    processImage,
    pdfToImages,
    imagesToPdf,
    compressPdf,
    excelToPdf,
    buildZip,
    formatBytes,
    baseName,
    EXT_MAP,
    MIME_MAP,
  };
})();
