const INDEX_ROOT = "../data/index/browser/";
const WEBLLM_IMPORT_URL = "https://esm.run/@mlc-ai/web-llm";
const TRANSFORMERS_IMPORT_URL = "https://esm.run/@huggingface/transformers";
const DEFAULT_WEBLLM_MODEL = "Llama-3.2-1B-Instruct-q4f16_1-MLC";
const DEFAULT_TRANSFORMERS_MODEL = "onnx-community/SmolLM2-135M-Instruct-ONNX-MHA";
const APP_VERSION = "2026-06-26.5";
const MAX_RESULTS = 48;
const MAX_CANDIDATES = 900;
const ANSWER_EVIDENCE_LIMIT = 24;
const CONTEXT_QUERY_LIMIT = 240;
const CONTEXT_HIT_LIMIT = 4;
const CONTEXT_MESSAGES_PER_HIT = 12;
const CONTEXT_MINUTES_BEFORE = 45;
const CONTEXT_MINUTES_AFTER = 45;
const CONTEXT_ORDINAL_SCAN = 2500;
const AGENT_MAX_STEPS = 8;
const CHANNEL_RANGE_LIMIT = 80;

const state = {
  manifest: null,
  termBuckets: new Map(),
  messageShards: new Map(),
  webllm: null,
  webllmEngine: null,
  webllmModel: null,
  transformers: null,
  transformersGenerator: null,
  transformersModel: null,
  busy: false,
  turns: [],
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
  transformersModel: document.querySelector("#transformers-model"),
  composer: document.querySelector("#composer"),
  send: document.querySelector("#send"),
  summary: document.querySelector("#summary"),
  transcript: document.querySelector("#transcript"),
};

init().catch((error) => {
  setSummary(error.message);
  appendAssistantMessage("The browser index could not be loaded.", [], error.message);
});

async function init() {
  state.manifest = await fetchJson(`${INDEX_ROOT}manifest.json`);
  setSummary(statusText("Ready"));
  appendAssistantMessage(
    "Ask a question and I will use the Discord history tools iteratively before answering with cited sources.",
    [],
    "",
  );

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

  const assistantNode = appendAssistantMessage("Thinking about which Discord history tools to use...", [], "");

  try {
    const agentResult = await runAgentLoop(question, assistantNode);
    if (agentResult.evidence.length === 0) {
      updateAssistantMessage(assistantNode, agentResult.reason || "I could not find matching Discord messages for that question.", []);
      setSummary(statusText("No evidence found"));
      return;
    }

    setSummary(`Answering from ${agentResult.evidence.length} cited messages...`);
    const answer = await generateAnswer(question, agentResult.evidence, assistantNode);
    updateAssistantMessage(assistantNode, answer, agentResult.evidence);
    state.turns.push({ question, evidence: agentResult.evidence, observations: agentResult.observations });
    setSummary(statusText(`${agentResult.observations.length} tool steps, ${agentResult.evidence.length} cited`));
  } finally {
    setBusy(false);
  }
}

function normalizeQuestionForSearch(question) {
  const trimmed = question.trim();
  const withoutQuestionWords = trimmed
    .replace(/\b(what|when|where|who|why|how|does|did|is|are|was|were|can|could|would|should|please|tell|show|find|search|about|discord|history)\b/gi, " ")
    .replace(/\s+/g, " ")
    .trim();

  return (withoutQuestionWords || trimmed).slice(0, CONTEXT_QUERY_LIMIT);
}

async function runAgentLoop(question, assistantNode) {
  const memory = createAgentMemory(question);

  for (let step = 1; step <= AGENT_MAX_STEPS; step += 1) {
    const action = planNextAgentAction(memory);
    if (action.name === "final") {
      return {
        evidence: selectAgentEvidence(memory),
        observations: memory.observations,
        reason: action.reason,
      };
    }

    action.id = `${step}-${action.name}`;
    renderAgentThought(assistantNode, step, action.reason);
    renderToolProgress(assistantNode, action, "running", []);
    const observation = await executeAgentTool(action, memory);
    memory.observations.push(observation);
    renderToolProgress(assistantNode, action, "complete", observation.messages);

    if (observation.messages.length > 0) {
      addEvidence(memory, observation.messages, observation.type);
    }
  }

  return {
    evidence: selectAgentEvidence(memory),
    observations: memory.observations,
    reason: "The tool step budget was reached before enough evidence was found.",
  };
}

function createAgentMemory(question) {
  return {
    question,
    filters: {
      channel: els.channel.value.trim(),
      author: els.author.value.trim(),
      after: els.after.value,
      before: els.before.value,
      attachments: els.attachments.checked,
    },
    observations: [],
    searchResults: [],
    evidence: new Map(),
    contextedMessageIds: new Set(),
    searchedQueries: new Set(),
    channelRanges: new Set(),
  };
}

function planNextAgentAction(memory) {
  const filters = memory.filters;

  if (memory.observations.length === 0 && filters.channel && (filters.after || filters.before) && !normalizeQuestionForSearch(memory.question)) {
    return {
      name: "getChannelRange",
      reason: "The user supplied a channel/time range, so inspect that conversation directly before doing lexical search.",
      arguments: {
        channel: filters.channel,
        after: filters.after,
        before: filters.before,
        limit: CHANNEL_RANGE_LIMIT,
      },
    };
  }

  const primaryQuery = normalizeQuestionForSearch(memory.question);
  if (!memory.searchedQueries.has(primaryQuery)) {
    return {
      name: "searchDiscord",
      reason: "Find likely entry points in the Discord corpus.",
      arguments: {
        query: primaryQuery,
        ...filters,
        limit: MAX_RESULTS,
      },
    };
  }

  const uncontexted = memory.searchResults
    .map((result) => result.message)
    .filter((message) => !memory.contextedMessageIds.has(message.id))
    .slice(0, CONTEXT_HIT_LIMIT);

  if (uncontexted.length > 0) {
    const message = uncontexted[0];
    return {
      name: "getConversationContext",
      reason: "Open the same-channel conversation around a promising search hit before treating it as evidence.",
      arguments: {
        messageId: message.id,
        centerOrdinal: message.o,
        centerTimestamp: message.t,
        channelId: message.chId,
        channelName: message.ch,
        minutesBefore: CONTEXT_MINUTES_BEFORE,
        minutesAfter: CONTEXT_MINUTES_AFTER,
        maxMessages: CONTEXT_MESSAGES_PER_HIT,
      },
    };
  }

  if (memory.searchResults.length === 0 && !memory.searchedQueries.has(memory.question)) {
    return {
      name: "searchDiscord",
      reason: "The cleaned query had no hits, so try the original user wording.",
      arguments: {
        query: memory.question.slice(0, CONTEXT_QUERY_LIMIT),
        ...filters,
        limit: MAX_RESULTS,
      },
    };
  }

  const rangeKey = `${filters.channel}|${filters.after}|${filters.before}`;
  if (filters.channel && (filters.after || filters.before) && !memory.channelRanges.has(rangeKey)) {
    return {
      name: "getChannelRange",
      reason: "The filters define a channel/time range; inspect it as additional conversation context.",
      arguments: {
        channel: filters.channel,
        after: filters.after,
        before: filters.before,
        limit: CHANNEL_RANGE_LIMIT,
      },
    };
  }

  return {
    name: "final",
    reason: memory.evidence.size > 0
      ? "Enough retrieved conversation context is available to answer."
      : "No matching evidence was found after the available tool calls.",
    arguments: {},
  };
}

async function executeAgentTool(action, memory) {
  if (action.name === "searchDiscord") {
    const results = await searchMessages(action.arguments);
    memory.searchedQueries.add(action.arguments.query || "");
    memory.searchResults.push(...results);
    return {
      type: "search",
      name: action.name,
      messages: results.map((result) => result.message),
      resultCount: results.length,
    };
  }

  if (action.name === "getConversationContext") {
    const messages = await getConversationContext(action.arguments);
    if (action.arguments.messageId) {
      memory.contextedMessageIds.add(action.arguments.messageId);
    }
    return {
      type: "context",
      name: action.name,
      messages,
      resultCount: messages.length,
    };
  }

  if (action.name === "getChannelRange") {
    const messages = await getChannelRange(action.arguments);
    memory.channelRanges.add(`${action.arguments.channel}|${action.arguments.after}|${action.arguments.before}`);
    return {
      type: "range",
      name: action.name,
      messages,
      resultCount: messages.length,
    };
  }

  throw new Error(`Unknown agent tool: ${action.name}`);
}

function addEvidence(memory, messages, sourceType) {
  for (const message of messages) {
    const existing = memory.evidence.get(message.id);
    if (!existing) {
      memory.evidence.set(message.id, { message, sourceTypes: new Set([sourceType]) });
    } else {
      existing.sourceTypes.add(sourceType);
    }
  }
}

function selectAgentEvidence(memory) {
  return [...memory.evidence.values()]
    .sort((left, right) => {
      const leftContext = left.sourceTypes.has("context") || left.sourceTypes.has("range") ? 1 : 0;
      const rightContext = right.sourceTypes.has("context") || right.sourceTypes.has("range") ? 1 : 0;
      if (leftContext !== rightContext) return rightContext - leftContext;
      return (Date.parse(left.message.t || 0) || 0) - (Date.parse(right.message.t || 0) || 0);
    })
    .slice(0, ANSWER_EVIDENCE_LIMIT)
    .map((entry) => entry.message);
}

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
    if (messages.length >= (args.limit || CHANNEL_RANGE_LIMIT)) break;
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
    state.messageShards.set(shardIndex, await fetchJson(`${INDEX_ROOT}${shard.file}`));
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

async function generateAnswer(question, evidence, assistantNode) {
  const requested = els.engine.value;

  if (requested === "evidence") {
    return formatEvidenceAnswer(question, evidence);
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
        return `Built-in browser LLM failed: ${error.message}\n\n${formatEvidenceAnswer(question, evidence)}`;
      }
    }
    if (requested === "built-in") {
      return "The built-in browser LLM API is not available.\n\n" + formatEvidenceAnswer(question, evidence);
    }
  }

  if (requested === "webllm" || requested === "auto") {
    try {
      const webllm = await createWebLLMEngine(assistantNode);
      if (webllm) {
        setSummary("Answering with WebLLM...");
        return await promptWebLLM(webllm, question, evidence, assistantNode);
      }
    } catch (error) {
      updateAssistantMessage(assistantNode, `WebLLM failed: ${error.message}\n\nTrying Transformers.js instead.`, evidence);
    }
  }

  if (requested === "transformers" || requested === "webllm" || requested === "auto") {
    try {
      const generator = await createTransformersGenerator(assistantNode);
      if (generator) {
        setSummary("Answering with Transformers.js...");
        return await promptTransformers(generator, question, evidence);
      }
    } catch (error) {
      return `Transformers.js failed: ${error.message}\n\n${formatEvidenceAnswer(question, evidence)}`;
    }
  }

  return `No local browser LLM is available for engine "${requested}" with WebGPU ${hasWebGPU() ? "available" : "unavailable"}.\n\n`
    + formatEvidenceAnswer(question, evidence);
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

async function createWebLLMEngine(assistantNode) {
  if (!hasWebGPU()) {
    updateAssistantMessage(assistantNode, "WebLLM requires WebGPU. Trying the Transformers.js WASM fallback instead.", []);
    return null;
  }

  const selectedModel = els.webllmModel.value || DEFAULT_WEBLLM_MODEL;
  if (state.webllmEngine && state.webllmModel === selectedModel) {
    return state.webllmEngine;
  }

  setSummary("Loading WebLLM...");
  updateAssistantMessage(assistantNode, "Loading WebLLM. The first model download can take several minutes and is cached by the browser.", []);

  state.webllm = state.webllm || await import(WEBLLM_IMPORT_URL);
  state.webllmModel = selectedModel;
  state.webllmEngine = await state.webllm.CreateMLCEngine(selectedModel, {
    initProgressCallback: (progress) => {
      const text = progress?.text || "Loading WebLLM model...";
      const percent = Number.isFinite(progress?.progress)
        ? ` ${Math.round(progress.progress * 100)}%`
        : "";
      setSummary(`${text}${percent}`);
      updateAssistantMessage(assistantNode, `${text}${percent}`, []);
    },
  });

  return state.webllmEngine;
}

function hasWebGPU() {
  return Boolean(globalThis.navigator?.gpu);
}

async function createTransformersGenerator(assistantNode) {
  const selectedModel = els.transformersModel.value || DEFAULT_TRANSFORMERS_MODEL;
  if (state.transformersGenerator && state.transformersModel === selectedModel) {
    return state.transformersGenerator;
  }

  setSummary("Loading Transformers.js...");
  updateAssistantMessage(assistantNode, "Loading Transformers.js. The first model download can take several minutes and is cached by the browser. Firefox uses the WASM/CPU backend unless WebGPU is enabled.", []);

  state.transformers = state.transformers || await import(TRANSFORMERS_IMPORT_URL);
  state.transformersModel = selectedModel;
  state.transformersGenerator = await state.transformers.pipeline("text-generation", selectedModel, {
    dtype: "q4",
    progress_callback: (progress) => {
      const file = progress?.file ? ` ${progress.file}` : "";
      const percent = Number.isFinite(progress?.progress)
        ? ` ${Math.round(progress.progress)}%`
        : "";
      const status = progress?.status || "loading";
      setSummary(`Transformers.js ${status}${file}${percent}`);
    },
  });

  return state.transformersGenerator;
}

async function promptWebLLM(engine, question, evidence, assistantNode) {
  const chunks = await engine.chat.completions.create({
    messages: buildChatMessages(question, evidence),
    temperature: 0.2,
    max_tokens: 700,
    stream: true,
  });

  let answer = "";
  for await (const chunk of chunks) {
    answer += chunk.choices[0]?.delta?.content || "";
    updateAssistantMessage(assistantNode, answer || "Generating answer...", evidence);
  }

  return answer.trim() || "The local model returned an empty answer.";
}

async function promptTransformers(generator, question, evidence) {
  const prompt = buildPlainTextPrompt(question, evidence);
  const result = await generator(prompt, {
    max_new_tokens: 450,
    temperature: 0.2,
    do_sample: false,
    return_full_text: false,
  });

  return extractGeneratedText(result).trim() || "The local model returned an empty answer.";
}

function buildAnswerPrompt(question, messages) {
  const evidence = messages.map((message, index) => {
    return `[${index + 1}] ${message.t} #${message.ch} ${message.a}: ${message.text}\n${message.url || ""}`;
  }).join("\n\n");

  return [
    "Answer the user's question using only the Discord evidence below.",
    "The evidence was gathered through Discord history tools and may include search hits, same-channel surrounding conversation, and channel time ranges; use the surrounding context to avoid over-interpreting isolated messages.",
    "Cite claims with source numbers like [1] and include Discord links when useful.",
    "If the evidence is insufficient, say so.",
    "",
    `Question: ${question}`,
    "",
    "Evidence:",
    evidence,
  ].join("\n");
}

function buildPlainTextPrompt(question, evidence) {
  return [
    "Answer using only the Discord evidence below.",
    "The evidence was gathered through Discord history tools and may include search hits, same-channel surrounding conversation, and channel time ranges; read the surrounding messages before deciding what a hit means.",
    "Cite claims with source numbers like [1].",
    "If the evidence is insufficient, say so.",
    "",
    `Question: ${question || "(no question provided)"}`,
    "",
    "Evidence:",
    formatEvidenceForPrompt(evidence),
    "",
    "Answer:",
  ].join("\n");
}

function buildChatMessages(question, evidence) {
  return [
    {
      role: "system",
      content: "Answer using only the provided Discord evidence. The evidence was gathered through Discord history tools and may include search hits, same-channel surrounding conversation, and channel time ranges; read the surrounding messages before deciding what a hit means. Cite claims with source numbers like [1]. If the evidence is insufficient, say so.",
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
      `Discord URL: ${message.url || "none"}`,
      `Reply URL: ${message.replyUrl || "none"}`,
      `Attachments: ${formatAttachmentNames(message) || "none"}`,
      `Text: ${message.text || ""}`,
    ].join("\n");
  }).join("\n\n");
}

function formatEvidenceAnswer(question, messages) {
  const lines = [
    `I found ${messages.length} Discord messages related to: ${question}`,
    "",
  ];

  for (const [index, message] of messages.entries()) {
    const text = (message.text || "").replace(/\s+/g, " ").trim();
    lines.push(`[${index + 1}] ${message.t || "unknown"} #${message.ch || "unknown"} ${message.a || "unknown"}`);
    lines.push(text || "(no message text)");
    if (message.url) lines.push(message.url);
    lines.push("");
  }

  return lines.join("\n").trim();
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

function appendUserMessage(text) {
  const node = messageShell("user");
  const body = document.createElement("div");
  body.className = "message-body";
  body.textContent = text;
  node.append(body);
  els.transcript.append(node);
  scrollTranscript();
}

function appendAssistantMessage(text, evidence, note) {
  const node = messageShell("assistant");
  const body = document.createElement("div");
  body.className = "message-body";
  body.textContent = text;
  node.append(body);
  if (note) node.append(smallNote(note));
  if (evidence.length > 0) node.append(renderSources(evidence));
  els.transcript.append(node);
  scrollTranscript();
  return node;
}

function updateAssistantMessage(node, text, evidence) {
  let body = node.querySelector(".message-body");
  if (!body) {
    body = document.createElement("div");
    body.className = "message-body";
    node.prepend(body);
  }
  body.textContent = text;

  const oldSources = node.querySelector(".sources");
  if (oldSources) oldSources.remove();
  if (evidence.length > 0) node.append(renderSources(evidence));
  scrollTranscript();
}

function renderAgentThought(node, step, text) {
  let thought = node.querySelector(".agent-thought");
  if (!thought) {
    thought = document.createElement("div");
    thought.className = "agent-thought";
    node.append(thought);
  }

  const line = document.createElement("div");
  line.textContent = `Step ${step}: ${text}`;
  thought.append(line);
  scrollTranscript();
}

function renderToolProgress(node, toolCall, status, evidence) {
  let tool = node.querySelector(`[data-tool-id="${toolCall.id}"]`);
  if (!tool) {
    tool = document.createElement("details");
    tool.className = "tool-call";
    tool.dataset.toolId = toolCall.id;
    tool.open = true;
    node.append(tool);
  }

  const filters = [];
  if (toolCall.arguments.query) filters.push(`query:${toolCall.arguments.query}`);
  if (toolCall.arguments.channel) filters.push(`#${toolCall.arguments.channel}`);
  if (toolCall.arguments.author) filters.push(`author:${toolCall.arguments.author}`);
  if (toolCall.arguments.after) filters.push(`after:${toolCall.arguments.after}`);
  if (toolCall.arguments.before) filters.push(`before:${toolCall.arguments.before}`);
  if (toolCall.arguments.attachments) filters.push("has:attachment");
  if (toolCall.arguments.hits) filters.push(`${toolCall.arguments.hits} seed hits`);
  if (toolCall.arguments.channels?.length) filters.push(toolCall.arguments.channels.join(", "));
  if (toolCall.arguments.messageId) filters.push(`message:${toolCall.arguments.messageId}`);
  if (toolCall.arguments.channelName) filters.push(`#${toolCall.arguments.channelName}`);
  if (toolCall.arguments.minutesBefore) filters.push(`${toolCall.arguments.minutesBefore}m before`);
  if (toolCall.arguments.minutesAfter) filters.push(`${toolCall.arguments.minutesAfter}m after`);
  if (toolCall.arguments.limit) filters.push(`limit:${toolCall.arguments.limit}`);

  const label = status === "running"
    ? `Calling ${toolCall.name}...`
    : `${toolCall.name} returned ${evidence.length} messages`;

  tool.replaceChildren(
    summary(label),
    codeLine(filters.join(" | ") || "no arguments"),
  );
}

function renderSources(messages) {
  const section = document.createElement("section");
  section.className = "sources";

  const heading = document.createElement("h2");
  heading.textContent = "Sources";
  section.append(heading);

  for (const [index, message] of messages.entries()) {
    const item = document.createElement("article");
    item.className = "source";

    const meta = document.createElement("div");
    meta.className = "source-meta";
    meta.append(
      span(`[${index + 1}]`),
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
      const href = attachment.path ? `../${attachment.path}` : attachment.url;
      if (href) links.append(link(attachment.name || "attachment", href));
    }

    item.append(meta, content);
    if (links.childElementCount > 0) item.append(links);
    section.append(item);
  }

  return section;
}

function messageShell(role) {
  const node = document.createElement("article");
  node.className = `message ${role}`;
  return node;
}

function smallNote(text) {
  const note = document.createElement("p");
  note.className = "note";
  note.textContent = text;
  return note;
}

function summary(text) {
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
  appendAssistantMessage("Something went wrong while answering.", [], error.message);
  setBusy(false);
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

function shorten(text, maxLength) {
  const cleaned = String(text).replace(/\s+/g, " ").trim();
  if (cleaned.length <= maxLength) return cleaned;
  return `${cleaned.slice(0, maxLength - 1)}...`;
}

function formatAttachmentNames(message) {
  return (message.at || [])
    .map((attachment) => attachment.name)
    .filter(Boolean)
    .join(", ");
}

function formatDate(value) {
  if (!value) return "unknown time";
  return new Date(value).toLocaleString();
}

function scrollTranscript() {
  requestAnimationFrame(() => {
    window.scrollTo({ top: document.body.scrollHeight, behavior: "smooth" });
  });
}
