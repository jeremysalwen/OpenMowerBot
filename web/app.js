const INDEX_ROOT = "../data/index/browser/";
const WEBLLM_IMPORT_URL = "https://esm.run/@mlc-ai/web-llm";
const DEFAULT_WEBLLM_MODEL = "Llama-3.2-1B-Instruct-q4f16_1-MLC";
const MAX_RESULTS = 40;
const MAX_CANDIDATES = 600;
const ANSWER_EVIDENCE_LIMIT = 12;

const state = {
  manifest: null,
  termBuckets: new Map(),
  messageShards: new Map(),
  webllm: null,
  webllmEngine: null,
  webllmModel: null,
};

const els = {
  query: document.querySelector("#query"),
  channel: document.querySelector("#channel"),
  author: document.querySelector("#author"),
  after: document.querySelector("#after"),
  before: document.querySelector("#before"),
  attachments: document.querySelector("#attachments"),
  engine: document.querySelector("#engine"),
  webllmModel: document.querySelector("#webllm-model"),
  search: document.querySelector("#search"),
  answer: document.querySelector("#answer"),
  summary: document.querySelector("#summary"),
  results: document.querySelector("#results"),
  answerPanel: document.querySelector("#answer-panel"),
};

init().catch((error) => {
  setSummary(error.message);
});

async function init() {
  state.manifest = await fetchJson(`${INDEX_ROOT}manifest.json`);
  setSummary(`Loaded ${state.manifest.messageCount.toLocaleString()} messages`);
  els.search.addEventListener("click", () => runSearch().catch(showError));
  els.answer.addEventListener("click", () => runAnswer().catch(showError));
  els.query.addEventListener("keydown", (event) => {
    if (event.key === "Enter") {
      runSearch().catch(showError);
    }
  });
}

async function runSearch() {
  els.answerPanel.hidden = true;
  setBusy(true);
  try {
    const results = await search();
    renderResults(results);
    setSummary(`${results.length} results`);
  } finally {
    setBusy(false);
  }
}

async function search() {
  const terms = tokenize(els.query.value);
  const scores = new Map();

  if (terms.length === 0) {
    for (let ordinal = state.manifest.messageCount - 1; ordinal >= 0 && scores.size < MAX_CANDIDATES; ordinal -= 1) {
      scores.set(ordinal, 0);
    }
  } else {
    for (const term of terms) {
      const postings = await postingsForTerm(term);
      for (const ordinal of postings) {
        scores.set(ordinal, (scores.get(ordinal) || 0) + 1);
      }
    }
  }

  const candidates = [...scores.entries()]
    .sort((left, right) => right[1] - left[1] || right[0] - left[0])
    .slice(0, MAX_CANDIDATES);

  const messages = [];
  for (const [ordinal, score] of candidates) {
    const message = await messageForOrdinal(ordinal);
    if (message && matchesFilters(message)) {
      messages.push({ message, score });
    }
    if (messages.length >= MAX_RESULTS) break;
  }

  return messages;
}

async function postingsForTerm(term) {
  const bucket = termBucket(term);
  const terms = await loadTermBucket(bucket);
  return terms[term] || [];
}

async function loadTermBucket(bucket) {
  if (!state.termBuckets.has(bucket)) {
    const bucketInfo = state.manifest.termBuckets.find((entry) => entry.bucket === bucket);
    state.termBuckets.set(bucket, bucketInfo ? await fetchJson(`${INDEX_ROOT}${bucketInfo.file}`) : {});
  }
  return state.termBuckets.get(bucket);
}

async function messageForOrdinal(ordinal) {
  const shardIndex = Math.floor(ordinal / state.manifest.messageShardSize);
  if (!state.messageShards.has(shardIndex)) {
    const shard = state.manifest.messageShards.find((entry) => entry.index === shardIndex);
    if (!shard) return null;
    state.messageShards.set(shardIndex, await fetchJson(`${INDEX_ROOT}${shard.file}`));
  }

  return state.messageShards.get(shardIndex).find((message) => message.o === ordinal) || null;
}

function matchesFilters(message) {
  if (els.channel.value && !includes(message.ch, els.channel.value)) return false;
  if (els.author.value && !includes(message.a, els.author.value)) return false;
  if (els.after.value && Date.parse(message.t || 0) < Date.parse(els.after.value)) return false;
  if (els.before.value && Date.parse(message.t || 0) > Date.parse(`${els.before.value}T23:59:59`)) return false;
  if (els.attachments.checked && (!message.at || message.at.length === 0)) return false;
  return true;
}

function renderResults(results) {
  els.results.replaceChildren(...results.map(({ message }) => {
    const item = document.createElement("article");
    item.className = "result";

    const meta = document.createElement("div");
    meta.className = "meta";
    meta.append(
      span(formatDate(message.t)),
      span(`#${message.ch || "unknown"}`),
      span(message.a || "unknown"),
    );

    const content = document.createElement("div");
    content.className = "content";
    content.textContent = message.text || "";

    const links = document.createElement("div");
    links.className = "links";
    if (message.url) links.append(link("Discord", message.url));
    if (message.replyUrl) links.append(link("Reply", message.replyUrl));

    const attachments = document.createElement("div");
    attachments.className = "attachments";
    for (const attachment of message.at || []) {
      const href = attachment.path ? `../${attachment.path}` : attachment.url;
      if (href) attachments.append(link(attachment.name || "attachment", href));
    }

    item.append(meta, content, links);
    if (attachments.childElementCount > 0) item.append(attachments);
    return item;
  }));
}

async function runAnswer() {
  els.answerPanel.hidden = true;
  setBusy(true);
  try {
    const results = await search();
    renderResults(results);
    if (results.length === 0) {
      showAnswer("No evidence found.");
      return;
    }

    const evidence = results.slice(0, ANSWER_EVIDENCE_LIMIT).map((result) => result.message);
    const answer = await generateAnswer(els.query.value, evidence);
    showAnswer(answer);
    setSummary(`${results.length} evidence results`);
  } finally {
    setBusy(false);
  }
}

async function generateAnswer(question, evidence) {
  const requested = els.engine.value;

  if (requested === "evidence") {
    return formatEvidenceOnly(evidence);
  }

  if (requested === "built-in" || requested === "auto") {
    try {
      const builtIn = await createBuiltInModel();
      if (builtIn) {
        setSummary("Answering with built-in browser LLM...");
        return await promptBuiltInModel(builtIn, buildAnswerPrompt(question, evidence));
      }
    } catch (error) {
      if (requested === "built-in") {
        return `Built-in browser LLM failed: ${error.message}\n\n${formatEvidenceOnly(evidence)}`;
      }
    }
    if (requested === "built-in") {
      return "The built-in browser LLM API is not available. Showing ranked evidence instead.\n\n"
        + formatEvidenceOnly(evidence);
    }
  }

  if (requested === "webllm" || requested === "auto") {
    try {
      const webllm = await createWebLLMEngine();
      if (webllm) {
        setSummary("Answering with WebLLM...");
        return await promptWebLLM(webllm, question, evidence);
      }
    } catch (error) {
      return `WebLLM failed: ${error.message}\n\n${formatEvidenceOnly(evidence)}`;
    }
  }

  return "No local browser LLM is available. Showing ranked evidence instead.\n\n"
    + formatEvidenceOnly(evidence);
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

async function createWebLLMEngine() {
  if (!("gpu" in navigator)) {
    showAnswer("WebLLM requires WebGPU. Showing ranked evidence instead.");
    return null;
  }

  const selectedModel = els.webllmModel.value || DEFAULT_WEBLLM_MODEL;
  if (state.webllmEngine && state.webllmModel === selectedModel) {
    return state.webllmEngine;
  }

  setSummary("Loading WebLLM...");
  showAnswer("Loading WebLLM. The first model download can take several minutes and is cached by the browser.");

  state.webllm = state.webllm || await import(WEBLLM_IMPORT_URL);
  state.webllmModel = selectedModel;
  state.webllmEngine = await state.webllm.CreateMLCEngine(selectedModel, {
    initProgressCallback: (progress) => {
      const text = progress?.text || "Loading WebLLM model...";
      const percent = Number.isFinite(progress?.progress)
        ? ` ${Math.round(progress.progress * 100)}%`
        : "";
      setSummary(`${text}${percent}`);
      showAnswer(`${text}${percent}`);
    },
  });

  return state.webllmEngine;
}

async function promptWebLLM(engine, question, evidence) {
  const chunks = await engine.chat.completions.create({
    messages: buildChatMessages(question, evidence),
    temperature: 0.2,
    max_tokens: 700,
    stream: true,
  });

  let answer = "";
  for await (const chunk of chunks) {
    answer += chunk.choices[0]?.delta?.content || "";
    showAnswer(answer);
  }

  return answer.trim() || "The local model returned an empty answer.";
}

function buildAnswerPrompt(question, messages) {
  const evidence = messages.map((message, index) => {
    return `[${index + 1}] ${message.t} #${message.ch} ${message.a}: ${message.text}\n${message.url || ""}`;
  }).join("\n\n");

  return `Answer the question using only the Discord evidence below. Include source numbers and Discord links when useful.\n\nQuestion: ${question}\n\nEvidence:\n${evidence}`;
}

function buildChatMessages(question, evidence) {
  return [
    {
      role: "system",
      content: "Answer using only the provided Discord evidence. Cite source numbers and include Discord links when useful. If the evidence is insufficient, say so.",
    },
    {
      role: "user",
      content: `Question: ${question || "(no question provided)"}\n\nEvidence:\n${formatEvidenceForPrompt(evidence)}`,
    },
  ];
}

function formatEvidenceForPrompt(messages) {
  return messages.map((message, index) => {
    return [
      `[${index + 1}]`,
      `Time: ${message.t || "unknown"}`,
      `Channel: #${message.ch || "unknown"}`,
      `Author: ${message.a || "unknown"}`,
      `URL: ${message.url || "none"}`,
      `Text: ${message.text || ""}`,
    ].join("\n");
  }).join("\n\n");
}

function formatEvidenceOnly(messages) {
  return messages.map((message, index) => {
    const text = (message.text || "").replace(/\s+/g, " ").trim();
    return `[${index + 1}] ${message.t || "unknown"} #${message.ch || "unknown"} ${message.a || "unknown"}\n${text}\n${message.url || ""}`;
  }).join("\n\n");
}

function showAnswer(text) {
  els.answerPanel.textContent = text;
  els.answerPanel.hidden = false;
}

function tokenize(input) {
  return String(input)
    .toLowerCase()
    .split(/[^a-z0-9_#.-]+/i)
    .map((term) => term.trim())
    .filter((term) => term.length >= 2);
}

function termBucket(term) {
  const first = term[0] || "_";
  if (first >= "0" && first <= "9") return "0-9";
  if (first >= "a" && first <= "z") return first;
  return "_";
}

async function fetchJson(url) {
  const response = await fetch(url);
  if (!response.ok) throw new Error(`Failed to load ${url}: HTTP ${response.status}`);
  return response.json();
}

function setBusy(value) {
  els.search.disabled = value;
  els.answer.disabled = value;
}

function setSummary(text) {
  els.summary.textContent = text;
}

function showError(error) {
  setSummary(error.message);
}

function includes(value, query) {
  return String(value || "").toLowerCase().includes(String(query).toLowerCase());
}

function span(text) {
  const element = document.createElement("span");
  element.textContent = text;
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

function formatDate(value) {
  if (!value) return "unknown time";
  return new Date(value).toLocaleString();
}
