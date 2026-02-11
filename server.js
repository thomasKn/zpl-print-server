#!/usr/bin/env node

const http = require("http");
const { exec, execSync } = require("child_process");
const fs = require("fs");
const os = require("os");
const path = require("path");

const PORT = 9101;
const MAX_UPLOAD_BYTES = 20 * 1024 * 1024; // 20 MB
const ALLOWED_EXTENSIONS = [".png", ".jpg", ".jpeg", ".pdf"];

// Find a serial device for the thermal printer
function findPrinterDevice() {
  const SYSTEM_DEVICES = ["Bluetooth", "debug-console", "wlan"];
  try {
    const files = fs.readdirSync("/dev").filter((f) => {
      if (!f.startsWith("cu.")) return false;
      return !SYSTEM_DEVICES.some((sys) => f.includes(sys));
    });
    if (files.length > 0) return `/dev/${files[0]}`;
  } catch {}
  return null;
}

// Resolve printer device from env var or auto-detection
function resolvePrinter() {
  const envVal = process.env.LABEL_PRINTER;
  if (envVal) return envVal;
  return findPrinterDevice();
}

// Write payload to the device via child process (fire-and-forget, never blocks event loop)
function sendToDevice(devicePath, payload) {
  const tmpFile = path.join(os.tmpdir(), `tspl-${Date.now()}.bin`);
  fs.writeFileSync(tmpFile, payload);
  const cmd = `stty -f "${devicePath}" 9600 cs8 -cstopb -parenb && cat "${tmpFile}" > "${devicePath}"`;
  const child = exec(cmd, { timeout: 30000 }, (err) => {
    try { fs.unlinkSync(tmpFile); } catch {}
    if (err) console.error("[DEVICE] Error:", err.message);
    else console.log("[DEVICE] Write complete");
  });
  child.unref();
}

const PRINTER_DEVICE = resolvePrinter();

if (!PRINTER_DEVICE) {
  console.error(
    [
      "No thermal printer detected. Options:",
      "  1. Connect a thermal printer via USB (appears as /dev/cu.ITPP*)",
      "  2. Set LABEL_PRINTER env var to a device path, e.g.:",
      "     LABEL_PRINTER=/dev/cu.ITPP130B-D9C3 node server.js",
    ].join("\n")
  );
  process.exit(1);
}

// Force exit on Ctrl+C even if child processes are stuck
process.on("SIGINT", () => { console.log("\nShutting down..."); process.exit(0); });
process.on("SIGTERM", () => { process.exit(0); });

console.log(`Using printer: ${PRINTER_DEVICE} (direct serial)`);

const HTML = `<!DOCTYPE html>
<html><head><title>Label Print Server</title>
<style>
  body { font-family: -apple-system, sans-serif; max-width: 700px; margin: 40px auto; padding: 0 20px; }
  .drop-zone {
    border: 2px dashed #ccc; border-radius: 12px; padding: 40px 20px;
    text-align: center; cursor: pointer; transition: border-color 0.2s, background 0.2s;
    margin-bottom: 16px;
  }
  .drop-zone.dragover { border-color: #007aff; background: #f0f7ff; }
  .drop-zone p { margin: 0; color: #666; font-size: 15px; }
  .drop-zone input { display: none; }
  .preview { margin: 16px 0; text-align: center; }
  .preview img { max-width: 100%; max-height: 300px; border: 1px solid #ddd; border-radius: 6px; }
  .file-info { font-size: 13px; color: #555; margin: 8px 0; }
  button { padding: 10px 24px; font-size: 16px; cursor: pointer; }
  button:disabled { opacity: 0.5; cursor: not-allowed; }
  .status { padding: 10px; margin: 10px 0; border-radius: 6px; }
  .ok { background: #d4edda; color: #155724; }
  .err { background: #f8d7da; color: #721c24; }
</style></head>
<body>
  <h1>Label Print Server</h1>
  <p>Printer: <strong>${PRINTER_DEVICE}</strong></p>

  <div class="drop-zone" id="dropZone">
    <p>Drag & drop an image or PDF here, or click to browse</p>
    <input type="file" id="fileInput" accept=".png,.jpg,.jpeg,.pdf">
  </div>

  <div class="file-info" id="fileInfo"></div>
  <div class="preview" id="preview"></div>

  <button id="printBtn" onclick="printFile()" disabled>Print</button>
  <div id="result"></div>

  <script>
    const dropZone = document.getElementById('dropZone');
    const fileInput = document.getElementById('fileInput');
    const fileInfo = document.getElementById('fileInfo');
    const previewEl = document.getElementById('preview');
    const printBtn = document.getElementById('printBtn');
    let selectedFile = null;

    dropZone.addEventListener('click', () => fileInput.click());
    dropZone.addEventListener('dragover', (e) => { e.preventDefault(); dropZone.classList.add('dragover'); });
    dropZone.addEventListener('dragleave', () => dropZone.classList.remove('dragover'));
    dropZone.addEventListener('drop', (e) => {
      e.preventDefault();
      dropZone.classList.remove('dragover');
      if (e.dataTransfer.files.length) handleFile(e.dataTransfer.files[0]);
    });
    fileInput.addEventListener('change', () => { if (fileInput.files.length) handleFile(fileInput.files[0]); });

    function handleFile(file) {
      const ext = file.name.split('.').pop().toLowerCase();
      if (!['png','jpg','jpeg','pdf'].includes(ext)) {
        showResult('Unsupported file type. Use PNG, JPEG, or PDF.', false);
        return;
      }
      selectedFile = file;
      const sizeKB = (file.size / 1024).toFixed(1);
      fileInfo.textContent = file.name + ' (' + sizeKB + ' KB)';
      previewEl.innerHTML = '';
      if (file.type.startsWith('image/')) {
        const img = document.createElement('img');
        img.src = URL.createObjectURL(file);
        previewEl.appendChild(img);
      }
      printBtn.disabled = false;
      document.getElementById('result').textContent = '';
    }

    async function printFile() {
      if (!selectedFile) return;
      const el = document.getElementById('result');
      printBtn.disabled = true;
      printBtn.textContent = 'Printing...';
      try {
        const form = new FormData();
        form.append('file', selectedFile);
        const r = await fetch('/print', { method: 'POST', body: form });
        const text = await r.text();
        showResult(text, r.ok);
      } catch(e) {
        showResult('Error: ' + e.message, false);
      }
      printBtn.disabled = false;
      printBtn.textContent = 'Print';
    }

    function showResult(msg, ok) {
      const el = document.getElementById('result');
      el.className = 'status ' + (ok ? 'ok' : 'err');
      el.textContent = msg;
    }
  </script>
</body></html>`;

// Parse a single file from a multipart/form-data request body
function parseMultipart(buffer, contentType) {
  const boundaryMatch = contentType.match(/boundary=(.+)/);
  if (!boundaryMatch) return null;

  const boundary = boundaryMatch[1].replace(/^["']|["']$/g, "");
  const boundaryBuf = Buffer.from(`--${boundary}`);

  // Find first boundary
  const start = buffer.indexOf(boundaryBuf);
  if (start === -1) return null;

  // Find second boundary (end of first part)
  const partStart = start + boundaryBuf.length + 2; // skip boundary + \r\n
  const end = buffer.indexOf(boundaryBuf, partStart);
  if (end === -1) return null;

  const part = buffer.subarray(partStart, end - 2); // -2 for trailing \r\n before boundary

  // Split headers from body at \r\n\r\n
  const headerEnd = part.indexOf("\r\n\r\n");
  if (headerEnd === -1) return null;

  const headers = part.subarray(0, headerEnd).toString();
  const data = part.subarray(headerEnd + 4);

  // Extract filename
  const filenameMatch = headers.match(
    /filename="([^"]+)"|filename=([^\s;]+)/i
  );
  const filename = filenameMatch
    ? filenameMatch[1] || filenameMatch[2]
    : "upload";

  // Extract content type
  const ctMatch = headers.match(/Content-Type:\s*(.+)/i);
  const fileContentType = ctMatch ? ctMatch[1].trim() : "application/octet-stream";

  return { filename, contentType: fileContentType, data };
}

// --- Image-to-TSPL conversion pipeline ---

const TSPL_DPI = 203;
const MAX_PRINT_WIDTH_DOTS = 832; // 4-inch print head at 203 DPI

// Convert image to BMP using macOS built-in sips
function convertToBmp(inputPath, bmpPath, maxWidth = MAX_PRINT_WIDTH_DOTS) {
  execSync(
    `sips -s format bmp --resampleWidth ${maxWidth} "${inputPath}" --out "${bmpPath}" 2>/dev/null`
  );
}

// Parse a BMP file buffer into { width, height, pixels } with top-down RGB order
function parseBmp(buffer) {
  const dataOffset = buffer.readUInt32LE(10);
  const width = buffer.readInt32LE(18);
  const height = buffer.readInt32LE(22);
  const bpp = buffer.readUInt16LE(28);

  if (bpp !== 24 && bpp !== 32) {
    throw new Error(`Unsupported BMP bit depth: ${bpp}bpp (need 24 or 32)`);
  }

  const bytesPerPixel = bpp / 8;
  const absHeight = Math.abs(height);
  // BMP rows are padded to 4-byte boundaries
  const rowSize = Math.ceil((width * bytesPerPixel) / 4) * 4;
  const topDown = height < 0;

  const pixels = Buffer.alloc(width * absHeight * 3);

  for (let y = 0; y < absHeight; y++) {
    // BMP stores rows bottom-up by default
    const srcRow = topDown ? y : absHeight - 1 - y;
    const srcOffset = dataOffset + srcRow * rowSize;
    for (let x = 0; x < width; x++) {
      const srcIdx = srcOffset + x * bytesPerPixel;
      const dstIdx = (y * width + x) * 3;
      // BMP stores BGR
      pixels[dstIdx] = buffer[srcIdx + 2];     // R
      pixels[dstIdx + 1] = buffer[srcIdx + 1]; // G
      pixels[dstIdx + 2] = buffer[srcIdx];     // B
    }
  }

  return { width, height: absHeight, pixels };
}

// Convert RGB pixels to 1-bit monochrome bitmap (packed, MSB first)
// Black = bit set (1), White = bit clear (0)
function toMonochromeBitmap(pixels, width, height) {
  const widthBytes = Math.ceil(width / 8);
  const bitmap = Buffer.alloc(widthBytes * height);

  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const idx = (y * width + x) * 3;
      const gray = (pixels[idx] + pixels[idx + 1] + pixels[idx + 2]) / 3;
      if (gray < 128) {
        // Black pixel — set bit (MSB first)
        const byteIdx = y * widthBytes + Math.floor(x / 8);
        bitmap[byteIdx] |= 0x80 >> (x % 8);
      }
    }
  }

  return bitmap;
}

// Build a complete TSPL payload with BITMAP command
function buildTsplPayload(bitmap, widthBytes, height, widthDots) {
  const widthMm = Math.round((widthDots / TSPL_DPI) * 25.4);
  const heightMm = Math.round((height / TSPL_DPI) * 25.4);

  const header =
    `SIZE ${widthMm} mm, ${heightMm} mm\r\n` +
    `GAP 3 mm, 0\r\n` +
    `CLS\r\n` +
    `BITMAP 0,0,${widthBytes},${height},0,`;

  const footer = `\r\nPRINT 1\r\n`;

  const headerBuf = Buffer.from(header, "ascii");
  const footerBuf = Buffer.from(footer, "ascii");

  return Buffer.concat([headerBuf, bitmap, footerBuf]);
}

// Print an image/PDF file via TSPL direct to serial device
function printImage(fileBuffer, filename, devicePath, res) {
  const stamp = Date.now();
  const ext = path.extname(filename).toLowerCase();
  const tmpInput = path.join(os.tmpdir(), `label-${stamp}${ext}`);
  const tmpBmp = path.join(os.tmpdir(), `label-${stamp}.bmp`);

  const cleanup = () => {
    for (const f of [tmpInput, tmpBmp]) {
      try { fs.unlinkSync(f); } catch {}
    }
  };

  try {
    // 1. Save uploaded file
    console.log("[1] Saving uploaded file...");
    fs.writeFileSync(tmpInput, fileBuffer);

    // 2. Convert to BMP via sips
    console.log("[2] Converting to BMP via sips...");
    convertToBmp(tmpInput, tmpBmp);

    // 3. Parse BMP → monochrome bitmap → TSPL payload
    console.log("[3] Building TSPL payload...");
    const bmpBuffer = fs.readFileSync(tmpBmp);
    const { width, height, pixels } = parseBmp(bmpBuffer);
    const bitmap = toMonochromeBitmap(pixels, width, height);
    const widthBytes = Math.ceil(width / 8);
    const payload = buildTsplPayload(bitmap, widthBytes, height, width);

    // 4. Send directly to device (async — doesn't block event loop)
    console.log("[4] Sending to device...");
    sendToDevice(devicePath, payload);
    console.log("[5] Cleaning up...");
    cleanup();

    const msg = `Sent ${filename} to ${devicePath} (TSPL ${width}x${height})`;
    console.log("[6] Sending HTTP response");
    res.writeHead(200, { "Content-Type": "text/plain" });
    res.end(msg);
  } catch (e) {
    cleanup();
    console.error("TSPL conversion error:", e.message);
    res.writeHead(500, { "Content-Type": "text/plain" });
    res.end(`Error converting image: ${e.message}`);
  }
}

const server = http.createServer((req, res) => {
  console.log(`[REQ] ${req.method} ${req.url}`);

  // CORS headers
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "POST, GET, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type");

  if (req.method === "OPTIONS") {
    res.writeHead(204);
    return res.end();
  }

  // Web UI
  if (req.method === "GET" && req.url === "/") {
    res.writeHead(200, { "Content-Type": "text/html" });
    return res.end(HTML);
  }

  // Kill endpoint — shut down the server
  if (req.method === "GET" && req.url === "/kill") {
    res.writeHead(200, { "Content-Type": "text/plain" });
    res.end("Server shutting down...");
    console.log("Shutdown requested via /kill");
    process.exit(0);
  }

  // Test-print endpoint — send a minimal TSPL text command
  if (req.method === "GET" && req.url === "/test-print") {
    const tspl =
      `SIZE 100 mm, 30 mm\r\n` +
      `GAP 3 mm, 0\r\n` +
      `CLS\r\n` +
      `TEXT 50,10,"4",0,1,1,"TSPL TEST OK"\r\n` +
      `PRINT 1\r\n`;

    try {
      sendToDevice(PRINTER_DEVICE, Buffer.from(tspl, "ascii"));
      const msg = `Test print sent to ${PRINTER_DEVICE}`;
      console.log(msg);
      res.writeHead(200, { "Content-Type": "text/plain" });
      res.end(msg);
    } catch (e) {
      console.error("Test print error:", e.message);
      res.writeHead(500, { "Content-Type": "text/plain" });
      res.end(`Test print error: ${e.message}`);
    }
    return;
  }

  // Print endpoint
  if (req.method === "POST" && req.url === "/print") {
    const contentType = req.headers["content-type"] || "";
    if (!contentType.includes("multipart/form-data")) {
      res.writeHead(400, { "Content-Type": "text/plain" });
      return res.end("Error: expected multipart/form-data");
    }

    console.log("[UPLOAD] Receiving file data...");
    let size = 0;
    const chunks = [];
    req.on("data", (chunk) => {
      size += chunk.length;
      if (size > MAX_UPLOAD_BYTES) {
        res.writeHead(413, { "Content-Type": "text/plain" });
        res.end("Error: file too large (max 20 MB)");
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });
    req.on("end", () => {
      console.log(`[UPLOAD] Received ${size} bytes`);
      if (res.writableEnded) return;

      const body = Buffer.concat(chunks);
      const parsed = parseMultipart(body, contentType);
      if (!parsed || !parsed.data.length) {
        console.log("[UPLOAD] Parse failed — no file found");
        res.writeHead(400, { "Content-Type": "text/plain" });
        return res.end("Error: no file uploaded");
      }

      console.log(`[UPLOAD] Parsed file: ${parsed.filename} (${parsed.data.length} bytes)`);
      const ext = path.extname(parsed.filename).toLowerCase();
      if (!ALLOWED_EXTENSIONS.includes(ext)) {
        res.writeHead(400, { "Content-Type": "text/plain" });
        return res.end(
          `Error: unsupported file type "${ext}". Use PNG, JPEG, or PDF.`
        );
      }

      printImage(parsed.data, parsed.filename, PRINTER_DEVICE, res);
    });
    return;
  }

  res.writeHead(404, { "Content-Type": "text/plain" });
  res.end("Not found");
});

server.listen(PORT, "0.0.0.0", () => {
  console.log(`Label Print Server running at http://0.0.0.0:${PORT}`);
  console.log(`Open http://<mac-mini-ip>:${PORT} in your browser to print`);
});
