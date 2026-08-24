import { streamChat, type ChatMessage, type Usage } from "./sse.js";

export function shouldCompact(tokensUsed: number, window: number, threshold = 0.9): boolean {
  if (window <= 0) return false;
  return tokensUsed >= window * threshold;
}

function serializeForSummary(messages: ChatMessage[], cap = 120_000): string {
  const lines: string[] = [];
  for (const m of messages) {
    const text =
      typeof m.content === "string"
        ? m.content
        : Array.isArray(m.content)
          ? m.content.map((p) => (p.type === "text" ? p.text : "[media]")).join(" ")
          : "";
    if (m.role === "user") {
      lines.push(`[user] ${text}`);
    } else if (m.role === "assistant") {
      if (text) lines.push(`[assistant] ${text}`);
      for (const tc of m.tool_calls ?? []) {
        lines.push(`[assistant tool_use] ${tc.name} ${tc.arguments.slice(0, 300)}`);
      }
    } else if (m.role === "tool") {
      lines.push(`[tool result] ${(typeof m.content === "string" ? m.content : "").slice(0, 500)}`);
    }
  }
  let out = lines.join("\n");
  if (out.length > cap) {
    const head = out.slice(0, cap * 0.6);
    const tail = out.slice(-cap * 0.4);
    out = head + "\n\n[...middle truncated for length...]\n\n" + tail;
  }
  return out;
}

export async function compactMessages(opts: {
  messages: ChatMessage[];
  apiKey: string;
  model: string;
  baseUrl?: string;
  abort?: AbortSignal;
  instructions?: string;
  stream?: typeof streamChat;
}): Promise<{ messages: ChatMessage[]; summary: string }> {
  const transcript = serializeForSummary(opts.messages);
  const systemPrompt = [
    "You compress coding-agent conversations into dense summaries for continuation.",
    "Preserve: the user's intent and goals, decisions made, exact file paths touched,",
    "commands run and their outcomes, open TODOs, errors hit, and concrete next steps.",
    "Write in terse bullet form. Do not greet or editorialize.",
  ].join(" ");
  const userContent =
    `Summarize the following conversation transcript.${opts.instructions ? ` Extra instructions: ${opts.instructions}` : ""}\n\n<transcript>\n${transcript}\n</transcript>`;
  const res = await (opts.stream ?? streamChat)(
    [
      { role: "system", content: systemPrompt },
      { role: "user", content: userContent },
    ],
    [],
    undefined,
    { apiKey: opts.apiKey, model: opts.model, baseUrl: opts.baseUrl, signal: opts.abort },
  );
  const summary = res.content ?? "";
  return {
    messages: [{ role: "user", content: `Conversation summary from automatic compaction:\n\n${summary}` }],
    summary,
  };
}

export function usageOf(u: Usage | undefined): number {
  return u?.total_tokens ?? (u?.prompt_tokens ?? 0) + (u?.completion_tokens ?? 0);
}
