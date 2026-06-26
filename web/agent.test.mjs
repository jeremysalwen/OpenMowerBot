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
