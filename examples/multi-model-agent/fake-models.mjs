// Stand-ins for provider SDK calls, so the sample runs without provider keys
// or spend. Each returns what the real SDK returns, trimmed to the fields the
// tracker reads, with fixed token counts so the stored costs are exact.

/** Anthropic Messages: `anthropic.messages.create(...)`. */
function anthropicMessage(id, model, text, inputTokens, outputTokens) {
  return {
    id,
    type: "message",
    role: "assistant",
    model,
    content: [{ type: "text", text }],
    stop_reason: "end_turn",
    usage: { input_tokens: inputTokens, output_tokens: outputTokens },
  };
}

/** Plans the research: Claude Opus 5.5, 2,000 in and 500 out. */
export async function plan(task, requestId) {
  const subtasks = Array.from(
    { length: task.subtasks },
    (_, i) => `${task.question}: angle ${i + 1}`,
  );
  return {
    subtasks,
    response: anthropicMessage(
      requestId,
      "claude-opus-5-5",
      subtasks.join("\n"),
      2000,
      500,
    ),
  };
}

/** Researches one subtask: OpenAI Chat Completions, gpt-5.4-mini, 3,000 in and 800 out. */
export async function research(subtask, requestId) {
  return {
    id: requestId,
    object: "chat.completion",
    model: "gpt-5.4-mini",
    choices: [
      { message: { role: "assistant", content: `Notes on ${subtask}` } },
    ],
    usage: { prompt_tokens: 3000, completion_tokens: 800 },
  };
}

/** Checks the notes for gaps: Claude Haiku 5.5, 4,000 in and 300 out. */
export async function review(requestId) {
  return anthropicMessage(
    requestId,
    "claude-haiku-5-5",
    "No gaps found.",
    4000,
    300,
  );
}

/** Writes the answer, with Claude Opus 5.5 or the cheaper Haiku: 5,000 in and 1,500 out. */
export async function write(model, requestId) {
  return anthropicMessage(requestId, model, "The answer.", 5000, 1500);
}
