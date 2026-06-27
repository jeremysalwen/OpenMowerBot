import { createStore } from "./index-store.js";
import {
  createTools,
  runAgentTurn,
  flattenMessages,
  extractGeneratedText,
  toManualConversation,
} from "./agent.js";
import { openAiChat } from "./openai-chat.js";

const INDEX_ROOT = "../data/index/browser/";
const WEBLLM_IMPORT_URL = "https://esm.run/@mlc-ai/web-llm@0.2.84";
const TRANSFORMERS_IMPORT_URL = "https://esm.run/@huggingface/transformers@4.2.0";
const DEFAULT_WEBLLM_MODEL = "Qwen3-0.6B-q4f16_1-MLC";
// Qwen3-0.6B is the smallest Transformers.js model that reliably drives native
// tool calling; the 135M/270M models are too small to call tools well.
const DEFAULT_TRANSFORMERS_MODEL = "onnx-community/Qwen3-0.6B-ONNX";
const APP_VERSION = "2026-06-27.13";
// Optional build-time site config. The GitHub Pages deploy sets
// attachmentsLocal:false because attachments are not published to Pages.
const SITE_CONFIG = (typeof window !== "undefined" && window.DISCORD_HISTORY_CONFIG) || {};

const state = {
  store: null,
  manifest: null,
  tools: null,
  webllm: null,
  webllmEngine: null,
  webllmModel: null,
  transformers: null,
  transformersGenerator: null,
  transformersModel: null,
  busy: false,
  turns: [],
  activeTurn: null,
};

const els = {
  query: document.querySelector("#query"),
  answerMode: document.querySelector("#answer-mode"),
  apiSettings: document.querySelector("#api-settings"),
  apiBaseUrl: document.querySelector("#api-base-url"),
  apiModel: document.querySelector("#api-model"),
  apiKey: document.querySelector("#api-key"),
  composer: document.querySelector("#composer"),
  send: document.querySelector("#send"),
  summary: document.querySelector("#summary"),
  transcript: document.querySelector("#transcript"),
  sourcesList: document.querySelector("#sources-list"),
  sourcesEmpty: document.querySelector("#sources-empty"),
};

// Persisted UI settings (answer model + hosted API config). The API key is kept
// in this browser's localStorage only; this is a static site with no backend.
const STORE_KEY = "discord-history.settings";

init().catch((error) => {
  setSummary(error.message);
  appendNoticeMessage("The browser index could not be loaded.", error.message);
});

async function init() {
  state.store = createStore({ fetchJson, indexRoot: INDEX_ROOT });
  state.manifest = await state.store.loadManifest();
  state.tools = createTools(state.store);
  setSummary(statusText("Ready"));
  appendNoticeMessage(
    "Ask a question about the OpenMower Discord history. I'll search the archive and answer with cited sources shown in the Sources panel.",
    "Tip: for the most capable answers, clone the repo and run an agent CLI (Claude Code or Codex) inside the directory and ask there. AGENTS.md teaches it to use the bundled search tools. This page is the no-install option.",
  );
  renderActiveSources();
  initSettings();

  els.composer.addEventListener("submit", (event) => {
    event.preventDefault();
    submitQuestion().catch(showError);
  });

  els.query.addEventListener("input", () => {
    els.query.style.height = "auto";
    els.query.style.height = `${Math.min(180, els.query.scrollHeight)}px`;
  });

  els.query.addEventListener("keydown", (event) => {
    if (event.key === "Enter" && !event.shiftKey) {
      event.preventDefault();
      els.composer.requestSubmit();
    }
  });
}

async function submitQuestion() {
  const question = els.query.value.trim();
  if (!question || state.busy) return;

  els.query.value = "";
  els.query.style.height = "auto";
  appendUserMessage(question);
  setBusy(true);

  const turn = createTurn();
  setActiveTurn(turn);

  try {
    await answerQuestion(question, turn);
  } catch (error) {
    setTurnStatus(turn, `Error: ${error.message}`);
    setAnswer(turn, `Something went wrong while answering: ${error.message}`);
  } finally {
    clearTurnStatus(turn);
    setBusy(false);
  }
}

// --- Turn driver: wires the shared agent to the DOM -------------------------

async function answerQuestion(question, turn) {
  setTurnStatus(turn, "Loading the answer model...");
  const engine = await resolveEngine((text) => setTurnStatus(turn, text));

  if (!engine) {
    await runEvidenceOnlyTurn(question, turn);
    return;
  }

  // Test instrumentation: a headless run can read the last turn's engine,
  // tool calls, answer, and source count without scraping the DOM. Harmless
  // in production (just a record of what already happened on screen).
  const probe = { engine: engine.label, question, toolCalls: [], modelOutputs: [], observations: [], answer: null, sources: 0, done: false };
  if (typeof window !== "undefined") window.__ombLastRun = probe;

  const result = await runAgentTurn({
    question,
    engine,
    tools: state.tools,
    hooks: {
      setStatus: (text) => setTurnStatus(turn, text),
      setSummary,
      startToolCall: (toolName, args) => {
        probe.toolCalls.push({ name: toolName, args });
        return renderToolCall(turn, toolName, args, "running", 0);
      },
      onModelOutput: (text, step) => probe.modelOutputs.push({ step, text }),
      onObservation: (text) => probe.observations.push(text),
      finishToolCall: (card, toolName, args, status, count) =>
        renderToolCall(turn, toolName, args, status, count, card),
      onEvidence: (list) => {
        turn.list = list;
        renderActiveSources();
      },
      onAnswer: (text, list) => {
        turn.list = list;
        setAnswer(turn, text);
      },
    },
  });

  probe.answer = result?.answer ?? null;
  probe.sources = result?.evidence?.length ?? turn.list.length;
  probe.done = true;
}

async function runEvidenceOnlyTurn(question, turn) {
  setTurnStatus(turn, "No browser LLM available; searching the index...");
  const card = renderToolCall(turn, "search_messages", { query: question }, "running", 0);
  const result = await state.tools.search_messages.run({ query: question, limit: 16 });
  const messages = result.messages || [];
  turn.list = messages;
  renderActiveSources();
  renderToolCall(turn, "search_messages", { query: question }, "done", messages.length, card);

  const answer = messages.length > 0
    ? "No browser LLM is selected or available, so I can't compose a written answer. The top matching messages are listed in the Sources panel "
      + messages.map((_, index) => `[${index + 1}]`).join("")
      + "."
    : "No browser LLM is available and the search found no matching messages. Try different terms.";
  setAnswer(turn, answer);
  setSummary(statusText(`Evidence only, ${turn.list.length} sources`));
}

// --- Engine abstraction -----------------------------------------------------

async function resolveEngine(note) {
  const mode = selectedAnswerMode();
  if (mode.engine === "evidence") return null;

  const order = mode.engine === "auto"
    ? ["built-in", "webllm", "transformers"]
    : [mode.engine];

  let lastError = null;
  for (const kind of order) {
    try {
      const engine = await loadEngine(kind, mode, note);
      if (engine) return engine;
    } catch (error) {
      lastError = error;
      note?.(`${kind} unavailable: ${error.message}`);
    }
  }
  if (lastError && order.length === 1) throw lastError;
  return null;
}

async function loadEngine(kind, mode, note) {
  if (kind === "built-in") {
    const model = await createBuiltInModel();
    if (!model) return null;
    return {
      label: "Built-in browser model",
      // No native tool calling; returns prose that the agent parses for any
      // JSON-shaped tool call the model happens to emit.
      async chat(messages) {
        return { text: await promptBuiltInModel(model, flattenMessages(messages)) };
      },
    };
  }

  if (kind === "webllm") {
    const engine = await createWebLLMEngine(mode.webllmModel, note);
    if (!engine) return null;
    // WebLLM only accepts the OpenAI `tools` param for an allow-list of
    // function-calling models (the Hermes family). For every other WebLLM
    // model we fall back to the manual prompt+parse protocol, the same text
    // path the Transformers.js engine uses.
    const native = supportsWebLLMTools(state.webllmModel);
    const textProtocol = webLLMTextToolProtocol(state.webllmModel);
    const constrainedObservation = /^(?:Qwen3\.5-4B|Hermes-3-Llama-3\.1-8B)/i.test(state.webllmModel || "");
    const generation = {
      temperature: 0,
      max_tokens: textProtocol === "qwen35" && !constrainedObservation ? 768 : 384,
      ...(constrainedObservation ? { extra_body: { enable_thinking: false } } : {}),
      ...(textProtocol === "phi4" ? { stop: "<|/tool_call|>" } : {}),
    };
    const complete = (request) => guardWebLLM(engine.chat.completions.create(request));
    return {
      label: `WebLLM ${state.webllmModel}${native ? "" : textProtocol ? " (native text tools)" : " (manual tools)"}`,
      ...(constrainedObservation ? { observationBudget: { maxMessages: 3, snippetLength: 120 } } : {}),
      async chat(messages, { tools } = {}) {
        if (native && tools) {
          const response = await complete({
            // WebLLM's Hermes function-calling template owns the system turn
            // and rejects any caller-supplied system message.
            messages: messages.filter((message) => message.role !== "system"),
            tools,
            tool_choice: "auto",
            ...generation,
          });
          const message = response.choices[0]?.message || {};
          const toolCalls = (message.tool_calls || []).map((call) => ({
            id: call.id,
            name: call.function?.name,
            arguments: parseJsonArgs(call.function?.arguments),
          }));
          return { content: message.content || "", toolCalls };
        }
        // Manual mode: describe tools in the prompt, flatten tool/assistant
        // messages the Llama/Qwen templates can't take, and parse the text.
        const response = await complete({
          messages: tools ? toManualConversation(messages, tools, textProtocol) : messages,
          ...generation,
        });
        return { text: response.choices[0]?.message?.content || "" };
      },
    };
  }

  if (kind === "transformers") {
    const generator = await createTransformersGenerator(mode.transformersModel, note);
    if (!generator) return null;
    return {
      label: `Transformers.js ${state.transformersModel}`,
      toolCallArguments: "object",
      // Tools are rendered into the chat template; the model emits its native
      // tool-call markup as text, which the agent parses. The larger budget
      // leaves room for reasoning models (Qwen3) to think and still call a
      // tool. No repetition penalty: it suppresses the tool-call tokens (which
      // also appear in the rendered prompt) and does not rescue the tiny models.
      async chat(messages, { tools } = {}) {
        const result = await generator(messages, {
          tools,
          max_new_tokens: 1024,
          do_sample: false,
          return_full_text: false,
        });
        return { text: extractGeneratedText(result).trim() };
      },
    };
  }

  if (kind === "api") {
    return createApiEngine(mode.api || apiConfig());
  }

  return null;
}

// Hosted OpenAI-compatible chat completions engine. The request goes directly
// from the browser to the endpoint, which must allow CORS. Preserve structured
// tool calls and their ids so this path exercises the model/runtime's native
// tool protocol just like an independent OpenAI client does.
function createApiEngine(config) {
  const baseUrl = (config.baseUrl || "").replace(/\/+$/, "");
  const model = config.model || "";
  const apiKey = config.apiKey || "";
  if (!baseUrl) throw new Error("Enter an API base URL (for example https://api.openai.com/v1).");
  if (!model) throw new Error("Enter an API model name (for example gpt-4o-mini).");

  return {
    label: `API ${model}`,
    async chat(messages, { tools, onDelta } = {}) {
      return openAiChat({ baseUrl, model, apiKey, messages, tools, onDelta });
    },
  };
}

function parseJsonArgs(value) {
  if (value && typeof value === "object") return value;
  try {
    return JSON.parse(String(value || "{}"));
  } catch {
    return {};
  }
}

function selectedAnswerMode() {
  const raw = els.answerMode.value || "auto";
  const base = { webllmModel: DEFAULT_WEBLLM_MODEL, transformersModel: DEFAULT_TRANSFORMERS_MODEL };
  if (raw.startsWith("webllm:")) {
    return { ...base, engine: "webllm", webllmModel: raw.slice("webllm:".length) };
  }
  if (raw.startsWith("transformers:")) {
    return { ...base, engine: "transformers", transformersModel: raw.slice("transformers:".length) };
  }
  if (raw === "api") {
    return { ...base, engine: "api", api: apiConfig() };
  }
  return { ...base, engine: raw };
}

function apiConfig() {
  return {
    baseUrl: (els.apiBaseUrl.value || "").trim().replace(/\/+$/, ""),
    model: (els.apiModel.value || "").trim(),
    apiKey: (els.apiKey.value || "").trim(),
  };
}

function initSettings() {
  const saved = loadSettings();
  if (saved.mode && [...els.answerMode.options].some((option) => option.value === saved.mode)) {
    els.answerMode.value = saved.mode;
  }
  if (saved.apiBaseUrl) els.apiBaseUrl.value = saved.apiBaseUrl;
  if (saved.apiModel) els.apiModel.value = saved.apiModel;
  if (saved.apiKey) els.apiKey.value = saved.apiKey;
  syncApiSettingsVisibility();

  els.answerMode.addEventListener("change", () => {
    syncApiSettingsVisibility();
    saveSettings();
  });
  for (const input of [els.apiBaseUrl, els.apiModel, els.apiKey]) {
    input.addEventListener("change", saveSettings);
  }
}

function syncApiSettingsVisibility() {
  els.apiSettings.hidden = els.answerMode.value !== "api";
}

function loadSettings() {
  try {
    return JSON.parse(localStorage.getItem(STORE_KEY) || "{}") || {};
  } catch {
    return {};
  }
}

function saveSettings() {
  const settings = {
    mode: els.answerMode.value,
    apiBaseUrl: els.apiBaseUrl.value.trim(),
    apiModel: els.apiModel.value.trim(),
    apiKey: els.apiKey.value.trim(),
  };
  try {
    localStorage.setItem(STORE_KEY, JSON.stringify(settings));
  } catch {
    /* localStorage may be unavailable (private mode); settings stay in-memory. */
  }
}

async function createBuiltInModel() {
  const api = globalThis.LanguageModel || globalThis.ai?.languageModel;
  if (!api) return null;
  if (typeof api.create === "function") return api.create();
  if (typeof api.createSession === "function") return api.createSession();
  return null;
}

async function promptBuiltInModel(model, prompt) {
  if (typeof model.prompt === "function") return model.prompt(prompt);
  if (typeof model.generate === "function") return model.generate(prompt);
  throw new Error("The available browser model does not expose a prompt method.");
}

async function createWebLLMEngine(modelName, note) {
  if (!hasWebGPU()) {
    note?.("WebLLM requires WebGPU; falling back to the WASM model.");
    return null;
  }

  const selectedModel = modelName || DEFAULT_WEBLLM_MODEL;
  if (state.webllmEngine && state.webllmModel === selectedModel) {
    return state.webllmEngine;
  }

  note?.("Loading WebLLM. The first model download can take several minutes and is cached by the browser.");
  state.webllm = state.webllm || await import(WEBLLM_IMPORT_URL);
  state.webllmModel = selectedModel;
  // Cache weights in IndexedDB, not the Cache API. HuggingFace now 302-redirects
  // shard URLs to its Xet CDN, and the Cache API cannot store a redirected
  // response, so the default Cache backend throws "Cache.add() encountered a
  // network error" on the first shard. IndexedDB (fetch→arrayBuffer→store) is
  // immune. Verified against fresh 1B/3B downloads in web/e2e/test-idb-cache.mjs.
  const appConfig = { ...state.webllm.prebuiltAppConfig, cacheBackend: "indexeddb" };
  state.webllmEngine = await state.webllm.CreateMLCEngine(selectedModel, {
    appConfig,
    initProgressCallback: (progress) => {
      const percent = Number.isFinite(progress?.progress) ? ` ${Math.round(progress.progress * 100)}%` : "";
      const text = `${progress?.text || "Loading WebLLM model..."}${percent}`;
      setSummary(text);
      note?.(text);
    },
  });

  return state.webllmEngine;
}

function hasWebGPU() {
  return Boolean(globalThis.navigator?.gpu);
}

// WebLLM accepts the OpenAI `tools` param only for a narrow allow-list exported
// by the package. Keep a local fallback for CDN/version oddities; do not use a
// broad Hermes regex, because not every Hermes model in WebLLM supports tools.
const WEBLLM_NATIVE_TOOL_MODELS = new Set([
  "Hermes-2-Pro-Llama-3-8B-q4f16_1-MLC",
  "Hermes-2-Pro-Llama-3-8B-q4f32_1-MLC",
  "Hermes-2-Pro-Mistral-7B-q4f16_1-MLC",
  "Hermes-3-Llama-3.1-8B-q4f32_1-MLC",
  "Hermes-3-Llama-3.1-8B-q4f16_1-MLC",
]);

function supportsWebLLMTools(modelName) {
  const upstream = state.webllm?.functionCallingModelIds;
  if (Array.isArray(upstream)) return upstream.includes(modelName);
  return WEBLLM_NATIVE_TOOL_MODELS.has(modelName);
}

function webLLMTextToolProtocol(modelName) {
  if (/^Qwen3\.5-/i.test(modelName || "")) return "qwen35";
  if (/^Hermes-/i.test(modelName || "")) return "hermes";
  if (/^Phi-4-mini/i.test(modelName || "")) return "phi4";
  return "";
}

// A large model (e.g. Llama 3.2 3B) can exhaust GPU memory or exceed the OS GPU
// watchdog (Windows TDR), losing the WebGPU device. WebLLM then disposes the
// engine, so it can never recover and every later call throws "Object has
// already been disposed". Detect that, drop the dead engine so the next attempt
// reloads, and surface a clear, actionable message instead of a raw stack.
async function guardWebLLM(promise) {
  try {
    return await promise;
  } catch (error) {
    const text = String(error?.message || error);
    if (/device.*lost|device.*hung|already been disposed|GPUDevice|out of memory|DXGI/i.test(text)) {
      const model = state.webllmModel;
      state.webllmEngine = null;
      state.webllmModel = null;
      throw new Error(
        `The GPU ran out of resources running ${model || "this model"} and the WebGPU device was lost. `
        + "Try a smaller model (e.g. Llama 3.2 1B) or close other GPU-heavy tabs, then ask again.",
      );
    }
    throw error;
  }
}

async function createTransformersGenerator(modelName, note) {
  const selectedModel = modelName || DEFAULT_TRANSFORMERS_MODEL;
  if (state.transformersGenerator && state.transformersModel === selectedModel) {
    return state.transformersGenerator;
  }

  note?.("Loading Transformers.js. The first model download can take several minutes and is cached by the browser. Firefox uses the WASM/CPU backend unless WebGPU is enabled.");
  state.transformers = state.transformers || await import(TRANSFORMERS_IMPORT_URL);
  state.transformersModel = selectedModel;
  state.transformersGenerator = await state.transformers.pipeline("text-generation", selectedModel, {
    dtype: "q4",
    progress_callback: (progress) => {
      const file = progress?.file ? ` ${progress.file}` : "";
      const percent = Number.isFinite(progress?.progress) ? ` ${Math.round(progress.progress)}%` : "";
      const status = progress?.status || "loading";
      const text = `Transformers.js ${status}${file}${percent}`;
      setSummary(text);
      note?.(text);
    },
  });

  return state.transformersGenerator;
}

// --- Per-turn rendering -----------------------------------------------------

function createTurn() {
  const node = messageShell("assistant");
  node.dataset.turn = String(state.turns.length);

  const status = document.createElement("div");
  status.className = "turn-status";
  status.textContent = "Working...";

  const trace = document.createElement("div");
  trace.className = "tool-trace";

  node.append(status, trace);
  els.transcript.append(node);

  const turn = { node, statusEl: status, traceEl: trace, bodyEl: null, list: [] };
  node.addEventListener("click", () => setActiveTurn(turn));
  state.turns.push(turn);
  scrollTranscript();
  return turn;
}

function setActiveTurn(turn) {
  if (state.activeTurn === turn) return;
  state.activeTurn = turn;
  for (const node of els.transcript.querySelectorAll(".message.assistant")) {
    node.classList.toggle("active-turn", node === turn?.node);
  }
  renderActiveSources();
}

function appendUserMessage(text) {
  const node = messageShell("user");
  const body = document.createElement("div");
  body.className = "message-body";
  body.textContent = text;
  node.append(body);
  els.transcript.append(node);
  scrollTranscript();
}

function appendNoticeMessage(text, note) {
  const node = messageShell("assistant notice");
  const body = document.createElement("div");
  body.className = "message-body";
  body.textContent = text;
  node.append(body);
  if (note) {
    const small = document.createElement("p");
    small.className = "note";
    small.textContent = note;
    node.append(small);
  }
  els.transcript.append(node);
  scrollTranscript();
}

function setTurnStatus(turn, text) {
  if (!turn.statusEl) return;
  turn.statusEl.hidden = false;
  turn.statusEl.textContent = text;
  scrollTranscript();
}

function clearTurnStatus(turn) {
  if (turn.statusEl) turn.statusEl.hidden = true;
}

function setAnswer(turn, text) {
  clearTurnStatus(turn);
  if (!turn.bodyEl) {
    turn.bodyEl = document.createElement("div");
    turn.bodyEl.className = "message-body";
    turn.node.append(turn.bodyEl);
  }
  renderAnswerInto(turn.bodyEl, text, turn);
  scrollTranscript();
}

function renderAnswerInto(target, text, turn) {
  target.replaceChildren();
  const parts = String(text).split(/(\[\d+\])/g);
  for (const part of parts) {
    const match = /^\[(\d+)\]$/.exec(part);
    const n = match ? Number(match[1]) : null;
    if (n && n >= 1 && n <= turn.list.length) {
      const link = document.createElement("a");
      link.className = "cite";
      link.href = "#";
      link.textContent = part;
      link.addEventListener("click", (event) => {
        event.preventDefault();
        setActiveTurn(turn);
        focusSource(n);
      });
      target.append(link);
    } else {
      target.append(document.createTextNode(part));
    }
  }
}

function renderToolCall(turn, toolName, args, status, count, existing) {
  const card = existing || document.createElement("details");
  if (!existing) {
    card.className = "tool-call";
    card.open = false;
    turn.traceEl.append(card);
  }
  card.classList.toggle("error", status === "error");

  const label = status === "running"
    ? `Calling ${toolName}...`
    : status === "error"
      ? `${toolName} failed`
      : `${toolName} → ${count} message${count === 1 ? "" : "s"}`;

  card.replaceChildren(summaryEl(label), codeLine(formatArgs(args)));
  scrollTranscript();
  return card;
}

function formatArgs(args) {
  const entries = Object.entries(args || {}).filter(([, value]) => value != null && value !== "");
  if (entries.length === 0) return "(no arguments)";
  return entries.map(([key, value]) => `${key}: ${typeof value === "string" ? value : JSON.stringify(value)}`).join(" | ");
}

// --- Sources side panel -----------------------------------------------------

function renderActiveSources() {
  const turn = state.activeTurn;
  const list = turn?.list || [];
  els.sourcesList.replaceChildren();

  if (list.length === 0) {
    els.sourcesEmpty.hidden = false;
    return;
  }
  els.sourcesEmpty.hidden = true;

  for (const [index, message] of list.entries()) {
    els.sourcesList.append(renderSourceCard(index + 1, message));
  }
}

function renderSourceCard(n, message) {
  const card = document.createElement("article");
  card.className = "source";
  card.dataset.n = String(n);

  const meta = document.createElement("div");
  meta.className = "source-meta";
  meta.append(
    span(`[${n}]`, "source-index"),
    span(formatDate(message.t)),
    span(`#${message.ch || "unknown"}`),
    span(message.a || "unknown"),
  );

  const content = document.createElement("p");
  content.textContent = shorten(message.text || "(no message text)", 460);

  const links = document.createElement("div");
  links.className = "links";
  if (message.url) links.append(link("Discord message", message.url));
  if (message.replyUrl) links.append(link("Reply", message.replyUrl));
  for (const attachment of message.at || []) {
    const local = attachment.path ? `../${attachment.path}` : null;
    // When local attachments are not published (Pages), prefer the Discord URL.
    const href = SITE_CONFIG.attachmentsLocal === false
      ? attachment.url || local
      : local || attachment.url;
    if (href) links.append(link(attachment.name || "attachment", href));
  }

  card.append(meta, content);
  if (links.childElementCount > 0) card.append(links);
  return card;
}

function focusSource(n) {
  const card = els.sourcesList.querySelector(`[data-n="${n}"]`);
  if (!card) return;
  card.scrollIntoView({ behavior: "smooth", block: "center" });
  card.classList.remove("flash");
  void card.offsetWidth;
  card.classList.add("flash");
}

// --- Small DOM + misc helpers ----------------------------------------------

function messageShell(role) {
  const node = document.createElement("article");
  node.className = `message ${role}`;
  return node;
}

function summaryEl(text) {
  const element = document.createElement("summary");
  element.textContent = text;
  return element;
}

function codeLine(text) {
  const element = document.createElement("div");
  element.className = "tool-line";
  element.textContent = text;
  return element;
}

function span(text, className) {
  const element = document.createElement("span");
  element.textContent = text;
  if (className) element.className = className;
  return element;
}

function link(text, href) {
  const element = document.createElement("a");
  element.textContent = text;
  element.href = href;
  element.target = "_blank";
  element.rel = "noreferrer";
  return element;
}

async function fetchJson(url) {
  const response = await fetch(url);
  if (!response.ok) throw new Error(`Failed to load ${url}: HTTP ${response.status}`);
  return response.json();
}

function setBusy(value) {
  state.busy = value;
  els.send.disabled = value;
  els.query.disabled = value;
}

function setSummary(text) {
  els.summary.textContent = text;
}

function statusText(prefix) {
  return `${prefix}. ${state.manifest.messageCount.toLocaleString()} messages. App ${APP_VERSION}. WebGPU: ${hasWebGPU() ? "yes" : "no"}.`;
}

function showError(error) {
  setSummary(error.message);
  appendNoticeMessage("Something went wrong while answering.", error.message);
  setBusy(false);
}

function shorten(text, maxLength) {
  const cleaned = String(text).replace(/\s+/g, " ").trim();
  if (cleaned.length <= maxLength) return cleaned;
  return `${cleaned.slice(0, maxLength - 1)}...`;
}

function formatDate(value) {
  if (!value) return "unknown time";
  return new Date(value).toLocaleString();
}

function scrollTranscript() {
  requestAnimationFrame(() => {
    els.transcript.scrollTop = els.transcript.scrollHeight;
  });
}
