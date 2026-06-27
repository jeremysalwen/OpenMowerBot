// Independent native tool-calling conformance test for an OpenAI-compatible
// local server (llama.cpp, LM Studio, Ollama, etc.). This intentionally does
// not import the browser agent or its parsers.
//
//   node web/e2e/native-tool-test.mjs http://127.0.0.1:8081/v1 [model-id]
//
// Optional environment variables:
//   NATIVE_API_KEY, NATIVE_RESULT_FILE, NATIVE_TIMEOUT_MS

import { writeFile } from "node:fs/promises";
import { randomBytes } from "node:crypto";

const baseUrl = (process.argv[2] || "http://127.0.0.1:8081/v1").replace(/\/+$/, "");
const requestedModel = process.argv[3] || "";
const timeoutMs = Number(process.env.NATIVE_TIMEOUT_MS || 180000);
const resultFile = process.env.NATIVE_RESULT_FILE || "";
const stop = process.env.NATIVE_STOP || "";

const tool = {
  type: "function",
  function: {
    name: "search_messages",
    description: "Search the OpenMower message archive for evidence needed to answer the user's question.",
    parameters: {
      type: "object",
      properties: {
        query: { type: "string", description: "Short search terms." },
        limit: { type: "integer", description: "Maximum number of results." },
      },
      required: ["query"],
    },
  },
};

const report = {
  baseUrl,
  model: requestedModel,
  startedAt: new Date().toISOString(),
  tests: {},
  pass: false,
};

function headers() {
  const out = { "content-type": "application/json" };
  if (process.env.NATIVE_API_KEY) out.authorization = `Bearer ${process.env.NATIVE_API_KEY}`;
  return out;
}

async function request(path, options = {}) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  const started = performance.now();
  try {
    const response = await fetch(`${baseUrl}${path}`, {
      ...options,
      headers: { ...headers(), ...(options.headers || {}) },
      signal: controller.signal,
    });
    const text = await response.text();
    let json;
    try {
      json = JSON.parse(text);
    } catch {
      throw new Error(`HTTP ${response.status} returned non-JSON: ${text.slice(0, 500)}`);
    }
    if (!response.ok) throw new Error(`HTTP ${response.status}: ${JSON.stringify(json).slice(0, 1000)}`);
    return { json, elapsedMs: Math.round(performance.now() - started) };
  } finally {
    clearTimeout(timer);
  }
}

async function chat(body) {
  return request("/chat/completions", {
    method: "POST",
    body: JSON.stringify({
      chat_template_kwargs: { enable_thinking: false },
      ...(stop ? { stop: [stop] } : {}),
      ...body,
    }),
  });
}

function parseArguments(value) {
  if (value && typeof value === "object") return value;
  try {
    return JSON.parse(String(value || "{}"));
  } catch {
    return null;
  }
}

function compactResponse(response) {
  const message = response?.choices?.[0]?.message || {};
  return {
    finishReason: response?.choices?.[0]?.finish_reason ?? null,
    content: message.content ?? "",
    toolCalls: message.tool_calls ?? [],
    usage: response?.usage ?? null,
  };
}

function visibleContent(value) {
  return String(value || "")
    .replace(/<think>[\s\S]*?<\/think>/gi, "")
    .replace(/<think>[\s\S]*$/i, "")
    .trim();
}

function parseRawNativeCall(content) {
  const text = visibleContent(content);
  let match = /<start_function_call>\s*call:([\w.-]+)\s*\{([\s\S]*?)\}\s*<end_function_call>/i.exec(text);
  if (match) {
    const args = {};
    const argRe = /([\w.-]+)\s*:\s*(?:<escape>([\s\S]*?)<escape>|([^,}]*))(?:,|$)/g;
    let arg;
    while ((arg = argRe.exec(match[2]))) args[arg[1]] = (arg[2] ?? arg[3] ?? "").trim();
    return { protocol: "functiongemma", name: match[1], arguments: args };
  }

  const qwenTag = /<tool_call>\s*([\s\S]*?)\s*<\/tool_call>/i.exec(text);
  match = qwenTag && /<function\s*=\s*["']?([\w.-]+)["']?\s*>([\s\S]*?)<\/function>/i.exec(qwenTag[1]);
  if (match) {
    const args = {};
    const argRe = /<parameter\s*=\s*["']?([\w.-]+)["']?\s*>([\s\S]*?)<\/parameter>/gi;
    let arg;
    while ((arg = argRe.exec(match[2]))) args[arg[1]] = arg[2].trim();
    return { protocol: "qwen35", name: match[1], arguments: args };
  }

  match = /\[TOOL_CALLS\]\s*([^\[\]\s]+)\s*\[ARGS\]\s*(\{[^{}]*\})/i.exec(text);
  if (match) return { protocol: "ministral3", name: match[1], arguments: parseArguments(match[2]) || {} };

  const tagged = /(?:<tool_call>|<\|tool_call\|>)\s*([\s\S]*?)\s*(?:<\/tool_call>|<\|\/tool_call\|>)/i.exec(text);
  const candidate = tagged?.[1] || (/^\s*\[/.test(text) ? text.trim() : "");
  if (candidate) {
    try {
      const parsed = JSON.parse(candidate);
      const item = Array.isArray(parsed) ? parsed[0] : parsed;
      if (item?.name) return { protocol: tagged ? "tagged-json" : "json-array", name: item.name, arguments: item.arguments || {} };
    } catch {
      // Not a complete native JSON call.
    }
  }
  return null;
}

async function discoverModel() {
  if (requestedModel) return requestedModel;
  const { json } = await request("/models");
  const model = json?.data?.[0]?.id;
  if (!model) throw new Error("No model id was supplied and /models returned no models.");
  return model;
}

try {
  const model = await discoverModel();
  report.model = model;

  const initialMessages = [
    {
      role: "system",
      content: "Use the supplied tool whenever archive evidence is needed. Never invent an archive result. In the final answer, reproduce any evidence_code returned by the tool exactly.",
    },
    {
      role: "user",
      content: "Search the archive for the exact RTK receiver board people recommend. Do not answer until you use the tool.",
    },
  ];

  const first = await chat({
    model,
    messages: initialMessages,
    tools: [tool],
    tool_choice: "required",
    temperature: 0,
    max_tokens: 256,
  });
  const firstMessage = first.json?.choices?.[0]?.message || {};
  const structuredFirstCall = firstMessage.tool_calls?.[0];
  const rawFirstCall = structuredFirstCall ? null : parseRawNativeCall(firstMessage.content);
  const firstArgs = structuredFirstCall
    ? parseArguments(structuredFirstCall.function?.arguments)
    : rawFirstCall?.arguments;
  const nativeCall = Boolean(
    (structuredFirstCall?.function?.name || rawFirstCall?.name) === "search_messages"
    && firstArgs
    && typeof firstArgs.query === "string"
    && firstArgs.query.trim(),
  );
  report.tests.requiredCall = {
    pass: nativeCall,
    structured: Boolean(structuredFirstCall),
    nativeProtocol: rawFirstCall?.protocol || null,
    elapsedMs: first.elapsedMs,
    arguments: firstArgs,
    response: compactResponse(first.json),
  };
  if (!nativeCall) throw new Error("The required-call response did not contain a valid structured or raw native search_messages call.");

  const firstCall = structuredFirstCall || {
    id: "call_raw_native_1",
    type: "function",
    function: { name: rawFirstCall.name, arguments: JSON.stringify(firstArgs) },
  };
  const assistantCallMessage = structuredFirstCall
    ? firstMessage
    : { role: "assistant", content: "", tool_calls: [firstCall] };

  const evidenceCode = `OMB-${randomBytes(8).toString("hex")}`;
  const fixture = {
    messages: [{
      id: "fixture-1",
      channel: "rtk-gps",
      author: "fixture",
      content: `recommended_board=simpleRTK2B; receiver=u-blox ZED-F9P; evidence_code=${evidenceCode}`,
    }],
  };
  const second = await chat({
    model,
    messages: [
      ...initialMessages,
      assistantCallMessage,
      {
        role: "tool",
        tool_call_id: firstCall.id,
        name: firstCall.function.name,
        content: JSON.stringify(fixture),
      },
    ],
    tools: [tool],
    tool_choice: "auto",
    temperature: 0,
    max_tokens: 256,
  });
  const finalMessage = second.json?.choices?.[0]?.message || {};
  const finalVisibleContent = visibleContent(finalMessage.content);
  const grounded = finalVisibleContent.includes(evidenceCode)
    && /simpleRTK2B/i.test(finalVisibleContent)
    && /ZED-F9P/i.test(finalVisibleContent)
    && !(finalMessage.tool_calls?.length)
    && !parseRawNativeCall(finalMessage.content)
    && second.json?.choices?.[0]?.finish_reason === "stop";
  report.tests.toolResultGrounding = {
    pass: grounded,
    elapsedMs: second.elapsedMs,
    visibleContent: finalVisibleContent,
    response: compactResponse(second.json),
  };

  const noTool = await chat({
    model,
    messages: [
      { role: "system", content: "Use tools only when needed." },
      { role: "user", content: "Reply with exactly: hello" },
    ],
    tools: [tool],
    tool_choice: "auto",
    temperature: 0,
    max_tokens: 128,
  });
  const noToolMessage = noTool.json?.choices?.[0]?.message || {};
  const noToolVisibleContent = visibleContent(noToolMessage.content);
  const avoidedTool = !(noToolMessage.tool_calls?.length) && noToolVisibleContent.toLowerCase() === "hello";
  report.tests.autoNoTool = {
    pass: avoidedTool,
    elapsedMs: noTool.elapsedMs,
    visibleContent: noToolVisibleContent,
    response: compactResponse(noTool.json),
  };

  report.capabilities = {
    openAiStructuredPass: Boolean(report.tests.requiredCall.pass && report.tests.requiredCall.structured),
    nativeTextPass: Boolean(report.tests.requiredCall.pass),
    roundTripPass: Boolean(report.tests.toolResultGrounding.pass),
    autoRoutingPass: Boolean(report.tests.autoNoTool.pass),
  };
  report.pass = Object.values(report.capabilities).every(Boolean);
} catch (error) {
  report.error = String(error?.stack || error);
  report.pass = false;
} finally {
  report.capabilities ||= {
    openAiStructuredPass: Boolean(report.tests.requiredCall?.pass && report.tests.requiredCall?.structured),
    nativeTextPass: Boolean(report.tests.requiredCall?.pass),
    roundTripPass: Boolean(report.tests.toolResultGrounding?.pass),
    autoRoutingPass: Boolean(report.tests.autoNoTool?.pass),
  };
  report.finishedAt = new Date().toISOString();
  const output = `${JSON.stringify(report, null, 2)}\n`;
  process.stdout.write(output);
  if (resultFile) await writeFile(resultFile, output, "utf8");
  if (!report.pass) process.exitCode = 1;
}
