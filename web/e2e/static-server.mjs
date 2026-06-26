// Minimal static file server for the repo root, used by the browser e2e tests
// so the app (web/) and the generated index (data/index/browser/) are served
// from the same origin. Not used in production.
import http from "node:http";
import fs from "node:fs";
import path from "node:path";

const ROOT = path.resolve(process.argv[2] || process.cwd());
const PORT = Number(process.argv[3] || 8099);

const MIME = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".mjs": "text/javascript; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".wasm": "application/wasm",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".map": "application/json",
};

export function startServer(root = ROOT, port = PORT) {
  const server = http.createServer((req, res) => {
    try {
      const url = decodeURIComponent(req.url.split("?")[0]);
      let filePath = path.join(root, url);
      if (url.endsWith("/")) filePath = path.join(filePath, "index.html");
      if (!filePath.startsWith(root)) {
        res.writeHead(403);
        res.end("forbidden");
        return;
      }
      fs.readFile(filePath, (err, data) => {
        if (err) {
          res.writeHead(404);
          res.end("not found: " + url);
          return;
        }
        const ext = path.extname(filePath).toLowerCase();
        res.writeHead(200, {
          "content-type": MIME[ext] || "application/octet-stream",
          "access-control-allow-origin": "*",
        });
        res.end(data);
      });
    } catch (e) {
      res.writeHead(500);
      res.end(String(e));
    }
  });
  return new Promise((resolve) => server.listen(port, () => resolve({ server, port })));
}

// Run directly: `node web/e2e/static-server.mjs [root] [port]`
if (import.meta.url === `file://${process.argv[1].replace(/\\/g, "/")}`) {
  startServer().then(({ port }) => console.log(`serving ${ROOT} at http://localhost:${port}`));
}
