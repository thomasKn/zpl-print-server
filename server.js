#!/usr/bin/env node

const http = require("http");
const { execSync, exec } = require("child_process");
const fs = require("fs");

const PORT = 9101;

// Auto-detect the printer name (looks for printers in CUPS)
function findPrinter() {
  try {
    const output = execSync("lpstat -p 2>/dev/null").toString();
    const match = output.match(/^printer\s+(\S+)/m);
    if (match) return match[1];
  } catch {}
  return null;
}

const PRINTER = process.env.ZPL_PRINTER || findPrinter();

if (!PRINTER) {
  console.error(
    "No CUPS printer detected. Set up a raw printer in CUPS or set ZPL_PRINTER env var."
  );
  process.exit(1);
}

console.log(`Using printer: ${PRINTER}`);

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
  <p>Printer: <strong>${PRINTER}</strong></p>
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

      // Pipe ZPL via temp file to lp
      const tmpFile = `/tmp/zpl-${Date.now()}.zpl`;
      fs.writeFileSync(tmpFile, zpl);

      exec(`lp -d "${PRINTER}" -o raw "${tmpFile}"`, (err, stdout, stderr) => {
        try { fs.unlinkSync(tmpFile); } catch {}
        if (err) {
          console.error("Print error:", stderr || err.message);
          res.writeHead(500, { "Content-Type": "text/plain" });
          return res.end(`Print error: ${stderr || err.message}`);
        }
        const msg = `Sent to ${PRINTER}: ${stdout.trim()}`;
        console.log(msg);
        res.writeHead(200, { "Content-Type": "text/plain" });
        res.end(msg);
      });
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
