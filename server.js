#!/usr/bin/env node

const http = require("http");
const { execSync, exec } = require("child_process");
const fs = require("fs");
const os = require("os");
const path = require("path");

const PORT = 9101;
const MAX_UPLOAD_BYTES = 20 * 1024 * 1024; // 20 MB
const ALLOWED_EXTENSIONS = [".png", ".jpg", ".jpeg", ".pdf"];

// Auto-register any USB printer found via lpinfo as an image-capable CUPS queue
function autoRegisterUsbPrinter() {
  try {
    const output = execSync("lpinfo -v 2>/dev/null").toString();
    const usbLine = output
      .split("\n")
      .find((line) => /^direct\s+usb:\/\//.test(line));
    if (!usbLine) return null;

    const uriMatch = usbLine.match(/\s(usb:\/\/\S+)/);
    if (!uriMatch) return null;

    const uri = uriMatch[1];
    // Derive queue name from URI path (e.g. "ITPP130" from usb://Printer/ITPP130?serial=...)
    const pathMatch = uri.match(/usb:\/\/[^/]+\/([^?]+)/);
    const queueName = pathMatch ? pathMatch[1] : "USBPrinter";

    // Use -m everywhere (IPP Everywhere / driverless) for image rasterization
    try {
      execSync(
        `lpadmin -p ${queueName} -E -v "${uri}" -m everywhere 2>/dev/null`
      );
      console.log(
        `Auto-registered CUPS queue "${queueName}" -> ${uri} (driverless driver)`
      );
      return queueName;
    } catch {
      // Fall back to generic PPD driver
      try {
        execSync(
          `lpadmin -p ${queueName} -E -v "${uri}" -m drv:///sample.drv/generic.ppd 2>/dev/null`
        );
        console.log(
          `Auto-registered CUPS queue "${queueName}" -> ${uri} (generic driver)`
        );
        return queueName;
      } catch (e) {
        console.error(
          "Failed to auto-register USB printer in CUPS:",
          e.message
        );
        return null;
      }
    }
  } catch (e) {
    console.error("Failed to auto-register USB printer in CUPS:", e.message);
    return null;
  }
}

// Find any non-system serial device (informational only)
function findSerialDevice() {
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

// Find a CUPS printer
function findCupsPrinter() {
  try {
    const output = execSync("lpstat -p 2>/dev/null").toString();
    const match = output.match(/^printer\s+(\S+)/m);
    if (match) return match[1];
  } catch {}
  return null;
}

// Printer detection — CUPS only (serial is informational)
function findPrinter() {
  // Tier 1: CUPS printer already configured
  const cupsName = findCupsPrinter();
  if (cupsName) return cupsName;

  // Tier 2: USB printer detected via lpinfo — auto-register in CUPS
  const queue = autoRegisterUsbPrinter();
  if (queue) return queue;

  // Informational: mention serial device if found
  const serialDev = findSerialDevice();
  if (serialDev) {
    console.log(
      `Serial device found at ${serialDev}, but CUPS is required for image printing.`
    );
  }

  return null;
}

// Resolve printer from env var or auto-detection
function resolvePrinter() {
  const envVal = process.env.LABEL_PRINTER;
  if (envVal) {
    if (envVal.startsWith("/dev/")) {
      console.error(
        "Error: LABEL_PRINTER points to a serial device. Only CUPS queue names are supported."
      );
      process.exit(1);
    }
    return envVal;
  }
  return findPrinter();
}

const PRINTER_NAME = resolvePrinter();

if (!PRINTER_NAME) {
  console.error(
    [
      "No USB printer detected. Options:",
      "  1. Connect a thermal printer via USB",
      "  2. Set up a CUPS queue: lpadmin -p PrinterName -E -v <uri> -m everywhere",
      "  3. Set LABEL_PRINTER env var to a CUPS queue name",
      "  4. Run: lpinfo -v   to list available printer URIs",
    ].join("\n")
  );
  process.exit(1);
}

console.log(`Using printer: ${PRINTER_NAME} (CUPS)`);

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
  <p>Printer: <strong>${PRINTER_NAME}</strong></p>

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

// Print an image/PDF file via CUPS
function printImage(fileBuffer, filename, printer, res) {
  const ext = path.extname(filename).toLowerCase();
  const tmpFile = path.join(os.tmpdir(), `label-${Date.now()}${ext}`);
  fs.writeFileSync(tmpFile, fileBuffer);

  exec(
    `lp -d "${printer}" -o fit-to-page "${tmpFile}"`,
    (err, stdout, stderr) => {
      try {
        fs.unlinkSync(tmpFile);
      } catch {}
      if (err) {
        console.error("Print error:", stderr || err.message);
        res.writeHead(500, { "Content-Type": "text/plain" });
        return res.end(`Print error: ${stderr || err.message}`);
      }
      const msg = `Sent ${filename} to ${printer}: ${stdout.trim()}`;
      console.log(msg);
      res.writeHead(200, { "Content-Type": "text/plain" });
      res.end(msg);
    }
  );
}

const server = http.createServer((req, res) => {
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

  // Print endpoint
  if (req.method === "POST" && req.url === "/print") {
    const contentType = req.headers["content-type"] || "";
    if (!contentType.includes("multipart/form-data")) {
      res.writeHead(400, { "Content-Type": "text/plain" });
      return res.end("Error: expected multipart/form-data");
    }

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
      if (res.writableEnded) return;

      const body = Buffer.concat(chunks);
      const parsed = parseMultipart(body, contentType);
      if (!parsed || !parsed.data.length) {
        res.writeHead(400, { "Content-Type": "text/plain" });
        return res.end("Error: no file uploaded");
      }

      const ext = path.extname(parsed.filename).toLowerCase();
      if (!ALLOWED_EXTENSIONS.includes(ext)) {
        res.writeHead(400, { "Content-Type": "text/plain" });
        return res.end(
          `Error: unsupported file type "${ext}". Use PNG, JPEG, or PDF.`
        );
      }

      printImage(parsed.data, parsed.filename, PRINTER_NAME, res);
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
