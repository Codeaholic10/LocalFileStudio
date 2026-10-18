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

  async function excelToPdf(file, settings, onProgress) {
    const { PDFDocument, rgb, StandardFonts } = PDFLib;

    if (onProgress) onProgress(`Reading ${file.name}…`, 0);

    // Parse Excel file with SheetJS
    const buf = await file.arrayBuffer();
    const workbook = XLSX.read(buf, { type: 'array', cellDates: true, cellStyles: true });

    const pdfDoc = await PDFDocument.create();
    const font = await pdfDoc.embedFont(StandardFonts.Helvetica);
    const fontBold = await pdfDoc.embedFont(StandardFonts.HelveticaBold);

    const pageSize = settings.excelPageSize || 'a4';
    const orientationPref = settings.excelOrientation || 'auto';
    const tableStyle = settings.excelTableStyle || 'striped';
    const fontSizePref = settings.excelFontSize || '10';

    const margin = 40; // points
    const headerRowHeight = 20;
    const cellPadding = 4;

    let totalSheets = workbook.SheetNames.length;
    let sheetsProcessed = 0;

    for (const sheetName of workbook.SheetNames) {
      if (onProgress) onProgress(`Processing sheet: ${sheetName}…`, sheetsProcessed / totalSheets);

      const worksheet = workbook.Sheets[sheetName];
      const jsonData = XLSX.utils.sheet_to_json(worksheet, { header: 1, defval: '' });

      // Skip empty sheets
      if (jsonData.length === 0) { sheetsProcessed++; continue; }

      // Determine max column count
      let maxCols = 0;
      for (const row of jsonData) {
        if (row.length > maxCols) maxCols = row.length;
      }
      if (maxCols === 0) { sheetsProcessed++; continue; }

      // Determine orientation
      let landscape = false;
      if (orientationPref === 'landscape') landscape = true;
      else if (orientationPref === 'auto') landscape = maxCols > 5;

      const pageDims = EXCEL_PAGE_SIZES[pageSize] || EXCEL_PAGE_SIZES.a4;
      const pageW = landscape ? pageDims.height : pageDims.width;
      const pageH = landscape ? pageDims.width : pageDims.height;

      const usableW = pageW - 2 * margin;
      const usableH = pageH - 2 * margin;

      // Compute column widths based on content
      const colMaxChars = new Array(maxCols).fill(2);
      for (const row of jsonData) {
        for (let c = 0; c < maxCols; c++) {
          const cell = row[c] !== undefined ? String(row[c]) : '';
          colMaxChars[c] = Math.max(colMaxChars[c], Math.min(cell.length, 40));
        }
      }
      const totalChars = colMaxChars.reduce((a, b) => a + b, 0);
      const colWidths = colMaxChars.map(ch => (ch / totalChars) * usableW);

      // Font size calculation
      let fontSize;
      if (fontSizePref === 'auto') {
        // Calculate based on fitting all columns
        const avgCharWidth = 0.5; // approximate ratio for Helvetica
        const minNeeded = colMaxChars.reduce((sum, ch) => sum + ch * avgCharWidth, 0) + maxCols * cellPadding * 2;
        fontSize = Math.min(12, Math.max(5, Math.floor(usableW / minNeeded)));
      } else {
        fontSize = parseInt(fontSizePref, 10) || 10;
      }

      const rowHeight = fontSize + cellPadding * 2 + 2;
      const headerHeight = fontSize + cellPadding * 2 + 4;

      // Colors
      const headerBg = rgb(0.2, 0.22, 0.35);       // Dark indigo
      const headerTextColor = rgb(1, 1, 1);          // White
      const stripeBg = rgb(0.94, 0.95, 0.98);        // Light gray-blue
      const borderColor = rgb(0.75, 0.78, 0.85);     // Soft gray
      const textColor = rgb(0.12, 0.12, 0.18);       // Near-black

      // Check if first row looks like a header (has text, not numbers)
      const firstRow = jsonData[0] || [];
      const hasHeader = firstRow.some(cell => typeof cell === 'string' && cell.trim().length > 0 && isNaN(Number(cell)));
      const headerRow = hasHeader ? jsonData[0] : null;
      const dataRows = hasHeader ? jsonData.slice(1) : jsonData;

      // Paginate rows
      const rowsPerPage = Math.max(1, Math.floor((usableH - (headerRow ? headerHeight : 0) - 20) / rowHeight));
      const totalPages = Math.ceil(dataRows.length / rowsPerPage);

      for (let pageIdx = 0; pageIdx < totalPages; pageIdx++) {
        const page = pdfDoc.addPage([pageW, pageH]);
        let y = pageH - margin;

        // Sheet name + page number at top
        const titleText = totalSheets > 1 ? `${sheetName}` : file.name.replace(/\.[^/.]+$/, '');
        page.drawText(titleText, {
          x: margin,
          y: y - fontSize,
          size: fontSize + 2,
          font: fontBold,
          color: textColor,
        });
        if (totalPages > 1) {
          const pageLabel = `Page ${pageIdx + 1} of ${totalPages}`;
          const labelW = font.widthOfTextAtSize(pageLabel, fontSize - 1);
          page.drawText(pageLabel, {
            x: pageW - margin - labelW,
            y: y - fontSize,
            size: fontSize - 1,
            font: font,
            color: rgb(0.5, 0.5, 0.6),
          });
        }
        y -= fontSize + 10;

        // Draw header row
        if (headerRow) {
          // Header background
          page.drawRectangle({
            x: margin,
            y: y - headerHeight,
            width: usableW,
            height: headerHeight,
            color: headerBg,
          });

          let hx = margin;
          for (let c = 0; c < maxCols; c++) {
            const cellText = truncateText(String(headerRow[c] || ''), colWidths[c] - cellPadding * 2, fontBold, fontSize);
            page.drawText(cellText, {
              x: hx + cellPadding,
              y: y - headerHeight + cellPadding + 2,
              size: fontSize,
              font: fontBold,
              color: headerTextColor,
            });
            hx += colWidths[c];
          }
          y -= headerHeight;
        }

        // Draw data rows for this page
        const startRow = pageIdx * rowsPerPage;
        const endRow = Math.min(startRow + rowsPerPage, dataRows.length);

        for (let r = startRow; r < endRow; r++) {
          const row = dataRows[r] || [];
          const relRow = r - startRow;

          // Row background
          if (tableStyle === 'striped' && relRow % 2 === 0) {
            page.drawRectangle({
              x: margin,
              y: y - rowHeight,
              width: usableW,
              height: rowHeight,
              color: stripeBg,
            });
          }

          // Row borders
          if (tableStyle === 'bordered') {
            page.drawRectangle({
              x: margin,
              y: y - rowHeight,
              width: usableW,
              height: rowHeight,
              borderColor: borderColor,
              borderWidth: 0.5,
            });
            // Vertical cell borders
            let bx = margin;
            for (let c = 0; c < maxCols; c++) {
              if (c > 0) {
                page.drawLine({
                  start: { x: bx, y: y },
                  end: { x: bx, y: y - rowHeight },
                  thickness: 0.5,
                  color: borderColor,
                });
              }
              bx += colWidths[c];
            }
          }

          // Cell text
          let cx = margin;
          for (let c = 0; c < maxCols; c++) {
            const rawVal = row[c] !== undefined ? row[c] : '';
            let cellStr;
            if (rawVal instanceof Date) {
              cellStr = rawVal.toLocaleDateString();
            } else {
              cellStr = String(rawVal);
            }
            const cellText = truncateText(cellStr, colWidths[c] - cellPadding * 2, font, fontSize);
            page.drawText(cellText, {
              x: cx + cellPadding,
              y: y - rowHeight + cellPadding + 1,
              size: fontSize,
              font: font,
              color: textColor,
            });
            cx += colWidths[c];
          }

          y -= rowHeight;
        }

        // Bottom line for minimal style
        if (tableStyle === 'minimal' && headerRow) {
          const lineY = pageH - margin - (fontSize + 10) - headerHeight;
          page.drawLine({
            start: { x: margin, y: lineY },
            end: { x: margin + usableW, y: lineY },
            thickness: 1.5,
            color: headerBg,
          });
        }

        // Bottom border line
        page.drawLine({
          start: { x: margin, y: y },
          end: { x: margin + usableW, y: y },
          thickness: 0.5,
          color: borderColor,
        });
      }

      sheetsProcessed++;
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
    };
  }

  // Truncate text to fit within a given pixel width
  function truncateText(text, maxWidth, fontObj, fontSize) {
    if (!text) return '';
    // Replace newlines and tabs
    text = text.replace(/[\r\n]+/g, ' ').replace(/\t/g, '  ');
    try {
      let tw = fontObj.widthOfTextAtSize(text, fontSize);
      if (tw <= maxWidth) return text;
      // Binary search for truncation point
      let lo = 0, hi = text.length;
      while (lo < hi) {
        const mid = Math.ceil((lo + hi) / 2);
        const tryStr = text.substring(0, mid) + '…';
        if (fontObj.widthOfTextAtSize(tryStr, fontSize) <= maxWidth) {
          lo = mid;
        } else {
          hi = mid - 1;
        }
      }
      return lo > 0 ? text.substring(0, lo) + '…' : '…';
    } catch {
      // Fallback for characters not in the font
      return text.substring(0, Math.max(1, Math.floor(maxWidth / (fontSize * 0.5))));
    }
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
