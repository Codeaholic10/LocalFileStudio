# setup-libs.ps1 — Download all vendored dependencies into ./libs/
# Run once: powershell -ExecutionPolicy Bypass -File setup-libs.ps1

$ErrorActionPreference = "Stop"
$libsDir = Join-Path $PSScriptRoot "libs"

if (-not (Test-Path $libsDir)) {
    New-Item -ItemType Directory -Path $libsDir | Out-Null
}

$downloads = @(
    @{
        Name = "pdf-lib.min.js"
        Url  = "https://unpkg.com/pdf-lib@1.17.1/dist/pdf-lib.min.js"
    },
    @{
        Name = "pdf.min.mjs"
        Url  = "https://unpkg.com/pdfjs-dist@4.7.76/build/pdf.min.mjs"
    },
    @{
        Name = "pdf.worker.min.mjs"
        Url  = "https://unpkg.com/pdfjs-dist@4.7.76/build/pdf.worker.min.mjs"
    },
    @{
        Name = "jszip.min.js"
        Url  = "https://unpkg.com/jszip@3.10.1/dist/jszip.min.js"
    },
    @{
        Name = "heic2any.min.js"
        Url  = "https://unpkg.com/heic2any@0.0.4/dist/heic2any.min.js"
    },
    @{
        Name = "UTIF.js"
        Url  = "https://unpkg.com/utif@3.1.0/UTIF.js"
    },
    @{
        Name = "xlsx.full.min.js"
        Url  = "https://cdn.sheetjs.com/xlsx-0.20.3/package/dist/xlsx.full.min.js"
    }
)

foreach ($dl in $downloads) {
    $dest = Join-Path $libsDir $dl.Name
    if (Test-Path $dest) {
        Write-Host "[SKIP] $($dl.Name) already exists." -ForegroundColor Yellow
    } else {
        Write-Host "[DOWN] Downloading $($dl.Name)..." -ForegroundColor Cyan
        try {
            Invoke-WebRequest -Uri $dl.Url -OutFile $dest -UseBasicParsing
            Write-Host "[DONE] $($dl.Name)" -ForegroundColor Green
        } catch {
            Write-Host "[FAIL] $($dl.Name): $_" -ForegroundColor Red
        }
    }
}

Write-Host ""
Write-Host "All libraries downloaded to $libsDir" -ForegroundColor Green
