#!/usr/bin/env node

const http = require("http");
const { execSync, exec } = require("child_process");
const fs = require("fs");

const PORT = 9101;

// Auto-register any USB printer found via lpinfo as a raw CUPS queue
function autoRegisterUsbPrinter() {
  try {
    const output = execSync("lpinfo -v 2>/dev/null").toString();
    const usbLine = output.split("\n").find(
      (line) => /^direct\s+usb:\/\//.test(line)
    );
    if (!usbLine) return null;

    const uriMatch = usbLine.match(/\s(usb:\/\/\S+)/);
    if (!uriMatch) return null;

    const uri = uriMatch[1];
    // Derive queue name from URI path (e.g. "ITPP130" from usb://Printer/ITPP130?serial=...)
    const pathMatch = uri.match(/usb:\/\/[^/]+\/([^?]+)/);
    const queueName = pathMatch ? pathMatch[1] : "USBPrinter";

    execSync(
      `lpadmin -p ${queueName} -E -v "${uri}" -m raw 2>/dev/null`
    );
    console.log(`Auto-registered CUPS queue "${queueName}" -> ${uri}`);
    return queueName;
  } catch (e) {
    console.error("Failed to auto-register USB printer in CUPS:", e.message);
    return null;
  }
}

// Find any non-system serial device
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

// Find a CUPS printer (existing logic)
function findCupsPrinter() {
  try {
    const output = execSync("lpstat -p 2>/dev/null").toString();
    const match = output.match(/^printer\s+(\S+)/m);
    if (match) return match[1];
  } catch {}
  return null;
}

// Multi-tier printer detection
// Returns { type: 'cups', printer: string } | { type: 'serial', device: string } | null
function findPrinter() {
  // Tier 1: CUPS printer already configured
  const cupsName = findCupsPrinter();
  if (cupsName) return { type: "cups", printer: cupsName };

  // Tier 2: USB printer detected via lpinfo — auto-register in CUPS
  const queue = autoRegisterUsbPrinter();
  if (queue) return { type: "cups", printer: queue };

  // Tier 3: Serial device fallback
  const serialDev = findSerialDevice();
  if (serialDev) return { type: "serial", device: serialDev };

  return null;
}

// Resolve printer from env var or auto-detection
function resolvePrinter() {
  const envVal = process.env.ZPL_PRINTER;
  if (envVal) {
    if (envVal.startsWith("/dev/")) {
      return { type: "serial", device: envVal };
    }
    return { type: "cups", printer: envVal };
  }
  return findPrinter();
}

const PRINTER_INFO = resolvePrinter();

if (!PRINTER_INFO) {
  console.error(
    [
      "No USB printer detected. Options:",
      "  1. Connect a thermal printer via USB",
      "  2. Set up a raw CUPS queue: lpadmin -p PrinterName -E -v <uri> -m raw",
      "  3. Set ZPL_PRINTER env var to a CUPS queue name or /dev/ serial path",
      "  4. Run: lpinfo -v   to list available printer URIs",
    ].join("\n")
  );
  process.exit(1);
}

const PRINTER_LABEL =
  PRINTER_INFO.type === "cups"
    ? `${PRINTER_INFO.printer} (CUPS)`
    : `${PRINTER_INFO.device} (serial)`;

console.log(`Using printer: ${PRINTER_LABEL}`);

const HTML = `<!DOCTYPE html>
<html><head><title>ZPL Print Server</title>
<style>
  body { font-family: -apple-system, sans-serif; max-width: 700px; margin: 40px auto; padding: 0 20px; }
  textarea { width: 100%; height: 300px; font-family: monospace; font-size: 13px; }
  button { margin-top: 10px; padding: 10px 24px; font-size: 16px; cursor: pointer; }
  .status { padding: 10px; margin: 10px 0; border-radius: 6px; }
  .ok { background: #d4edda; color: #155724; }
  .err { background: #f8d7da; color: #721c24; }
</style></head>
<body>
  <h1>ZPL Print Server</h1>
  <p>Printer: <strong>${PRINTER_LABEL}</strong></p>
  <textarea id="zpl" placeholder="Paste ZPL here..."></textarea><br>
  <button onclick="printZpl()">Print</button>
  <div id="result"></div>
  <script>
    async function printZpl() {
      const zpl = document.getElementById('zpl').value;
      const el = document.getElementById('result');
      if (!zpl.trim()) { el.className = 'status err'; el.textContent = 'ZPL is empty.'; return; }
      try {
        const r = await fetch('/print', { method: 'POST', headers: {'Content-Type':'text/plain'}, body: zpl });
        const text = await r.text();
        el.className = 'status ' + (r.ok ? 'ok' : 'err');
        el.textContent = text;
      } catch(e) {
        el.className = 'status err';
        el.textContent = 'Error: ' + e.message;
      }
    }
  </script>
</body></html>`;

// Print via CUPS (lp command)
function printViaCups(zpl, printer, res) {
  const tmpFile = `/tmp/zpl-${Date.now()}.zpl`;
  fs.writeFileSync(tmpFile, zpl);

  exec(`lp -d "${printer}" -o raw "${tmpFile}"`, (err, stdout, stderr) => {
    try { fs.unlinkSync(tmpFile); } catch {}
    if (err) {
      console.error("Print error:", stderr || err.message);
      res.writeHead(500, { "Content-Type": "text/plain" });
      return res.end(`Print error: ${stderr || err.message}`);
    }
    const msg = `Sent to ${printer}: ${stdout.trim()}`;
    console.log(msg);
    res.writeHead(200, { "Content-Type": "text/plain" });
    res.end(msg);
  });
}

// Print via serial device (direct write)
function printViaSerial(zpl, device, res) {
  try {
    fs.writeFileSync(device, zpl);
    const msg = `Sent to ${device} (serial)`;
    console.log(msg);
    res.writeHead(200, { "Content-Type": "text/plain" });
    res.end(msg);
  } catch (e) {
    console.error("Serial print error:", e.message);
    res.writeHead(500, { "Content-Type": "text/plain" });
    res.end(`Serial print error: ${e.message}`);
  }
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
    const chunks = [];
    req.on("data", (chunk) => chunks.push(chunk));
    req.on("end", () => {
      const zpl = Buffer.concat(chunks).toString();
      if (!zpl.trim()) {
        res.writeHead(400, { "Content-Type": "text/plain" });
        return res.end("Error: empty ZPL data");
      }

      if (PRINTER_INFO.type === "serial") {
        printViaSerial(zpl, PRINTER_INFO.device, res);
      } else {
        printViaCups(zpl, PRINTER_INFO.printer, res);
      }
    });
    return;
  }

  res.writeHead(404, { "Content-Type": "text/plain" });
  res.end("Not found");
});

server.listen(PORT, "0.0.0.0", () => {
  console.log(`ZPL Print Server running at http://0.0.0.0:${PORT}`);
  console.log(`Open http://<mac-mini-ip>:${PORT} in your browser to print`);
});
