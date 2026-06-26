// Controlled prompt experiments against a real WebLLM model, to isolate whether
// the small models *cannot* synthesize an answer or whether our prompt /
// observation format is inducing them to copy the sources verbatim.
//
//   node web/e2e/experiment.mjs [webllm-model-id]
//
// It builds the REAL observation from the on-disk browser index (same retrieval
// code the app uses), then runs a matrix of prompt variants through the model
// and prints the raw output of each so we can compare.
import { chromium } from "playwright-core";
import fs from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import { fileURLToPath } from "node:url";
import { startServer } from "./static-server.mjs";
import { createStore } from "../index-store.js";
import { createTools, formatObservation, systemPrompt, toManualConversation, toolSchemas } from "../agent.js";

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");
const MODEL = process.argv[2] || "Llama-3.2-1B-Instruct-q4f16_1-MLC";
const QUESTION = "What RTK GPS module do people recommend for OpenMower?";
// Same port as run-model.mjs so WebLLM's per-origin weight cache is reused.
const PORT = 8099;
// Override to a profile that already has the model cached (e.g. omb-3b-idb).
const profileDir = process.env.E2E_PROFILE
  ? path.resolve(process.env.E2E_PROFILE)
  : path.join(os.tmpdir(), "omb-e2e-profile");

// --- Build the real observation from the on-disk index ----------------------
async function diskFetch(url) {
  const file = path.join(REPO_ROOT, url);
  return JSON.parse(await fs.readFile(file, "utf8"));
}
const store = createStore({ fetchJson: diskFetch, indexRoot: "data/index/browser/" });
await store.loadManifest();
const tools = createTools(store);
const schemas = toolSchemas(tools);
const result = await tools.search_messages.run({ query: QUESTION, limit: 10 });
const numbered = result.messages.map((message, i) => ({ n: i + 1, message }));
const observation = formatObservation(numbered, result);

const proseFrom = (res) => res.messages
  .map((message, i) => `Source ${i + 1} — ${message.a} in #${message.ch}: ${(message.text || "").replace(/\s+/g, " ").slice(0, 220)}`)
  .join("\n");

// A version of the sources that is NOT a "[n] ...:" list, to test whether the
// list-shaped observation is what the model copies.
const prose_sources = proseFrom(result);

// Better-retrieved sources (the query the model itself formed in run-model.mjs
// surfaces messages that actually name modules), to separate retrieval quality
// from synthesis faithfulness.
const goodResult = await tools.search_messages.run({ query: "RTK GPS module recommendation Ardusimple Bynav Unicore", limit: 10 });
const good_sources = proseFrom(goodResult);
console.log("GOOD-RETRIEVAL sources:\n" + good_sources.slice(0, 700) + "\n");

const GROUND = "Answer using ONLY facts stated in the sources. Name a specific module ONLY if a source names it. If the sources do not clearly recommend a module, say that they do not. Never use outside knowledge or invent product names, numbers, or specs. Cite sources as [1], [2].";

const assistantToolCall = {
  role: "assistant",
  content: "",
  tool_calls: [{ type: "function", function: { name: "search_messages", arguments: JSON.stringify({ query: QUESTION }) } }],
};

// --- Experiment matrix ------------------------------------------------------
const SYNTH = "Now answer the user's question in 2-4 sentences of your own prose. Do NOT copy, list, or restate the messages verbatim. Reference supporting messages inline as [1], [2].";

const experiments = [
  {
    id: "E1-app-pipeline",
    why: "Reproduce exactly what the app sends at the answer step (manual mode).",
    messages: () => toManualConversation(
      [{ role: "system", content: systemPrompt() }, { role: "user", content: QUESTION }, assistantToolCall, { role: "tool", content: observation }],
      schemas,
    ),
  },
  {
    id: "E2-app-plus-synthesize",
    why: "Same as E1 but add an explicit 'write prose, do not copy' instruction.",
    messages: () => [
      ...toManualConversation(
        [{ role: "system", content: systemPrompt() }, { role: "user", content: QUESTION }, assistantToolCall, { role: "tool", content: observation }],
        schemas,
      ),
      { role: "user", content: SYNTH },
    ],
  },
  {
    id: "E3-clean-list-observation",
    why: "Clean prompt + the list-shaped observation. Tests if the [n]-list format itself triggers copying.",
    messages: () => [
      { role: "system", content: "You answer questions about OpenMower from provided Discord messages. Write a concise prose answer and cite messages inline as [1], [2]. Do not list the messages." },
      { role: "user", content: `Question: ${QUESTION}\n\nMessages:\n${observation}` },
    ],
  },
  {
    id: "E4-clean-prose-sources",
    why: "Clean prompt + non-list 'Source n —' format. Tests if a non-list source format avoids copying.",
    messages: () => [
      { role: "system", content: "You answer questions about OpenMower from provided sources. Write a concise prose answer (2-4 sentences) and cite sources inline as [1], [2]. Do not restate the sources." },
      { role: "user", content: `Question: ${QUESTION}\n\nSources:\n${prose_sources}` },
    ],
  },
  {
    id: "E5-capability-no-sources",
    why: "Pure generation control: can this model write prose at all (no sources)?",
    messages: () => [
      { role: "system", content: "You are a helpful assistant. Answer briefly." },
      { role: "user", content: "In two sentences, what is an RTK GPS module and why would a robot lawn mower use one?" },
    ],
  },
  {
    id: "E6-oneshot-example",
    why: "Clean prompt + a one-shot example of the desired synthesis style.",
    messages: () => [
      { role: "system", content: "You answer questions from provided sources with a short prose answer citing [1], [2]. Do not list the sources." },
      { role: "user", content: "Question: What battery do people use?\n\nSources:\nSource 1 — bob in #power: I run a 7Ah LiFePO4 and it lasts all day.\nSource 2 — amy in #power: LiFePO4 is the way to go, very durable." },
      { role: "assistant", content: "People favor LiFePO4 batteries for their durability and all-day runtime [1][2]." },
      { role: "user", content: `Question: ${QUESTION}\n\nSources:\n${prose_sources}` },
    ],
  },
  {
    id: "E7-grounding-good-sources",
    why: "Strong anti-hallucination instruction + better-retrieved sources that DO name modules. Best case: can 1B ground?",
    messages: () => [
      { role: "system", content: GROUND },
      { role: "user", content: `Question: ${QUESTION}\n\nSources:\n${good_sources}` },
    ],
  },
  {
    id: "E8-grounding-weak-sources",
    why: "Strong grounding + the weak (troubleshooting) sources. Does it correctly say 'no clear recommendation' instead of inventing?",
    messages: () => [
      { role: "system", content: GROUND },
      { role: "user", content: `Question: ${QUESTION}\n\nSources:\n${prose_sources}` },
    ],
  },
];

// --- Drive the browser ------------------------------------------------------
const { server } = await startServer(REPO_ROOT, PORT);
const context = await chromium.launchPersistentContext(profileDir, {
  channel: process.env.E2E_CHANNEL || "msedge",
  headless: false,
  args: ["--enable-unsafe-webgpu", "--enable-features=Vulkan,WebGPU", "--ignore-gpu-blocklist", "--force-high-performance-gpu"],
});
const page = context.pages()[0] || (await context.newPage());
page.on("pageerror", (e) => console.log("[pageerror]", String(e).slice(0, 200)));
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

try {
  await page.goto(`http://localhost:${PORT}/web/e2e/harness.html`, { waitUntil: "domcontentloaded" });
  await page.waitForFunction(() => window.__ready === true, { timeout: 30000 });

  console.log(`Loading ${MODEL}…`);
  // IndexedDB cache: HF now redirects shard URLs to its Xet CDN and the Cache
  // API cannot store redirected responses (see net-probe.mjs / app.js).
  await page.evaluate((m) => { window.__useIDB = true; window.__load(m); }, MODEL);
  let lastP = "";
  while (true) {
    const s = await page.evaluate(() => ({ loaded: window.__loadedModel, err: window.__loadError, p: window.__progress }));
    if (s.err) throw new Error("load error: " + s.err);
    if (s.p && s.p !== lastP) { lastP = s.p; process.stdout.write(`\r  ${s.p}`.padEnd(80)); }
    if (s.loaded === MODEL) break;
    await sleep(1500);
  }
  console.log(`\nLoaded.\n`);

  console.log("OBSERVATION (list format) the app feeds the model:\n" + observation.slice(0, 700) + "\n");
  console.log("=".repeat(90));

  for (const exp of experiments) {
    const messages = exp.messages();
    const out = await page.evaluate((req) => window.__chat(req), { messages, temperature: 0.2, max_tokens: 512 });
    const text = (out.content || "").trim();
    // Heuristic: how much does the answer copy the observation?
    const copied = overlap(text, observation);
    console.log(`\n### ${exp.id}  (verbatim-overlap≈${copied}%)`);
    console.log(`why: ${exp.why}`);
    console.log(`--- output (${text.length} chars) ---`);
    console.log(text.slice(0, 1200));
    console.log("=".repeat(90));
  }
} catch (e) {
  console.error("EXP ERROR:", String(e).split("\n")[0]);
  process.exitCode = 1;
} finally {
  await context.close();
  server.close();
}

// Crude verbatim-copy estimate: fraction of the answer's 6-word shingles that
// also appear in the observation.
function overlap(answer, obs) {
  const norm = (s) => s.toLowerCase().replace(/\s+/g, " ");
  const o = norm(obs);
  const words = norm(answer).split(" ").filter(Boolean);
  if (words.length < 6) return 0;
  let hit = 0;
  let total = 0;
  for (let i = 0; i + 6 <= words.length; i += 1) {
    total += 1;
    if (o.includes(words.slice(i, i + 6).join(" "))) hit += 1;
  }
  return total ? Math.round((hit / total) * 100) : 0;
}
