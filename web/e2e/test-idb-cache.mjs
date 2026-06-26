// Verify the fix for the HF Xet-redirect / Cache-API breakage: load a WebLLM
// model with useIndexedDBCache:true and confirm it downloads + answers, where
// the default Cache-API path fails with "Cache.add() encountered a network
// error". Uses a CLEAN profile so the download is genuinely fresh.
//
//   node web/e2e/test-idb-cache.mjs [model]
import { chromium } from "playwright-core";
import path from "node:path";
import os from "node:os";
import { fileURLToPath } from "node:url";
import { startServer } from "./static-server.mjs";

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");
const MODEL = process.argv[2] || "Llama-3.2-1B-Instruct-q4f16_1-MLC";
const PORT = 8099;
const channel = process.env.E2E_CHANNEL || "msedge";
const profileDir = path.join(os.tmpdir(), "omb-idb-test"); // clean profile
const TIMEOUT_MS = Number(process.env.E2E_TIMEOUT_MS || 900000);

const { server } = await startServer(REPO_ROOT, PORT);
const context = await chromium.launchPersistentContext(profileDir, {
  channel,
  headless: false,
  args: ["--enable-unsafe-webgpu", "--enable-features=Vulkan,WebGPU", "--ignore-gpu-blocklist", "--force-high-performance-gpu"],
});
const page = context.pages()[0] || (await context.newPage());
page.on("pageerror", (e) => console.log("  [pageerror]", String(e).slice(0, 200)));
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

try {
  await page.goto(`http://localhost:${PORT}/web/e2e/harness.html`, { waitUntil: "domcontentloaded" });
  await page.waitForFunction(() => window.__ready === true, { timeout: 30000 });

  console.log(`Loading ${MODEL} with useIndexedDBCache:true (fresh profile)…`);
  await page.evaluate((m) => { window.__useIDB = true; window.__load(m); }, MODEL);

  const deadline = Date.now() + TIMEOUT_MS;
  let lastP = "";
  while (Date.now() < deadline) {
    const s = await page.evaluate(() => ({ loaded: window.__loadedModel, err: window.__loadError, p: window.__progress }));
    if (s.err) throw new Error("load error: " + s.err);
    if (s.p && s.p !== lastP) { lastP = s.p; process.stdout.write(`\r  ${s.p}`.padEnd(90)); }
    if (s.loaded === MODEL) break;
    await sleep(2000);
  }
  console.log(`\nLoaded. Running a quick completion…`);

  const out = await page.evaluate((req) => window.__chat(req), {
    messages: [
      { role: "system", content: "Answer in one short sentence." },
      { role: "user", content: "What is an RTK GPS module?" },
    ],
    max_tokens: 128,
  });
  console.log("\n=== RESULT ===");
  console.log("answer:", (out.content || "").trim());
  if ((out.content || "").trim().length > 10) console.log("\n✅ PASS: IndexedDB cache downloaded the model and it generated text.");
  else { console.log("\n❌ FAIL: empty completion"); process.exitCode = 1; }
} catch (e) {
  console.error("\n❌ FAIL:", String(e).split("\n")[0]);
  process.exitCode = 1;
} finally {
  await context.close();
  server.close();
}
