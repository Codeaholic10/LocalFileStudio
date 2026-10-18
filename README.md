# LocalFileStudio

> **100% Client-Side Offline Image, PDF & Excel Processing Suite (PWA)**  
> Zero server uploads. Zero external API calls. Zero privacy leaks. Zero paid subscriptions.

Local File Studio is an air-gapped ready Progressive Web App designed for high-performance in-browser image conversion, dimension resizing, target-size compression, PDF rasterization, multi-image PDF compilation, PDF optimization, and Excel-to-PDF table rendering.

---

## ✨ Features

### 1. 🖼️ Image Resize & Convert
- **Universal Input:** JPEG, PNG, WEBP, AVIF, HEIC/HEIF, TIFF, SVG, BMP, GIF.
- **Output Formats:** JPEG, PNG, WEBP, AVIF (with browser capability detection).
- **Dimension Modes:**
  - Original resolution
  - Percentage scaling (10% to 500%)
  - Custom width / height with aspect ratio lock
  - Longest edge constraint
- **Target File Size Solver:** Binary-search Canvas quality solver that iteratively converges to your target KB cap within a ±5% tolerance.
- **Batch Processing:** Multi-file queue with per-file status badges, live progress, and one-click ZIP packaging.

### 2. 📄 PDF to Image
- **Powered by Mozilla PDF.js:** Client-side rendering directly in WebAssembly/Worker memory.
- **Render Fidelity:** 1x (72 DPI), 2x (144 DPI), or 3x (300 DPI) print-ready rendering.
- **Selective Page Extraction:** Export all pages or custom ranges (e.g., `1, 3-5, 8`).
- **Export Options:** High-quality PNG, JPEG, or WEBP packed in a ZIP archive.

### 3. 📑 Image to PDF
- **Vector-accurate Assembly via pdf-lib:** Creates clean, standard-compliant PDF documents client-side.
- **Page Layout Customization:**
  - Page sizes: Fit to Image, Standard A4, or US Letter.
  - Page orientation: Auto (portrait/landscape detection), Portrait, or Landscape.
  - Margins: None (borderless), Small (10mm), or Normal (20mm).
- **Interactive Drag-and-Drop Reordering:** Easily organize pages before compilation.

### 4. 🗜️ PDF Compress & Flatten
- **Visual Optimization Pipeline:** Rasterizes heavy vector PDF pages to optimized JPEG/WEBP streams and recompiles a lightweight PDF.
- **Configurable DPI & Quality:** Balance visual clarity against file weight with real-time byte savings reporting.

### 5. 📊 Excel to PDF
- **Universal Spreadsheet Input:** XLSX, XLS, CSV, and ODS formats via SheetJS.
- **Multi-Sheet Support:** Each sheet rendered as its own set of paginated pages with automatic header detection.
- **Page Size Options:** A4, US Letter, A3, or US Legal.
- **Orientation Control:** Auto (landscape when columns > 5), Portrait, or Landscape.
- **Table Styling:**
  - Striped Rows — alternating shading for scan-friendly readability
  - Full Grid — every cell border visible
  - Minimal — header underline only, clean modern look
- **Font Size Options:** Small (8pt), Medium (10pt), Large (12pt), or Auto-fit to shrink text until all columns fit.
- **Smart Column Widths:** Proportional sizing based on content length.
- **Content-Aware Truncation:** Long cell values are truncated with "…" to fit, using binary-search width measurement.

---

## 🔒 Security & Privacy Architecture

- **Air-Gapped Operation:** All file manipulation executes directly within browser memory using HTML5 Canvas, typed arrays (`Uint8Array`), and vendored WebAssembly/JS engines.
- **Strict Content Security Policy (CSP):** Prohibits external network requests (`connect-src 'none'`).
- **Full Offline PWA:** Installable on Windows, macOS, Linux, Android, and iOS via Service Worker cache-first architecture.

---

## 🚀 Quick Start

### 1. Clone the repository
```bash
git clone https://github.com/Codeaholic10/LocalFileStudio.git
cd LocalFileStudio
```

### 2. Vendored Libraries
The core client libraries (`pdf-lib`, `pdfjs-dist`, `jszip`, `heic2any`, `UTIF.js`) are pre-vendored in `./libs/`. If you ever need to re-fetch them:
- **Windows (PowerShell):**
  ```powershell
  .\setup-libs.ps1
  ```
- **macOS / Linux:**
  ```bash
  chmod +x setup-libs.sh
  ./setup-libs.sh
  ```

### 3. Run Locally
Because the app uses ES Modules and Service Workers, it should be served via any local HTTP server:

```bash
# Using Python
python -m http.server 3000

# OR using Node.js / npx
npx serve .
```

Open `http://localhost:3000` in any modern web browser (Chrome, Edge, Firefox, Safari).

---

## 🛠️ Tech Stack & Vendored Libraries

| Library | Version | Role |
| :--- | :--- | :--- |
| **pdf-lib** | 1.17.1 | Vector PDF generation and modification |
| **PDF.js** | 4.10.38 | PDF page rendering and rasterization via Web Worker |
| **JSZip** | 3.10.1 | Client-side compression and bulk download bundling |
| **heic2any** | 0.0.4 | Apple HEIC/HEIF photo decoding |
| **UTIF.js** | latest | TIFF bitmap decoding |
| **SheetJS (xlsx)** | 0.20.3 | Client-side Excel/CSV/ODS spreadsheet parsing |
| **Vanilla JS & CSS** | Native | Zero-dependency responsive UI, micro-animations, dark mode |

---

## 📄 License

MIT License. Free and open source for personal and commercial use.
