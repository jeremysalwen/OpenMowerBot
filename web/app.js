const INDEX_ROOT = "../data/index/browser/";
const WEBLLM_IMPORT_URL = "https://esm.run/@mlc-ai/web-llm";
const TRANSFORMERS_IMPORT_URL = "https://esm.run/@huggingface/transformers";
const DEFAULT_WEBLLM_MODEL = "Llama-3.2-1B-Instruct-q4f16_1-MLC";
const DEFAULT_TRANSFORMERS_MODEL = "onnx-community/SmolLM2-135M-Instruct-ONNX-MHA";
const APP_VERSION = "2026-06-26.9";
// Optional build-time site config. The GitHub Pages deploy sets
// attachmentsLocal:false because attachments are not published to Pages.
const SITE_CONFIG = (typeof window !== "undefined" && window.DISCORD_HISTORY_CONFIG) || {};
const MAX_RESULTS = 48;
const MAX_CANDIDATES = 900;
const CONTEXT_ORDINAL_SCAN = 2500;
const AGENT_MAX_STEPS = 8;

const state = {
  manifest: null,
  termBuckets: new Map(),
  messageShards: new Map(),
  seenById: new Map(),
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
  composer: document.querySelector("#composer"),
  send: document.querySelector("#send"),
  summary: document.querySelector("#summary"),
  transcript: document.querySelector("#transcript"),
  sourcesList: document.querySelector("#sources-list"),
  sourcesEmpty: document.querySelector("#sources-empty"),
};

// Tool registry. Each tool is callable by the model. `usage`/`summary` are
// rendered into the system prompt so the model knows what is available, and
// `run` is the browser-side implementation backed by the static index.
const TOOLS = {
  search_messages: {
    usage: "search_messages(query, channel?, author?, after?, before?, has_attachment?, limit?)",
    summary: "Full-text search of Discord messages. Returns matching messages with id, timestamp, channel, author, and a snippet.",
    async run(args) {
      const results = await searchMessages({
        query: String(args.query || ""),
        channel: args.channel,
        author: args.author,
        after: args.after,
        before: args.before,
        attachments: args.has_attachment ?? args.attachments,
        limit: clampNumber(args.limit, 12, 1, MAX_RESULTS),
      });
      return { messages: results.map((result) => result.message) };
    },
  },
  get_context: {
    usage: "get_context(message_id, minutes_before?, minutes_after?)",
    summary: "Read the same-channel conversation surrounding a message id from a previous search hit, to understand it before trusting it.",
    async run(args) {
      const id = String(args.message_id ?? args.messageId ?? args.id ?? "");
      const center = state.seenById.get(id);
      if (!center) {
        return { messages: [], error: `unknown message_id "${id}". Call search_messages first and use an id from the results.` };
      }
      const messages = await getConversationContext({
        centerOrdinal: center.o,
        centerTimestamp: center.t,
        channelId: center.chId,
        channelName: center.ch,
        minutesBefore: clampNumber(args.minutes_before, 45, 1, 360),
        minutesAfter: clampNumber(args.minutes_after, 45, 1, 360),
        maxMessages: 16,
      });
      return { messages };
    },
  },
  read_channel: {
    usage: "read_channel(channel, after?, before?, author?, limit?)",
    summary: "Read messages from a channel within a date range, in chronological order. Use when the question names a channel and time window.",
    async run(args) {
      const messages = await getChannelRange({
        channel: args.channel,
        after: args.after,
        before: args.before,
        author: args.author,
        attachments: args.has_attachment ?? args.attachments,
        limit: clampNumber(args.limit, 40, 1, 80),
      });
      return { messages };
    },
  },
};

init().catch((error) => {
  setSummary(error.message);
  appendNoticeMessage("The browser index could not be loaded.", error.message);
});

async function init() {
  state.manifest = await fetchJson(`${INDEX_ROOT}manifest.json`);
  setSummary(statusText("Ready"));
  appendNoticeMessage(
    "Ask a question about the OpenMower Discord history. I'll call search tools as needed and answer with cited sources shown in the Sources panel.",
  );
  renderActiveSources();

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
    await runAgentTurn(question, turn);
  } catch (error) {
    setTurnStatus(turn, `Error: ${error.message}`);
    setAnswer(turn, `Something went wrong while answering: ${error.message}`);
  } finally {
    clearTurnStatus(turn);
    setBusy(false);
  }
}

// --- Model-driven tool-calling agent ----------------------------------------

async function runAgentTurn(question, turn) {
  setTurnStatus(turn, "Loading the answer model...");
  const engine = await resolveEngine((text) => setTurnStatus(turn, text));

  if (!engine) {
    await runEvidenceOnlyTurn(question, turn);
    return;
  }

  const conversation = [
    { role: "system", content: systemPrompt() },
    { role: "user", content: question },
  ];
  const calledSignatures = new Set();

  for (let step = 1; step <= AGENT_MAX_STEPS; step += 1) {
    setSummary(`${engine.label}: step ${step}/${AGENT_MAX_STEPS}...`);
    setTurnStatus(turn, "Thinking...");

    const raw = await engine.chat(conversation, {
      onDelta: (text) => setTurnStatus(turn, `Thinking: ${tail(text)}`),
    });
    conversation.push({ role: "assistant", content: raw });

    const parsed = parseAgentOutput(raw);
    if (parsed.kind === "answer") {
      setAnswer(turn, parsed.answer);
      setSummary(statusText(`Answered in ${step} step${step === 1 ? "" : "s"}, ${turn.list.length} sources`));
      return;
    }

    const tool = TOOLS[parsed.tool];
    if (!tool) {
      renderToolCall(turn, parsed.tool, parsed.arguments, "error", 0);
      conversation.push({
        role: "user",
        content: `Observation: unknown tool "${parsed.tool}". Available tools: ${Object.keys(TOOLS).join(", ")}. Reply with one JSON object.`,
      });
      continue;
    }

    const signature = `${parsed.tool}:${stableStringify(parsed.arguments)}`;
    if (calledSignatures.has(signature)) {
      conversation.push({
        role: "user",
        content: "Observation: you already ran that exact call. Try different arguments or give your final answer.",
      });
      continue;
    }
    calledSignatures.add(signature);

    const card = renderToolCall(turn, parsed.tool, parsed.arguments, "running", 0);
    let result;
    try {
      result = await tool.run(parsed.arguments || {});
    } catch (error) {
      result = { messages: [], error: error.message };
    }

    const numbered = registerEvidence(turn, result.messages || []);
    renderActiveSources();
    renderToolCall(turn, parsed.tool, parsed.arguments, result.error ? "error" : "done", numbered.length, card);
    conversation.push({ role: "user", content: formatObservation(parsed.tool, numbered, result) });
  }

  // Budget exhausted: force a final answer from whatever was gathered.
  setTurnStatus(turn, "Composing final answer...");
  conversation.push({
    role: "user",
    content: 'You have reached the tool-call limit. Give your final answer now as {"answer": "..."} citing the source numbers you have.',
  });
  const raw = await engine.chat(conversation, {
    onDelta: (text) => setTurnStatus(turn, `Thinking: ${tail(text)}`),
  });
  const parsed = parseAgentOutput(raw);
  setAnswer(turn, parsed.kind === "answer" ? parsed.answer : stripJsonWrapper(raw));
  setSummary(statusText(`Answered (tool budget reached), ${turn.list.length} sources`));
}

async function runEvidenceOnlyTurn(question, turn) {
  setTurnStatus(turn, "No browser LLM available; searching the index...");
  const card = renderToolCall(turn, "search_messages", { query: question }, "running", 0);
  const result = await TOOLS.search_messages.run({ query: question, limit: 16 });
  const numbered = registerEvidence(turn, result.messages || []);
  renderActiveSources();
  renderToolCall(turn, "search_messages", { query: question }, "done", numbered.length, card);

  const answer = numbered.length > 0
    ? "No browser LLM is selected or available, so I can't compose a written answer. The top matching messages are listed in the Sources panel "
      + numbered.map((entry) => `[${entry.n}]`).join("")
      + "."
    : "No browser LLM is available and the search found no matching messages. Try different terms.";
  setAnswer(turn, answer);
  setSummary(statusText(`Evidence only, ${turn.list.length} sources`));
}

function systemPrompt() {
  const tools = Object.values(TOOLS)
    .map((tool) => `- ${tool.usage}\n  ${tool.summary}`)
    .join("\n");

  return [
    "You are an assistant for the OpenMower Discord history archive.",
    "Answer the user's question using only evidence you retrieve with the tools below. Do not rely on outside knowledge for specifics.",
    "",
    "Work one step at a time. On every step output a SINGLE JSON object and nothing else.",
    "To call a tool:",
    '  {"tool": "<name>", "arguments": { ... }}',
    'You then receive an "Observation" listing numbered messages such as [1], [2].',
    "When you have enough evidence, output your final answer:",
    '  {"answer": "<answer text that cites sources like [1][2]>"}',
    "",
    "Guidance:",
    "- Search before answering specific questions; refine terms if the first search is weak.",
    "- Use get_context on a promising search hit to read the surrounding conversation before trusting it.",
    "- Cite every factual claim with the bracketed source numbers from the observations.",
    "- Source numbers are stable for the whole conversation; reuse the same number for the same message.",
    "- If the evidence does not answer the question, say so plainly in the answer.",
    "",
    "Tools:",
    tools,
  ].join("\n");
}

function parseAgentOutput(raw) {
  const obj = extractJsonObject(raw);
  if (obj && typeof obj === "object") {
    const toolName = normalizeToolName(obj.tool ?? obj.action ?? obj.name ?? obj.tool_name);
    const answer = firstDefined(obj.answer, obj.final, obj.final_answer, obj.response, obj.reply);

    if (toolName && TOOLS[toolName]) {
      return {
        kind: "tool",
        tool: toolName,
        arguments: obj.arguments ?? obj.args ?? obj.input ?? obj.parameters ?? {},
      };
    }
    if (answer != null) {
      return { kind: "answer", answer: String(answer).trim() };
    }
    if (toolName) {
      // Looks like a tool call for an unknown tool; surface the name.
      return { kind: "tool", tool: toolName, arguments: obj.arguments ?? obj.args ?? {} };
    }
  }

  // No usable JSON: treat the whole output as a direct prose answer.
  return { kind: "answer", answer: stripJsonWrapper(raw) };
}

function normalizeToolName(name) {
  if (!name) return null;
  const key = String(name).trim().toLowerCase().replace(/[\s-]+/g, "_");
  const aliases = {
    search: "search_messages",
    search_discord: "search_messages",
    searchmessages: "search_messages",
    messages: "search_messages",
    context: "get_context",
    getcontext: "get_context",
    conversation: "get_context",
    channel: "read_channel",
    readchannel: "read_channel",
    channel_range: "read_channel",
  };
  if (TOOLS[key]) return key;
  return aliases[key] || key;
}

function extractJsonObject(raw) {
  const text = String(raw || "");

  // Prefer fenced ```json blocks.
  const fenced = text.match(/```(?:json)?\s*([\s\S]*?)```/i);
  const candidates = [];
  if (fenced) candidates.push(fenced[1]);

  // Then scan for balanced top-level brace groups.
  for (const group of scanBraceGroups(text)) candidates.push(group);

  for (const candidate of candidates) {
    const parsed = tryParseJson(candidate);
    if (parsed && typeof parsed === "object") return parsed;
  }
  return null;
}

function scanBraceGroups(text) {
  const groups = [];
  let depth = 0;
  let start = -1;
  let inString = false;
  let escape = false;

  for (let i = 0; i < text.length; i += 1) {
    const char = text[i];
    if (inString) {
      if (escape) escape = false;
      else if (char === "\\") escape = true;
      else if (char === '"') inString = false;
      continue;
    }
    if (char === '"') {
      inString = true;
    } else if (char === "{") {
      if (depth === 0) start = i;
      depth += 1;
    } else if (char === "}") {
      depth -= 1;
      if (depth === 0 && start >= 0) {
        groups.push(text.slice(start, i + 1));
        start = -1;
      }
    }
  }
  return groups;
}

function tryParseJson(text) {
  const trimmed = String(text).trim();
  try {
    return JSON.parse(trimmed);
  } catch {
    // Tolerate trailing commas and single quotes from small models.
    try {
      const relaxed = trimmed
        .replace(/,\s*([}\]])/g, "$1")
        .replace(/'/g, '"');
      return JSON.parse(relaxed);
    } catch {
      return null;
    }
  }
}

function stripJsonWrapper(raw) {
  const text = String(raw || "").trim();
  const obj = extractJsonObject(text);
  const answer = obj && firstDefined(obj.answer, obj.final, obj.final_answer, obj.response, obj.reply);
  if (answer != null) return String(answer).trim();
  return text
    .replace(/```(?:json)?/gi, "")
    .replace(/```/g, "")
    .trim() || "The model returned an empty answer.";
}

function formatObservation(toolName, numbered, result) {
  if (result.error) {
    return `Observation (${toolName}): ${result.error}`;
  }
  if (numbered.length === 0) {
    return `Observation (${toolName}): no messages found. Try different search terms or filters.`;
  }

  const lines = [`Observation (${toolName}): ${numbered.length} message(s)`];
  for (const { n, message } of numbered) {
    lines.push(
      `[${n}] id=${message.id} | ${formatDate(message.t)} | #${message.ch || "unknown"} | ${message.a || "unknown"}`,
    );
    lines.push(shorten(message.text || "(no text)", 260));
  }
  return lines.join("\n");
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
      async chat(messages) {
        return promptBuiltInModel(model, flattenMessages(messages));
      },
    };
  }

  if (kind === "webllm") {
    const engine = await createWebLLMEngine(mode.webllmModel, note);
    if (!engine) return null;
    return {
      label: `WebLLM ${state.webllmModel}`,
      async chat(messages, { onDelta } = {}) {
        const chunks = await engine.chat.completions.create({
          messages,
          temperature: 0.2,
          max_tokens: 800,
          stream: true,
        });
        let out = "";
        for await (const chunk of chunks) {
          out += chunk.choices[0]?.delta?.content || "";
          onDelta?.(out);
        }
        return out.trim();
      },
    };
  }

  if (kind === "transformers") {
    const generator = await createTransformersGenerator(mode.transformersModel, note);
    if (!generator) return null;
    return {
      label: `Transformers.js ${state.transformersModel}`,
      async chat(messages) {
        const result = await generator(messages, {
          max_new_tokens: 512,
          temperature: 0.2,
          do_sample: false,
          return_full_text: false,
        });
        return extractGeneratedText(result).trim();
      },
    };
  }

  return null;
}

function flattenMessages(messages) {
  const body = messages
    .map((message) => `${message.role.toUpperCase()}: ${message.content}`)
    .join("\n\n");
  return `${body}\n\nASSISTANT:`;
}

function selectedAnswerMode() {
  const raw = els.answerMode.value || "auto";
  if (raw.startsWith("webllm:")) {
    return { engine: "webllm", webllmModel: raw.slice("webllm:".length), transformersModel: DEFAULT_TRANSFORMERS_MODEL };
  }
  if (raw.startsWith("transformers:")) {
    return { engine: "transformers", webllmModel: DEFAULT_WEBLLM_MODEL, transformersModel: raw.slice("transformers:".length) };
  }
  return { engine: raw, webllmModel: DEFAULT_WEBLLM_MODEL, transformersModel: DEFAULT_TRANSFORMERS_MODEL };
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
  state.webllmEngine = await state.webllm.CreateMLCEngine(selectedModel, {
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

function extractGeneratedText(result) {
  if (typeof result === "string") return result;
  if (Array.isArray(result)) {
    return result.map(extractGeneratedText).filter(Boolean).join("\n");
  }
  if (result && typeof result.generated_text === "string") {
    return result.generated_text;
  }
  if (result && Array.isArray(result.generated_text)) {
    return result.generated_text
      .map((message) => message?.content || "")
      .filter(Boolean)
      .join("\n");
  }
  return "";
}

// --- Tool implementations (static index access) -----------------------------

async function searchMessages(args) {
  const terms = tokenize(args.query);
  const scores = new Map();

  if (terms.length === 0) {
    for (let ordinal = state.manifest.messageCount - 1; ordinal >= 0 && scores.size < MAX_CANDIDATES; ordinal -= 1) {
      scores.set(ordinal, 0);
    }
  } else {
    for (const term of terms) {
      const postings = await postingsForTerm(term);
      const weight = term.includes(".") || term.includes("_") || term.includes("-") ? 2 : 1;
      for (const ordinal of postings) {
        scores.set(ordinal, (scores.get(ordinal) || 0) + weight);
      }
    }
  }

  const candidates = [...scores.entries()]
    .sort((left, right) => right[1] - left[1] || right[0] - left[0])
    .slice(0, MAX_CANDIDATES);

  const messages = [];
  for (const [ordinal, score] of candidates) {
    const message = await messageForOrdinal(ordinal);
    if (message && matchesFilters(message, args)) {
      messages.push({ message, score });
    }
    if (messages.length >= (args.limit || MAX_RESULTS)) break;
  }

  return messages;
}

async function getConversationContext(args) {
  const centerTime = Date.parse(args.centerTimestamp || 0);
  if (!Number.isFinite(centerTime)) return [];

  const fromTime = centerTime - args.minutesBefore * 60 * 1000;
  const toTime = centerTime + args.minutesAfter * 60 * 1000;
  const start = Math.max(0, args.centerOrdinal - CONTEXT_ORDINAL_SCAN);
  const end = Math.min(state.manifest.messageCount - 1, args.centerOrdinal + CONTEXT_ORDINAL_SCAN);
  const matches = [];

  for (let ordinal = start; ordinal <= end; ordinal += 1) {
    const message = await messageForOrdinal(ordinal);
    if (!message) continue;
    if (!sameChannel(message, args)) continue;

    const messageTime = Date.parse(message.t || 0);
    if (!Number.isFinite(messageTime)) continue;
    if (messageTime < fromTime || messageTime > toTime) continue;

    matches.push({ message, distance: Math.abs(messageTime - centerTime) });
  }

  return matches
    .sort((left, right) => left.distance - right.distance)
    .slice(0, args.maxMessages)
    .map((entry) => entry.message)
    .sort((left, right) => Date.parse(left.t || 0) - Date.parse(right.t || 0));
}

async function getChannelRange(args) {
  const after = args.after ? Date.parse(args.after) : Number.NEGATIVE_INFINITY;
  const before = args.before ? Date.parse(`${args.before}T23:59:59`) : Number.POSITIVE_INFINITY;
  const messages = [];

  for (let ordinal = 0; ordinal < state.manifest.messageCount; ordinal += 1) {
    const message = await messageForOrdinal(ordinal);
    if (!message) continue;
    if (args.channel && !includes(message.ch, args.channel) && message.chId !== args.channel) continue;
    if (args.author && !includes(message.a, args.author) && message.aId !== args.author) continue;
    if (args.attachments && (!message.at || message.at.length === 0)) continue;

    const messageTime = Date.parse(message.t || 0);
    if (!Number.isFinite(messageTime) || messageTime < after || messageTime > before) continue;
    messages.push(message);
    if (messages.length >= (args.limit || 80)) break;
  }

  return messages;
}

function sameChannel(message, args) {
  if (args.channelId && message.chId) return message.chId === args.channelId;
  return message.ch === args.channelName;
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
    const records = await fetchJson(`${INDEX_ROOT}${shard.file}`);
    state.messageShards.set(shardIndex, records);
    for (const record of records) {
      if (record && record.id != null) state.seenById.set(String(record.id), record);
    }
  }

  return state.messageShards.get(shardIndex).find((message) => message.o === ordinal) || null;
}

function matchesFilters(message, args) {
  if (args.channel && !includes(message.ch, args.channel)) return false;
  if (args.author && !includes(message.a, args.author)) return false;
  if (args.after && Date.parse(message.t || 0) < Date.parse(args.after)) return false;
  if (args.before && Date.parse(message.t || 0) > Date.parse(`${args.before}T23:59:59`)) return false;
  if (args.attachments && (!message.at || message.at.length === 0)) return false;
  return true;
}

// --- Per-turn evidence ------------------------------------------------------

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

  const turn = { node, statusEl: status, traceEl: trace, bodyEl: null, list: [], byId: new Map() };
  node.addEventListener("click", () => setActiveTurn(turn));
  state.turns.push(turn);
  scrollTranscript();
  return turn;
}

function registerEvidence(turn, messages) {
  const out = [];
  for (const message of messages) {
    if (!message || message.id == null) continue;
    const id = String(message.id);
    let n = turn.byId.get(id);
    if (!n) {
      turn.list.push(message);
      n = turn.list.length;
      turn.byId.set(id, n);
    }
    out.push({ n, message });
  }
  return out;
}

function setActiveTurn(turn) {
  if (state.activeTurn === turn) return;
  state.activeTurn = turn;
  for (const node of els.transcript.querySelectorAll(".message.assistant")) {
    node.classList.toggle("active-turn", node === turn?.node);
  }
  renderActiveSources();
}

// --- Rendering: transcript --------------------------------------------------

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

// --- Rendering: sources side panel ------------------------------------------

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

// --- Small DOM helpers ------------------------------------------------------

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

// --- Misc helpers -----------------------------------------------------------

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

function includes(value, query) {
  return String(value || "").toLowerCase().includes(String(query).toLowerCase());
}

function clampNumber(value, fallback, min, max) {
  const number = Number(value);
  if (!Number.isFinite(number)) return fallback;
  return Math.min(max, Math.max(min, Math.round(number)));
}

function firstDefined(...values) {
  for (const value of values) {
    if (value !== undefined && value !== null) return value;
  }
  return undefined;
}

function stableStringify(value) {
  if (value && typeof value === "object" && !Array.isArray(value)) {
    return `{${Object.keys(value).sort().map((key) => `${key}:${stableStringify(value[key])}`).join(",")}}`;
  }
  return JSON.stringify(value);
}

function tail(text, max = 160) {
  const cleaned = String(text || "").replace(/\s+/g, " ").trim();
  return cleaned.length <= max ? cleaned : `...${cleaned.slice(cleaned.length - max)}`;
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
