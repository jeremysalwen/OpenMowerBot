// End-to-end browser test of the SHIPPING app against a real model.
//
// Serves the repo over http, opens web/ in Edge (real WebGPU for WebLLM),
// selects a model, asks a search-only question, and verifies the agent
// actually called search_messages and produced a grounded, cited answer.
// It reads window.__ombLastRun (set by app.js) rather than scraping the DOM.
//
//   node web/e2e/run-model.mjs "webllm:Llama-3.2-1B-Instruct-q4f16_1-MLC"
//   node web/e2e/run-model.mjs "transformers:onnx-community/Qwen3-0.6B-ONNX"
//   node web/e2e/run-model.mjs "api:local-model"  # E2E_API_BASE_URL=http://127.0.0.1:8081/v1
//
// Model weights download from CDN on first use (can be minutes). A persistent
// browser profile under the OS temp dir caches them across runs.
import { chromium } from "playwright-core";
import path from "node:path";
import os from "node:os";
import { fileURLToPath } from "node:url";
import { startServer } from "./static-server.mjs";

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");
const MODEL = process.argv[2] || "webllm:Llama-3.2-1B-Instruct-q4f16_1-MLC";
const DEFAULT_QUESTION = "What RTK GPS module do people recommend for OpenMower?";
const QUESTION = process.argv[3] || DEFAULT_QUESTION;
const expectedAnswerPattern = process.env.E2E_EXPECT
  || (QUESTION === DEFAULT_QUESTION ? "F9P|UM982|simpleRTK2B|Ardusimple" : "");
const PORT = 8099;
const TIMEOUT_MS = Number(process.env.E2E_TIMEOUT_MS || 900000); // 15 min default
const channel = process.env.E2E_CHANNEL || "msedge";
const apiBaseUrl = process.env.E2E_API_BASE_URL || "http://127.0.0.1:8081/v1";
const apiKey = process.env.E2E_API_KEY || "";
// Profile dir holds WebLLM's per-origin weight cache. Overridable so a large
// model can use its own clean profile (Cache Storage has a per-origin quota;
// stacking several multi-GB models in one profile can exceed it and surface as
// a "Cache.add() encountered a network error").
const profileDir = process.env.E2E_PROFILE
  ? path.resolve(process.env.E2E_PROFILE)
  : path.join(os.tmpdir(), "omb-e2e-profile");

const FALLBACK = "could not produce a grounded answer";

function fail(msg) {
  console.error(`\n❌ FAIL: ${msg}`);
  process.exitCode = 1;
}

const { server } = await startServer(REPO_ROOT, PORT);
console.log(`Serving ${REPO_ROOT} at http://localhost:${PORT}`);

const context = await chromium.launchPersistentContext(profileDir, {
  channel,
  headless: false,
  // force-high-performance-gpu: on laptops the default WebGPU adapter is the
  // weak integrated GPU, which hangs (DXGI_ERROR_DEVICE_HUNG) running a model;
  // route to the discrete GPU instead.
  args: [
    "--enable-unsafe-webgpu",
    "--enable-features=Vulkan,WebGPU",
    "--ignore-gpu-blocklist",
    "--force-high-performance-gpu",
    "--disable-gpu-watchdog",
  ],
  viewport: { width: 1200, height: 800 },
});

const page = context.pages()[0] || (await context.newPage());
page.on("console", (m) => {
  const t = m.text();
  if (t.includes("404")) return; // favicon noise
  if (m.type() === "error" || /error|fail|exception|webgpu|shader/i.test(t)) console.log("  [console]", t.slice(0, 300));
});
page.on("pageerror", (e) => console.log("  [pageerror]", String(e).slice(0, 200)));

let lastStatus = "";
try {
  await page.goto(`http://localhost:${PORT}/web/`, { waitUntil: "domcontentloaded", timeout: 30000 });

  // Confirm WebGPU + shader-f16 are present in this context (WebLLM needs it).
  const gpu = await page.evaluate(async () => {
    if (!navigator.gpu) return { gpu: false };
    const a = await navigator.gpu.requestAdapter();
    return { gpu: true, adapter: !!a, shaderF16: !!a && a.features.has("shader-f16") };
  });
  console.log("WebGPU:", JSON.stringify(gpu));
  if (MODEL.startsWith("webllm:") && !gpu.shaderF16) {
    fail("WebGPU/shader-f16 not available; WebLLM q4f16 models cannot run here.");
    throw new Error("no webgpu");
  }

  await page.waitForFunction(() => /Ready|index/i.test(document.querySelector("#summary")?.textContent || ""), { timeout: 30000 });
  const apiModel = MODEL.startsWith("api:") ? MODEL.slice("api:".length) : "";
  await page.selectOption("#answer-mode", apiModel ? "api" : MODEL);
  if (apiModel) {
    await page.fill("#api-base-url", apiBaseUrl);
    await page.fill("#api-model", apiModel);
    await page.fill("#api-key", apiKey);
  }
  console.log(`Model: ${MODEL}`);
  if (apiModel) console.log(`API: ${apiBaseUrl}`);
  console.log(`Question: ${QUESTION}`);

  await page.fill("#query", QUESTION);
  await page.click("#send");
  console.log("Submitted. Waiting for the agent (downloading weights on first run)...");

  // Manual Node-side poll: page.waitForFunction polls via requestAnimationFrame,
  // which is starved while WebGPU compiles/runs the model, so it falsely times
  // out. A plain page.evaluate works fine during model load (it reports the
  // download %), so we poll that on our own deadline.
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  const deadline = Date.now() + TIMEOUT_MS;
  let run = null;
  while (Date.now() < deadline) {
    const snap = await page.evaluate(() => ({
      run: window.__ombLastRun || null,
      summary: document.querySelector("#summary")?.textContent || "",
      answerText: document.querySelector(".message.assistant .answer")?.textContent || "",
      status: document.querySelector(".turn-status")?.textContent || "",
    }));
    if (snap.summary && snap.summary !== lastStatus) { lastStatus = snap.summary; console.log("  …", snap.summary.slice(0, 100)); }
    if (snap.run?.done) { run = snap.run; break; }
    // App caught an error: it renders an answer/status but never sets done.
    if (/^Error:|went wrong/i.test(snap.status) || /went wrong/i.test(snap.answerText)) {
      console.log("\n  [app error] status:", snap.status, "| answer:", snap.answerText.slice(0, 200));
      break;
    }
    await sleep(3000);
  }
  if (!run) {
    const dump = await page.evaluate(() => ({
      run: window.__ombLastRun || null,
      summary: document.querySelector("#summary")?.textContent || "",
      answer: document.querySelector(".message.assistant .answer")?.textContent || "",
    }));
    console.log("\n  [timeout/no-done] state:", JSON.stringify(dump).slice(0, 500));
    fail("agent did not finish (no __ombLastRun.done)");
    throw new Error("no done");
  }
  console.log("\n=== RESULT ===");
  console.log("engine :", run.engine);
  console.log("tools  :", JSON.stringify(run.toolCalls));
  console.log("sources:", run.sources);
  if (run.observations?.length) {
    console.log("\n--- observation fed to model (first 600 chars) ---");
    console.log(run.observations[0].slice(0, 600));
  }
  if (run.modelOutputs?.length) {
    console.log("\n--- raw model outputs per step ---");
    for (const o of run.modelOutputs) console.log(`[step ${o.step}] ${JSON.stringify(o.text.slice(0, 400))}`);
  }
  console.log("\nanswer :", run.answer);

  const searched = run.toolCalls.some((c) => c.name === "search_messages");
  const grounded = run.answer && run.answer.length > 20 && !run.answer.includes(FALLBACK);
  const expectedAnswer = !expectedAnswerPattern || new RegExp(expectedAnswerPattern, "i").test(run.answer || "");

  if (!searched) fail("model did not call search_messages");
  if (run.sources < 1) fail("no sources were retrieved");
  if (!grounded) fail("answer is empty or the non-grounded fallback");
  if (!expectedAnswer) fail(`answer did not contain expected evidence (${expectedAnswerPattern})`);
  if (searched && run.sources >= 1 && grounded && expectedAnswer) console.log("\n✅ PASS: native tool call → real sources → grounded answer");
} catch (e) {
  if (/no webgpu|no done/.test(String(e))) {/* already reported */}
  else fail(`exception: ${String(e).split("\n")[0]}`);
} finally {
  await context.close();
  server.close();
}
