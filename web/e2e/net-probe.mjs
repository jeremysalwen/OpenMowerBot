// Diagnose why WebLLM's Cache.add() fails in automated Edge: open a real page on
// a secure-ish origin and try fetch() + caches.add() against a HF Xet shard URL,
// reporting the precise error instead of the generic ERR_FAILED.
import { chromium } from "playwright-core";
import path from "node:path";
import os from "node:os";
import { fileURLToPath } from "node:url";
import { startServer } from "./static-server.mjs";

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");
const PORT = 8099;
const channel = process.env.E2E_CHANNEL || "msedge";
const profileDir = path.join(os.tmpdir(), "omb-net-probe");
const SHARD = "https://huggingface.co/mlc-ai/Llama-3.2-3B-Instruct-q4f16_1-MLC/resolve/main/params_shard_0.bin";

const { server } = await startServer(REPO_ROOT, PORT);
const context = await chromium.launchPersistentContext(profileDir, {
  channel,
  headless: false,
  args: ["--enable-unsafe-webgpu", "--enable-features=Vulkan,WebGPU", "--ignore-gpu-blocklist", "--force-high-performance-gpu"],
});
const page = context.pages()[0] || (await context.newPage());
page.on("console", (m) => console.log("  [console]", m.text().slice(0, 200)));

try {
  await page.goto(`http://localhost:${PORT}/web/`, { waitUntil: "domcontentloaded", timeout: 30000 });
  const out = await page.evaluate(async (url) => {
    const r = { origin: location.origin };
    const cache = await caches.open("net-probe");

    // 1) Does fetch follow the redirect and report response.redirected/url?
    try {
      const resp = await fetch(url);
      r.fetch = { ok: resp.ok, status: resp.status, type: resp.type, redirected: resp.redirected, finalUrl: resp.url.slice(0, 60) };
      await resp.arrayBuffer();
    } catch (e) {
      r.fetch = { error: String(e) };
    }

    // 2) cache.add on the redirecting HF URL (what WebLLM does today).
    try {
      await cache.add(url);
      r.cacheAdd_redirect = { ok: true };
    } catch (e) {
      r.cacheAdd_redirect = { error: String(e) };
    }

    // 3) Manual fetch + cache.put on the redirecting HF URL.
    try {
      const resp = await fetch(url);
      await cache.put(url, resp);
      r.cachePut_redirect = { ok: true, redirected: resp.redirected };
    } catch (e) {
      r.cachePut_redirect = { error: String(e) };
    }

    // 4) Resolve the redirect ourselves, then cache.add the DIRECT Xet URL.
    try {
      const head = await fetch(url, { redirect: "manual" });
      r.manualRedirect = { status: head.status, type: head.type };
      const direct = head.headers.get("location") || head.url;
      r.directUrl = (direct || "").slice(0, 60);
      if (direct && /^https?:/.test(direct)) {
        await cache.add(direct);
        r.cacheAdd_direct = { ok: true };
      } else {
        r.cacheAdd_direct = { skipped: "no location (opaqueredirect)" };
      }
    } catch (e) {
      r.cacheAdd_direct = { error: String(e) };
    }

    // 5) WORKAROUND: fetch → arrayBuffer → fresh same-origin Response → put,
    //    then verify it reads back. This strips the redirect from the response.
    try {
      const resp = await fetch(url);
      const buf = await resp.arrayBuffer();
      const clean = new Response(buf, { status: 200, headers: { "Content-Type": "application/octet-stream" } });
      await cache.put(url, clean);
      const hit = await cache.match(url);
      const hitBuf = hit ? await hit.arrayBuffer() : null;
      r.cachePut_clean = { ok: true, bytes: buf.byteLength, readBack: hitBuf?.byteLength ?? null };
    } catch (e) {
      r.cachePut_clean = { error: String(e) };
    }

    // 6) Is the DEFAULT 1B model's download path also redirect-broken?
    try {
      await cache.add("https://huggingface.co/mlc-ai/Llama-3.2-1B-Instruct-q4f16_1-MLC/resolve/main/params_shard_0.bin");
      r.cacheAdd_1B = { ok: true };
    } catch (e) {
      r.cacheAdd_1B = { error: String(e) };
    }
    return r;
  }, SHARD);
  console.log("\n=== NET PROBE ===");
  console.log(JSON.stringify(out, null, 2));
} catch (e) {
  console.error("PROBE ERROR:", String(e).split("\n")[0]);
  process.exitCode = 1;
} finally {
  await context.close();
  server.close();
}
