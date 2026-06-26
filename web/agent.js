// DOM-free tool-calling agent using each engine's NATIVE tool-calling support.
//
// The model is given tools through the chat template (the standard function-
// calling path), not through a hand-written JSON protocol in the system
// prompt. WebLLM exposes OpenAI-style `tools`/`tool_calls`; Transformers.js
// renders the tools into the chat template and the model emits its native
// tool-call markup (e.g. Qwen's <tool_call>…</tool_call>), which we parse.
//
// The model drives the loop itself: there is no forced/synthetic first search.
// A strong system prompt instructs it to call search_messages before answering,
// and each tool result is fed back as a `tool` message with numbered sources.

import { MAX_RESULTS, clampNumber } from "./index-store.js";

export const AGENT_MAX_STEPS = 5;

// --- Tools -----------------------------------------------------------------

export function createTools(store) {
  return {
    search_messages: {
      schema: {
        type: "function",
        function: {
          name: "search_messages",
          description:
            "Full-text keyword search of the OpenMower Discord history archive. Returns real matching messages with id, timestamp, channel, author and a snippet. You have no built-in knowledge of OpenMower, so use this to find evidence before answering.",
          parameters: {
            type: "object",
            properties: {
              query: { type: "string", description: "Search keywords, e.g. 'rtk gps module'." },
              channel: { type: "string", description: "Optional channel name to restrict to." },
              author: { type: "string", description: "Optional author name to restrict to." },
              after: { type: "string", description: "Optional ISO date lower bound (YYYY-MM-DD)." },
              before: { type: "string", description: "Optional ISO date upper bound (YYYY-MM-DD)." },
              limit: { type: "number", description: "Max results (default 10)." },
            },
            required: ["query"],
          },
        },
      },
      async run(args) {
        const results = await store.searchMessages({
          query: String(args.query || ""),
          channel: args.channel,
          author: args.author,
          after: args.after,
          before: args.before,
          attachments: args.has_attachment ?? args.attachments,
          // Floor at 5: small models sometimes pass limit:1 and starve themselves.
          limit: clampNumber(args.limit, 10, 5, MAX_RESULTS),
        });
        return { messages: results.map((result) => result.message) };
      },
    },
    get_context: {
      schema: {
        type: "function",
        function: {
          name: "get_context",
          description:
            "Read the same-channel conversation surrounding a message id from an earlier search result, to understand it before trusting it.",
          parameters: {
            type: "object",
            properties: {
              message_id: { type: "string", description: "id of a message from a previous search result." },
              minutes_before: { type: "number", description: "Minutes of history before the message (default 45)." },
              minutes_after: { type: "number", description: "Minutes of history after the message (default 45)." },
            },
            required: ["message_id"],
          },
        },
      },
      async run(args) {
        const id = String(args.message_id ?? args.messageId ?? args.id ?? "");
        const center = store.seenById(id);
        if (!center) {
          return { messages: [], error: `unknown message_id "${id}". Use an id from a previous search result.` };
        }
        const messages = await store.getConversationContext({
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
      schema: {
        type: "function",
        function: {
          name: "read_channel",
          description:
            "Read messages from a named channel within a date range, in chronological order. Use when the question names a channel and time window.",
          parameters: {
            type: "object",
            properties: {
              channel: { type: "string", description: "Channel name or id." },
              after: { type: "string", description: "ISO date lower bound (YYYY-MM-DD)." },
              before: { type: "string", description: "ISO date upper bound (YYYY-MM-DD)." },
              author: { type: "string", description: "Optional author name." },
              limit: { type: "number", description: "Max messages (default 40)." },
            },
            required: ["channel"],
          },
        },
      },
      async run(args) {
        const messages = await store.getChannelRange({
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
}

export function toolSchemas(tools) {
  return Object.values(tools).map((tool) => tool.schema);
}

const TOOL_ALIASES = {
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

export function canonicalToolName(name, validNames) {
  if (!name) return null;
  const has = (key) => (validNames instanceof Set ? validNames.has(key) : Boolean(validNames?.[key]));
  const key = String(name).trim().toLowerCase().replace(/[\s-]+/g, "_");
  if (has(key)) return key;
  const alias = TOOL_ALIASES[key];
  return alias && has(alias) ? alias : null;
}

// --- System prompt ---------------------------------------------------------

export function systemPrompt() {
  return [
    "You are a retrieval assistant for the OpenMower Discord history archive.",
    "You have NO built-in knowledge about OpenMower. To answer any question you MUST call search_messages first and base your answer only on the returned messages, citing them like [1][2].",
    "Never answer from your own knowledge and never invent product names, people, numbers, links, or quotes.",
    "If the messages do not answer the question, say so.",
  ].join("\n");
}

// Manual tool-calling instructions for engines without native function calling
// (e.g. WebLLM models outside its Hermes-only `tools` allow-list). The tool
// schemas are described in the prompt and the model is asked to emit a single
// <tool_call> JSON object, which parseToolCalls() already understands.
export function manualToolInstructions(schemas) {
  const lines = [
    "",
    "You have these tools. To use one, output ONLY a single tool call on its own, exactly in this form and nothing else:",
    '<tool_call>{"name": "<tool>", "arguments": { ... }}</tool_call>',
    "Do not describe the call in prose; emit the <tool_call> block. After you receive the tool result you may call another tool or write the final answer with [n] citations.",
    "Pass ONLY the parameters you actually need. For a normal question use just the query, e.g.",
    '<tool_call>{"name": "search_messages", "arguments": {"query": "rtk gps module"}}</tool_call>',
    "Do NOT invent channel names, authors, or dates. Omit channel/author/after/before unless the user explicitly asked to restrict by them.",
    "",
    "Tools:",
  ];
  for (const schema of schemas) {
    const fn = schema.function || schema;
    const props = fn.parameters?.properties || {};
    const params = Object.entries(props)
      .map(([name, spec]) => `${name} (${spec.type}${(fn.parameters?.required || []).includes(name) ? ", required" : ""})`)
      .join(", ");
    lines.push(`- ${fn.name}: ${fn.description} Params: ${params || "none"}.`);
  }
  return lines.join("\n");
}

// Flatten a tool-style conversation (with assistant.tool_calls and role:"tool"
// messages) into plain system/user/assistant turns for a manual-mode engine
// whose chat template does not accept the tool role. The first system message
// gets the manual tool instructions appended.
export function toManualConversation(messages, schemas) {
  const out = [];
  let injected = false;
  for (const message of messages) {
    if (message.role === "system") {
      out.push({ role: "system", content: `${message.content}\n${manualToolInstructions(schemas)}` });
      injected = true;
    } else if (message.role === "tool") {
      out.push({ role: "user", content: `Tool result:\n${message.content}` });
    } else if (message.role === "assistant" && message.tool_calls?.length) {
      const calls = message.tool_calls
        .map((call) => `<tool_call>${JSON.stringify({ name: call.function.name, arguments: safeParse(call.function.arguments) })}</tool_call>`)
        .join("\n");
      out.push({ role: "assistant", content: message.content ? `${message.content}\n${calls}` : calls });
    } else {
      out.push({ role: message.role, content: message.content });
    }
  }
  if (!injected) out.unshift({ role: "system", content: manualToolInstructions(schemas).trim() });
  return out;
}

function safeParse(value) {
  if (value && typeof value === "object") return value;
  try {
    return JSON.parse(String(value || "{}"));
  } catch {
    return {};
  }
}

// --- Parsing native tool-call output (Transformers.js text path) ------------

export function stripThink(raw) {
  return String(raw || "")
    .replace(/<think>[\s\S]*?<\/think>/gi, "")
    .replace(/<think>[\s\S]*$/i, "")
    .trim();
}

// Extract tool calls from a model's raw text. Handles the common formats the
// supported models emit: Hermes/Qwen <tool_call>{...}</tool_call>, Llama-style
// {"name":...,"parameters":...} or {"name":...,"arguments":...}, and fenced
// ```json blocks. Returns [{ name, arguments }].
export function parseToolCalls(rawText, validNames) {
  const text = String(rawText || "");
  const calls = [];
  const seen = new Set();

  const push = (rawName, rawArgs) => {
    const name = canonicalToolName(rawName, validNames);
    if (!name) return;
    const args = coerceArgs(rawArgs);
    const sig = `${name}:${JSON.stringify(args)}`;
    if (seen.has(sig)) return;
    seen.add(sig);
    calls.push({ name, arguments: args });
  };

  // 1) Explicit <tool_call> tags (Qwen, Hermes, SmolLM2).
  const tagRe = /<tool_call>\s*([\s\S]*?)\s*<\/tool_call>/gi;
  let m;
  let sawTag = false;
  while ((m = tagRe.exec(text))) {
    sawTag = true;
    const obj = tryParseJson(m[1]);
    if (obj) push(obj.name ?? obj.tool ?? obj.tool_name, obj.arguments ?? obj.parameters ?? obj.args);
  }
  if (sawTag && calls.length) return calls;

  // 1b) XML-attribute tool calls, e.g. small Llama models emit
  //     <search_messages query="rtk gps" limit="10"/> instead of JSON.
  const xmlRe = /<([a-z_][\w-]*)\b([^>]*?)\/?>/gi;
  while ((m = xmlRe.exec(text))) {
    const name = canonicalToolName(m[1], validNames);
    if (!name) continue;
    const args = {};
    const attrRe = /([\w-]+)\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s">]+))/g;
    let a;
    while ((a = attrRe.exec(m[2]))) {
      const value = a[2] ?? a[3] ?? a[4] ?? "";
      args[a[1]] = value;
    }
    push(name, args);
  }
  if (calls.length) return calls;

  // 2) Bare/fenced JSON objects that look like a tool call.
  for (const candidate of jsonCandidates(text)) {
    const obj = tryParseJson(candidate);
    if (!obj || typeof obj !== "object") continue;
    const name = obj.name ?? obj.tool ?? obj.tool_name ?? obj.function?.name;
    if (!name) continue;
    const args = obj.arguments ?? obj.parameters ?? obj.args ?? obj.function?.arguments;
    push(name, args);
  }
  return calls;
}

function coerceArgs(value) {
  if (value == null) return {};
  if (typeof value === "string") return tryParseJson(value) || {};
  if (typeof value === "object") return value;
  return {};
}

function jsonCandidates(text) {
  const candidates = [];
  const fenced = text.match(/```(?:json)?\s*([\s\S]*?)```/i);
  if (fenced) candidates.push(fenced[1]);
  for (const group of scanBraceGroups(text)) candidates.push(group);
  return candidates;
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
    if (char === '"') inString = true;
    else if (char === "{") {
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
    try {
      return JSON.parse(trimmed.replace(/,\s*([}\]])/g, "$1").replace(/'/g, '"'));
    } catch {
      return null;
    }
  }
}

// Clean prose answer: drop think blocks, tool-call markup, code fences, and any
// stray tool-call-shaped JSON the model may have emitted instead of prose.
export function cleanAnswer(raw) {
  let text = stripThink(raw)
    .replace(/<tool_call>[\s\S]*?<\/tool_call>/gi, "")
    .replace(/<\|[^|]*\|>/g, "")
    .replace(/```(?:json|tool_code)?/gi, "")
    .replace(/```/g, "");

  // Remove leftover tool calls written as JSON objects or parenthesized blobs
  // (small models sometimes emit these as the "answer").
  text = text
    .replace(/[{(][^{}()]*?["']?(?:name|tool|parameters|arguments)["']?\s*[:=][\s\S]*?[})]/gi, "")
    .replace(/[{}()]/g, " ")
    // Normalize prose references ("message 5", "source #2") into [n] citations
    // so the Sources panel can link them, without double-bracketing.
    .replace(/\b(?:messages?|sources?|msg|results?)\s*#?\s*(\d+)/gi, "[$1]")
    .replace(/\[\[(\d+)\]\]/g, "[$1]")
    .replace(/^[\s"'`)+]+/, "")
    .replace(/\n{3,}/g, "\n\n")
    .replace(/[ \t]{2,}/g, " ")
    .trim();

  // If nothing meaningful survives (model emitted only markup/punctuation),
  // fall back rather than showing fragments like "}" or quotes.
  if (!/[a-z0-9]/i.test(text)) {
    return "I could not produce a grounded answer. Check the Sources panel for the messages I found.";
  }
  return text;
}

// --- Engine output helpers (Transformers.js) -------------------------------

// Transformers.js chat pipelines return the WHOLE message array. Take only the
// final assistant message so we never feed the prompt back into the parser.
export function extractGeneratedText(result) {
  const item = Array.isArray(result) ? result[result.length - 1] : result;
  if (typeof item === "string") return item;
  const generated = item?.generated_text;
  if (typeof generated === "string") return generated;
  if (Array.isArray(generated)) {
    for (let i = generated.length - 1; i >= 0; i -= 1) {
      const message = generated[i];
      if (message && message.role === "assistant" && message.content) return String(message.content);
    }
    const last = generated[generated.length - 1];
    if (last && typeof last.content === "string") return last.content;
  }
  return "";
}

// Render the chat history into a flat prompt for the built-in (no-tools) model.
export function flattenMessages(messages) {
  const body = messages
    .map((message) => {
      if (message.role === "tool") return `OBSERVATION:\n${message.content}`;
      if (message.role === "assistant" && message.tool_calls) {
        return `ASSISTANT (calling tools): ${message.tool_calls
          .map((call) => `${call.function.name}(${call.function.arguments})`)
          .join(", ")}`;
      }
      return `${message.role.toUpperCase()}: ${message.content}`;
    })
    .join("\n\n");
  return `${body}\n\nASSISTANT:`;
}

// --- Observation formatting ------------------------------------------------

// How many messages (and how much of each) to put in the model's context. The
// browser runtimes are memory-constrained: feeding all 10 full snippets back
// every step crashes small models mid-run — Qwen3-0.6B on WASM throws
// std::bad_alloc and Llama-3.2-3B on WebGPU trips the OS GPU watchdog
// (DXGI_ERROR_DEVICE_HUNG). A focused top-N with shorter snippets keeps every
// step light; all retrieved messages are still registered for the Sources panel.
export const OBSERVATION_MAX_MESSAGES = 6;
const OBSERVATION_SNIPPET = 180;

export function formatObservation(numbered, result) {
  if (result.error) return `Error: ${result.error}`;
  if (!numbered.length) return "No messages found. Try different search terms or filters.";
  const shown = numbered.slice(0, OBSERVATION_MAX_MESSAGES);
  const more = numbered.length - shown.length;
  const header = more > 0
    ? `${numbered.length} message(s) found; showing the top ${shown.length}:`
    : `${numbered.length} message(s) found:`;
  const lines = [header];
  for (const { n, message } of shown) {
    lines.push(`[${n}] ${formatDate(message.t)} | #${message.ch || "unknown"} | ${message.a || "unknown"}: ${shorten(message.text || "(no text)", OBSERVATION_SNIPPET)}`);
  }
  // A directive at the decision point. Controlled tests showed small models
  // copy this list verbatim unless explicitly told to synthesise, and invent
  // product names when the messages don't actually answer the question. This
  // footer pushes for grounded prose or an honest "not found", with citations.
  lines.push("");
  lines.push(
    "Using ONLY the messages above, either call another tool for more detail, or write the final answer now: 2-4 sentences in your own words (do NOT copy or re-list the messages), citing sources as [n]. Name a specific product, number, or person only if a message above states it. The [n] labels and author names are citation markers, not products. If these messages do not actually answer the question, say so plainly.",
  );
  return lines.join("\n");
}

// --- The agent loop --------------------------------------------------------

// hooks: { setStatus, setSummary, startToolCall, finishToolCall, onEvidence, onAnswer }
export async function runAgentTurn({ question, engine, tools, hooks = {}, maxSteps = AGENT_MAX_STEPS }) {
  const schemas = toolSchemas(tools);
  const validNames = new Set(Object.keys(tools));
  const evidence = { list: [], byId: new Map() };

  const registerEvidence = (messages) => {
    const out = [];
    for (const message of messages || []) {
      if (!message || message.id == null) continue;
      const id = String(message.id);
      let n = evidence.byId.get(id);
      if (!n) {
        evidence.list.push(message);
        n = evidence.list.length;
        evidence.byId.set(id, n);
      }
      out.push({ n, message });
    }
    return out;
  };

  const runTool = async (name, args) => {
    const card = hooks.startToolCall?.(name, args);
    let result;
    try {
      result = await tools[name].run(args || {});
    } catch (error) {
      result = { messages: [], error: error.message };
    }
    const numbered = registerEvidence(result.messages || []);
    hooks.onEvidence?.(evidence.list);
    hooks.finishToolCall?.(card, name, args, result.error ? "error" : "done", numbered.length);
    const observation = formatObservation(numbered, result);
    hooks.onObservation?.(observation);
    return observation;
  };

  // Normalize an engine reply into { content, toolCalls }. WebLLM returns
  // structured tool_calls natively; text engines return raw text we parse.
  // Small models often fill optional params with placeholders ("None",
  // "John Doe", ...), so sentinel values are dropped before the tool runs.
  const readReply = (reply) => {
    const content = reply.content ?? reply.text ?? "";
    const rawCalls = reply.toolCalls ?? parseToolCalls(content, validNames);
    const toolCalls = rawCalls
      .filter((call) => tools[call.name])
      .map((call) => ({ name: call.name, arguments: sanitizeArgs(call.arguments) }));
    return { content, toolCalls };
  };

  const conversation = [
    { role: "system", content: systemPrompt() },
    { role: "user", content: question },
  ];
  const calledSignatures = new Set();

  for (let step = 1; step <= maxSteps; step += 1) {
    hooks.setSummary?.(`${engine.label}: step ${step}/${maxSteps}...`);
    hooks.setStatus?.("Thinking...");

    const reply = await engine.chat(conversation, {
      tools: schemas,
      onDelta: (text) => hooks.setStatus?.(`Thinking: ${tail(text)}`),
    });
    const { content, toolCalls } = readReply(reply);
    hooks.onModelOutput?.(content, step);

    if (!toolCalls.length) {
      const answer = cleanAnswer(content);
      hooks.onAnswer?.(answer, evidence.list);
      hooks.setSummary?.(`Answered in ${step} step${step === 1 ? "" : "s"}, ${evidence.list.length} sources`);
      return { answer, evidence: evidence.list };
    }

    // One tool call per step: most chat templates (e.g. Llama 3.2) only allow a
    // single tool call per assistant message, and it keeps the loop legible.
    // Strip the model's <think> scratch reasoning before storing it: a reasoning
    // model (Qwen3) emits a long think block that, re-fed every later step,
    // bloats the KV cache enough to OOM (std::bad_alloc) the WASM runtime.
    const call = toolCalls[0];
    conversation.push(assistantToolCalls(stripThink(content), [call]));
    const signature = signatureOf(call.name, call.arguments);
    if (calledSignatures.has(signature)) {
      conversation.push({ role: "tool", content: "You already ran that exact call. Use different arguments or answer now, citing the [n] sources you have." });
      continue;
    }
    calledSignatures.add(signature);
    conversation.push({ role: "tool", content: await runTool(call.name, call.arguments) });
  }

  // Budget exhausted: force a final prose answer from what we gathered.
  hooks.setStatus?.("Composing final answer...");
  conversation.push({
    role: "user",
    content: "Stop searching and answer now using only the messages already retrieved, citing them like [1][2].",
  });
  const reply = await engine.chat(conversation, { onDelta: (text) => hooks.setStatus?.(`Thinking: ${tail(text)}`) });
  const answer = cleanAnswer(reply.content ?? reply.text ?? "");
  hooks.onAnswer?.(answer, evidence.list);
  hooks.setSummary?.(`Answered (tool budget reached), ${evidence.list.length} sources`);
  return { answer, evidence: evidence.list };
}

function assistantToolCalls(content, calls) {
  return {
    role: "assistant",
    content: content || "",
    tool_calls: calls.map((call) => ({
      type: "function",
      function: { name: call.name, arguments: JSON.stringify(call.arguments || {}) },
    })),
  };
}

function signatureOf(name, args) {
  return `${name}:${stableStringify(args)}`;
}

// Small models frequently fill optional parameters with placeholder text rather
// than omitting them. Drop empty values and common sentinels so they are not
// applied as real search filters (e.g. channel="None" matching nothing).
const ARG_SENTINELS = new Set([
  "none", "null", "n/a", "na", "undefined", "string", "example", "<string>", "your_query_here",
  // Placeholder channel/author/date values small models invent when they fill
  // every optional parameter instead of omitting it.
  "john doe", "jane doe", "username", "author", "author_name", "channel", "channel_name", "#general", "general",
  "yyyy-mm-dd", "2020-01-01", "1970-01-01", "date",
]);
// Values to drop only for the channel/author filters. Models often echo the
// project name as a channel ("channel":"OpenMower"), which substring-matches
// off-topic forum-thread channels (e.g. "#OpenMower at long range…") and starves
// the real result, so treat the project name as a non-filter for these fields.
const FIELD_SENTINELS = {
  channel: new Set(["openmower", "open mower", "open-mower", "open_mower", "discord", "all", "any"]),
  author: new Set(["openmower", "open mower", "user", "me", "someone", "anyone", "everyone"]),
};
export function sanitizeArgs(args) {
  if (!args || typeof args !== "object") return {};
  const out = {};
  for (const [key, value] of Object.entries(args)) {
    if (value == null) continue;
    if (typeof value === "string") {
      const trimmed = value.trim();
      const lower = trimmed.toLowerCase().replace(/^#/, "");
      if (!trimmed || ARG_SENTINELS.has(lower)) continue;
      if (FIELD_SENTINELS[key]?.has(lower)) continue;
      out[key] = trimmed;
    } else {
      out[key] = value;
    }
  }
  return out;
}

export function stableStringify(value) {
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
