// Stand-ins for provider SDK calls, so the sample runs without provider keys
// or spend. Each returns what the real SDK returns, trimmed to the fields the
// tracker reads, with fixed token counts so the stored costs are exact.

/** OpenAI Chat Completions: `openai.chat.completions.create(...)`. */
export async function classifyTicket(ticket, requestId) {
  if (ticket.failTriage) {
    // What the SDK throws when the provider is overloaded.
    throw Object.assign(new Error("503 The server is overloaded"), {
      status: 503,
    });
  }
  return {
    id: requestId,
    object: "chat.completion",
    model: "gpt-4.1",
    choices: [{ message: { role: "assistant", content: ticket.category } }],
    // 1,000 uncached input, 200 cached input and 80 output tokens.
    usage: {
      prompt_tokens: 1200,
      prompt_tokens_details: { cached_tokens: 200 },
      completion_tokens: 80,
    },
  };
}

/** Anthropic Messages, streamed: `anthropic.messages.stream(...)`. */
export async function* draftReply(ticket, requestId) {
  yield {
    type: "message_start",
    message: {
      id: requestId,
      type: "message",
      model: "claude-sonnet-5-5",
      content: [],
      // 500 uncached input tokens plus 2,500 read from the prompt cache.
      usage: {
        input_tokens: 500,
        cache_read_input_tokens: 2500,
        output_tokens: 1,
      },
    },
  };
  for (const text of [
    "Thanks for reaching out. ",
    `About "${ticket.subject}": `,
    "here's what to do.",
  ]) {
    yield {
      type: "content_block_delta",
      index: 0,
      delta: { type: "text_delta", text },
    };
  }
  // The final output count, cumulative.
  yield {
    type: "message_delta",
    delta: { stop_reason: "end_turn" },
    usage: { output_tokens: 300 },
  };
  yield { type: "message_stop" };
}

/** Gemini: `ai.models.generateContent(...)`. */
export async function summarizeThread(ticket, requestId) {
  return {
    responseId: requestId,
    modelVersion: "gemini-3.5-flash-lite",
    candidates: [{ content: { parts: [{ text: `Summary of ${ticket.id}` }] } }],
    usageMetadata: { promptTokenCount: 2000, candidatesTokenCount: 400 },
  };
}
