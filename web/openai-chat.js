// Small browser-safe OpenAI chat client with streamed native tool-call support.

export async function openAiChat({ baseUrl, model, apiKey, messages, tools, onDelta, fetchImpl = fetch }) {
  const headers = { "content-type": "application/json" };
  if (apiKey) headers.authorization = `Bearer ${apiKey}`;
  if (/anthropic\.com/.test(baseUrl)) headers["anthropic-dangerous-direct-browser-access"] = "true";

  const body = {
    model,
    messages,
    temperature: 0.2,
    max_tokens: 1024,
    stream: true,
  };
  if (tools?.length) {
    body.tools = tools;
    body.tool_choice = "auto";
  }

  let response;
  try {
    response = await fetchImpl(`${baseUrl}/chat/completions`, {
      method: "POST",
      headers,
      body: JSON.stringify(body),
    });
  } catch (error) {
    throw new Error(`Could not reach ${baseUrl} (network or CORS error). ${error.message}`);
  }

  if (!response.ok || !response.body) {
    const detail = await response.text().catch(() => "");
    throw new Error(`API request failed (HTTP ${response.status}). ${shorten(detail, 300)}`);
  }

  if (/application\/json/i.test(response.headers.get("content-type") || "")) {
    const json = await response.json();
    return normalizeMessage(json.choices?.[0]?.message || {});
  }

  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  const state = { content: "", calls: new Map() };
  let buffer = "";
  for (;;) {
    const { value, done } = await reader.read();
    if (done) break;
    buffer += decoder.decode(value, { stream: true });
    const lines = buffer.split("\n");
    buffer = lines.pop() || "";
    for (const line of lines) consumeSseLine(line, state, onDelta);
  }
  buffer += decoder.decode();
  if (buffer) consumeSseLine(buffer, state, onDelta);

  return {
    content: state.content.trim(),
    toolCalls: [...state.calls.values()].map(normalizeToolCall),
  };
}

function consumeSseLine(line, state, onDelta) {
  const trimmed = line.trim();
  if (!trimmed.startsWith("data:")) return;
  const payload = trimmed.slice(5).trim();
  if (!payload || payload === "[DONE]") return;
  let json;
  try {
    json = JSON.parse(payload);
  } catch {
    return;
  }
  const delta = json.choices?.[0]?.delta;
  if (!delta) return;
  if (typeof delta.content === "string") {
    state.content += delta.content;
    onDelta?.(state.content);
  }
  for (const part of delta.tool_calls || []) {
    const index = Number.isInteger(part.index) ? part.index : state.calls.size;
    const call = state.calls.get(index) || { id: "", type: "function", function: { name: "", arguments: "" } };
    if (part.id) call.id = part.id;
    if (part.type) call.type = part.type;
    if (part.function?.name) call.function.name += part.function.name;
    if (part.function?.arguments) call.function.arguments += part.function.arguments;
    state.calls.set(index, call);
  }
}

function normalizeMessage(message) {
  return {
    content: message.content || "",
    toolCalls: (message.tool_calls || []).map(normalizeToolCall),
  };
}

function normalizeToolCall(call) {
  return {
    id: call.id,
    name: call.function?.name,
    arguments: parseJsonArgs(call.function?.arguments),
  };
}

function parseJsonArgs(value) {
  if (value && typeof value === "object") return value;
  try {
    return JSON.parse(String(value || "{}"));
  } catch {
    return null;
  }
}

function shorten(text, max) {
  const value = String(text || "").replace(/\s+/g, " ").trim();
  return value.length <= max ? value : `${value.slice(0, max - 1)}…`;
}
