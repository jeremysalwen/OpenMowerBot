// Fast unit tests for the agent's model-output handling. No model downloads.
//   node --test web/agent.test.mjs
//
// These lock in the bugs that caused the browser app to hallucinate instead of
// calling tools: (1) Transformers.js returns the whole chat array, so the old
// extractor concatenated the system prompt back into the parser; (2) native
// tool-call markup from different model families must parse; (3) small models
// emit placeholder args and leftover tool-call JSON that must not leak.
import { test } from "node:test";
import assert from "node:assert/strict";
import {
  extractGeneratedText,
  parseToolCalls,
  sanitizeArgs,
  cleanAnswer,
  stripThink,
  canonicalToolName,
  formatObservation,
  OBSERVATION_MAX_MESSAGES,
  runAgentTurn,
  toManualConversation,
} from "./agent.js";

const NAMES = new Set(["search_messages", "get_context", "read_channel"]);

test("extractGeneratedText returns only the final assistant message", () => {
  // Transformers.js chat shape: the whole conversation is returned.
  const result = [
    {
      generated_text: [
        { role: "system", content: 'EXAMPLE {"answer": "<placeholder>"}' },
        { role: "user", content: "What GPS module?" },
        { role: "assistant", content: '{"name":"search_messages","arguments":{"query":"gps"}}' },
      ],
    },
  ];
  const text = extractGeneratedText(result);
  assert.equal(text, '{"name":"search_messages","arguments":{"query":"gps"}}');
  assert.ok(!text.includes("placeholder"), "must not include the system prompt example");
});

test("extractGeneratedText handles a plain string", () => {
  assert.equal(extractGeneratedText([{ generated_text: "hello" }]), "hello");
});

test("parseToolCalls reads Qwen/Hermes <tool_call> tags", () => {
  const raw = '<think>reasoning</think>\n<tool_call>\n{"name":"search_messages","arguments":{"query":"rtk gps"}}\n</tool_call>';
  const calls = parseToolCalls(raw, NAMES);
  assert.deepEqual(calls, [{ name: "search_messages", arguments: { query: "rtk gps" } }]);
});

test("parseToolCalls reads Qwen 3.5 nested function tags", () => {
  const raw = `<tool_call>
<function=search_messages>
<parameter=query>
rtk gps module
</parameter>
<parameter=limit>
10
</parameter>
</function>
</tool_call>`;
  const calls = parseToolCalls(raw, NAMES);
  assert.deepEqual(calls, [{ name: "search_messages", arguments: { query: "rtk gps module", limit: 10 } }]);
});

test("parseToolCalls reads FunctionGemma native calls", () => {
  const raw = "<start_function_call>call:search_messages{query:<escape>rtk gps module<escape>,limit:10}<end_function_call>";
  const calls = parseToolCalls(raw, NAMES);
  assert.deepEqual(calls, [{ name: "search_messages", arguments: { query: "rtk gps module", limit: 10 } }]);
});

test("parseToolCalls reads JSON arrays inside tool tags", () => {
  const raw = '<tool_call>[{"name":"search_messages","arguments":{"query":"rtk gps"}}]</tool_call>';
  assert.deepEqual(parseToolCalls(raw, NAMES), [
    { name: "search_messages", arguments: { query: "rtk gps" } },
  ]);
});

test("parseToolCalls reads Phi and xLAM bare JSON arrays", () => {
  const phi = '<|tool_call|>[{"name":"search_messages","arguments":{"query":"phi gps"}}]<|/tool_call|>';
  const xlam = '[{"name":"search_messages","arguments":{"query":"xlam gps"}}]';
  assert.deepEqual(parseToolCalls(phi, NAMES)[0].arguments, { query: "phi gps" });
  assert.deepEqual(parseToolCalls(xlam, NAMES)[0].arguments, { query: "xlam gps" });
});

test("parseToolCalls reads Ministral 3 token-delimited calls", () => {
  const raw = '[TOOL_CALLS]search_messages[ARGS]{"query":"rtk receiver","limit":10}</s>';
  assert.deepEqual(parseToolCalls(raw, NAMES), [
    { name: "search_messages", arguments: { query: "rtk receiver", limit: 10 } },
  ]);
});

test("parseToolCalls narrowly recovers wrapperless Hermes calls", () => {
  const raw = 'search_messages{"name":"search_messages","arguments":{"query":"rtk gps"}}';
  assert.deepEqual(parseToolCalls(raw, NAMES), [
    { name: "search_messages", arguments: { query: "rtk gps" } },
  ]);
  assert.deepEqual(parseToolCalls(`Please use ${raw}`, NAMES), []);
});

test("parseToolCalls reads XML-attribute tool calls (small Llama manual mode)", () => {
  const raw = '<search_messages query="rtk gps module" limit="10"/>';
  const calls = parseToolCalls(raw, NAMES);
  assert.deepEqual(calls, [{ name: "search_messages", arguments: { query: "rtk gps module", limit: "10" } }]);
});

test("parseToolCalls reads Llama-style bare {name, parameters} JSON", () => {
  const raw = '{"name": "search_messages", "parameters": {"query": "gps module"}}';
  const calls = parseToolCalls(raw, NAMES);
  assert.deepEqual(calls, [{ name: "search_messages", arguments: { query: "gps module" } }]);
});

test("parseToolCalls reads fenced ```json tool calls and aliases", () => {
  const raw = '```json\n{"tool":"search","args":{"query":"x"}}\n```';
  const calls = parseToolCalls(raw, NAMES);
  assert.deepEqual(calls, [{ name: "search_messages", arguments: { query: "x" } }]);
});

test("parseToolCalls returns nothing for plain prose", () => {
  assert.deepEqual(parseToolCalls("I recommend the Ardusimple F9P.", NAMES), []);
});

test("parseToolCalls ignores calls in reasoning and prose examples", () => {
  assert.deepEqual(parseToolCalls('<think><tool_call>{"name":"search_messages","arguments":{"query":"x"}}</tool_call></think>hello', NAMES), []);
  assert.deepEqual(parseToolCalls('For example: {"name":"search_messages","arguments":{"query":"x"}}', NAMES), []);
  assert.deepEqual(parseToolCalls('<function=search_messages><parameter=query>x</parameter></function>', NAMES), []);
});

test("parseToolCalls ignores unknown tool names", () => {
  assert.deepEqual(parseToolCalls('{"name":"delete_everything","arguments":{}}', NAMES), []);
});

test("sanitizeArgs drops placeholder/sentinel values", () => {
  const out = sanitizeArgs({ query: "gps", channel: "None", author: "John Doe", after: "", limit: 1 });
  assert.deepEqual(out, { query: "gps", limit: 1 });
  // "None", "John Doe", and empty string removed; real values kept.
  assert.ok(!("channel" in out));
  assert.ok(!("author" in out));
  assert.ok(!("after" in out));
});

test("sanitizeArgs keeps real author/channel values", () => {
  const out = sanitizeArgs({ query: "gps", author: "clemens", channel: "rtk-gps" });
  assert.deepEqual(out, { query: "gps", author: "clemens", channel: "rtk-gps" });
});

test("sanitizeArgs drops the project name as a channel/author filter", () => {
  // Models echo the topic as a channel ("channel":"OpenMower"), which matches
  // off-topic forum-thread channels and starves the search; keep it in query.
  assert.deepEqual(sanitizeArgs({ query: "rtk gps", channel: "OpenMower" }), { query: "rtk gps" });
  assert.deepEqual(sanitizeArgs({ query: "rtk gps", channel: "#OpenMower" }), { query: "rtk gps" });
  assert.deepEqual(sanitizeArgs({ query: "rtk gps", author: "OpenMower" }), { query: "rtk gps" });
});

test("stripThink removes reasoning blocks", () => {
  assert.equal(stripThink("<think>secret</think>answer"), "answer");
  assert.equal(stripThink("<think>unterminated reasoning"), "");
});

test("formatObservation bounds the context to a focused top-N", () => {
  const numbered = Array.from({ length: 10 }, (_, i) => ({
    n: i + 1,
    message: { t: 0, ch: "rtk-gps", a: `user${i}`, text: `message body ${i}` },
  }));
  const out = formatObservation(numbered, {});
  const shown = out.split("\n").filter((l) => /^\[\d+\]/.test(l));
  assert.equal(shown.length, OBSERVATION_MAX_MESSAGES, "renders only the top N rows");
  assert.match(out, /10 message\(s\) found; showing the top 6:/);
  assert.match(out, /citing sources as \[n\]/, "keeps the grounded-synthesis footer");
});

test("cleanAnswer strips think blocks and tool-call markup", () => {
  const raw = '<think>plan</think>The module is the F9P [1]. <tool_call>{"name":"x"}</tool_call>';
  const out = cleanAnswer(raw);
  assert.ok(out.startsWith("The module is the F9P [1]."));
  assert.ok(!out.includes("tool_call"));
});

test("cleanAnswer strips FunctionGemma call markup", () => {
  const raw = "Answer [1]. <start_function_call>call:search_messages{query:<escape>gps<escape>}<end_function_call>";
  assert.equal(cleanAnswer(raw), "Answer [1].");
});

test("cleanAnswer normalizes prose citations to [n]", () => {
  assert.equal(cleanAnswer("Recommended in message 5 and source 6."), "Recommended in [5] and [6].");
});

test("cleanAnswer falls back when only markup/punctuation remains", () => {
  const out = cleanAnswer("}\n\n}");
  assert.match(out, /could not produce a grounded answer/i);
});

test("canonicalToolName resolves aliases against the valid set", () => {
  assert.equal(canonicalToolName("search", NAMES), "search_messages");
  assert.equal(canonicalToolName("Get-Context", NAMES), "get_context");
  assert.equal(canonicalToolName("unknown", NAMES), null);
});

test("runAgentTurn preserves native tool call ids in the tool result turn", async () => {
  const conversations = [];
  const engine = {
    label: "fake native engine",
    async chat(messages) {
      conversations.push(structuredClone(messages));
      if (conversations.length === 1) {
        return {
          content: "",
          toolCalls: [{ id: "call_native_123", name: "search_messages", arguments: { query: "rtk gps" } }],
        };
      }
      return { content: "The receiver is identified in [1].", toolCalls: [] };
    },
  };
  const tools = {
    search_messages: {
      schema: { type: "function", function: { name: "search_messages", parameters: { type: "object" } } },
      async run() {
        return { messages: [{ id: "1", t: 0, ch: "rtk-gps", a: "tester", text: "Use the F9P receiver." }] };
      },
    },
  };

  await runAgentTurn({ question: "Which receiver?", engine, tools, maxSteps: 2 });

  const assistant = conversations[1].find((message) => message.role === "assistant" && message.tool_calls);
  const result = conversations[1].find((message) => message.role === "tool");
  assert.equal(assistant.tool_calls[0].id, "call_native_123");
  assert.equal(result.tool_call_id, "call_native_123");
  assert.equal(result.name, "search_messages");
});

test("runAgentTurn gives tokenizer-template engines object tool arguments", async () => {
  const conversations = [];
  const engine = {
    label: "fake tokenizer engine",
    toolCallArguments: "object",
    async chat(messages) {
      conversations.push(structuredClone(messages));
      return conversations.length === 1
        ? { content: "", toolCalls: [{ name: "search_messages", arguments: { query: "rtk gps" } }] }
        : { content: "Grounded answer [1].", toolCalls: [] };
    },
  };
  const tools = {
    search_messages: {
      schema: { type: "function", function: { name: "search_messages", parameters: { type: "object" } } },
      async run() {
        return { messages: [{ id: "1", t: 0, ch: "rtk-gps", a: "tester", text: "Use the F9P receiver." }] };
      },
    },
  };

  await runAgentTurn({ question: "Which receiver?", engine, tools, maxSteps: 2 });

  const call = conversations[1].find((message) => message.tool_calls)?.tool_calls[0];
  assert.deepEqual(call.function.arguments, { query: "rtk gps" });
});

test("runAgentTurn parses native content when an API returns an empty tool_calls array", async () => {
  const seen = [];
  const engine = {
    label: "raw native API",
    async chat(messages) {
      seen.push(structuredClone(messages));
      return seen.length === 1
        ? {
            content: "<start_function_call>call:search_messages{query:<escape>rtk gps<escape>}<end_function_call>",
            toolCalls: [{ name: "search_messages", arguments: null }],
          }
        : { content: "Grounded [1].", toolCalls: [] };
    },
  };
  let ran = false;
  const tools = {
    search_messages: {
      schema: { type: "function", function: { name: "search_messages", parameters: { type: "object" } } },
      async run() {
        ran = true;
        return { messages: [{ id: "1", t: 0, ch: "rtk-gps", a: "tester", text: "F9P" }] };
      },
    },
  };

  await runAgentTurn({ question: "Which receiver?", engine, tools, maxSteps: 2 });
  assert.equal(ran, true);
});

test("toManualConversation renders Qwen 3.5's native text protocol", () => {
  const schemas = [{ type: "function", function: { name: "search_messages", parameters: { type: "object" } } }];
  const messages = [
    { role: "system", content: "Archive only." },
    { role: "user", content: "Find GPS." },
    {
      role: "assistant",
      content: "",
      tool_calls: [{ function: { name: "search_messages", arguments: '{"query":"rtk gps","limit":10}' } }],
    },
    { role: "tool", content: "one result" },
  ];

  const rendered = toManualConversation(messages, schemas, "qwen35");
  assert.match(rendered[0].content, /<tools>/);
  assert.match(rendered[2].content, /<function=search_messages>/);
  assert.match(rendered[2].content, /<parameter=query>\nrtk gps\n<\/parameter>/);
  assert.equal(rendered[3].content, "<tool_response>\none result\n</tool_response>");
});

test("toManualConversation renders Hermes native tool responses", () => {
  const schemas = [{ type: "function", function: { name: "search_messages", parameters: { type: "object" } } }];
  const rendered = toManualConversation([
    { role: "system", content: "Archive only." },
    { role: "tool", content: "one result" },
  ], schemas, "hermes");
  assert.match(rendered[0].content, /<tool_call>/);
  assert.equal(rendered[1].content, "<tool_response>\none result\n</tool_response>");
});

test("toManualConversation renders Phi-4 mini's native token protocol", () => {
  const schemas = [{ type: "function", function: { name: "search_messages", parameters: { type: "object" } } }];
  const rendered = toManualConversation([
    { role: "system", content: "Archive only." },
    { role: "assistant", content: "", tool_calls: [{ function: { name: "search_messages", arguments: '{"query":"gps"}' } }] },
    { role: "tool", content: "one result" },
  ], schemas, "phi4");
  assert.match(rendered[0].content, /<\|tool\|>\[/);
  assert.match(rendered[1].content, /<\|tool_call\|>\[/);
  assert.equal(rendered[2].content, "<|tool_response|>one result");
});
