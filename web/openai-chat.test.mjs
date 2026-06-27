import { test } from "node:test";
import assert from "node:assert/strict";
import { openAiChat } from "./openai-chat.js";

const request = {
  baseUrl: "http://localhost:8080/v1",
  model: "test-model",
  messages: [{ role: "user", content: "search" }],
  tools: [{ type: "function", function: { name: "search_messages", parameters: { type: "object" } } }],
};

test("openAiChat reconstructs streamed native tool-call deltas", async () => {
  const events = [
    'data: {"choices":[{"delta":{"tool_calls":[{"index":0,"id":"call_7","type":"function","function":{"name":"search_messages","arguments":"{\\"query\\":"}}]}}]}',
    'data: {"choices":[{"delta":{"tool_calls":[{"index":0,"function":{"arguments":"\\"rtk gps\\"}"}}]}}]}',
    "data: [DONE]",
    "",
  ].join("\n");
  let sentBody;
  const result = await openAiChat({
    ...request,
    fetchImpl: async (_url, init) => {
      sentBody = JSON.parse(init.body);
      return new Response(events, { headers: { "content-type": "text/event-stream" } });
    },
  });

  assert.equal(sentBody.tool_choice, "auto");
  assert.deepEqual(result, {
    content: "",
    toolCalls: [{ id: "call_7", name: "search_messages", arguments: { query: "rtk gps" } }],
  });
});

test("openAiChat handles a non-streaming JSON response", async () => {
  const result = await openAiChat({
    ...request,
    tools: undefined,
    fetchImpl: async () => Response.json({ choices: [{ message: { content: "hello" } }] }),
  });
  assert.deepEqual(result, { content: "hello", toolCalls: [] });
});

test("openAiChat preserves malformed structured arguments as invalid", async () => {
  const result = await openAiChat({
    ...request,
    fetchImpl: async () => Response.json({
      choices: [{ message: { tool_calls: [{ id: "bad", function: { name: "search_messages", arguments: "{" } }] } }],
    }),
  });
  assert.equal(result.toolCalls[0].arguments, null);
});
