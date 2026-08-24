export type Role = "system" | "user" | "assistant" | "tool";

export interface ToolCall {
  id: string;
  name: string;
  arguments: string;
}

export interface TextContent {
  type: "text";
  text: string;
}

export interface ImageContent {
  type: "image_url";
  image_url: { url: string };
}

export type MessageContent = string | Array<TextContent | ImageContent>;

export interface ChatMessage {
  role: Role;
  content: MessageContent | null;
  tool_calls?: ToolCall[];
  tool_call_id?: string;
  name?: string;
}

export type JsonSchemaObject = Record<string, unknown>;

export interface ToolDef {
  name: string;
  description: string;
  parameters: JsonSchemaObject;
}

export interface Usage {
  prompt_tokens?: number;
  completion_tokens?: number;
  total_tokens?: number;
}

export interface StreamCallbacks {
  onText?: (delta: string) => void;
  onThinking?: (delta: string) => void;
  onToolCallDelta?: (index: number, id: string | undefined, name: string | undefined, argsDelta: string) => void;
  onUsage?: (usage: Usage) => void;
}

export interface ApiOptions {
  apiKey: string;
  model: string;
  baseUrl?: string;
  signal?: AbortSignal;
  maxTokens?: number;
  temperature?: number;
}

export class ApiError extends Error {
  status: number;
  retryable: boolean;
  constructor(status: number, message: string) {
    super(message);
    this.status = status;
    this.retryable = status === 0 || status === 429 || status === 408 || (status >= 500 && status < 600);
  }
}

const RETRY_BASE_MS = 800;
const RETRY_MAX_ATTEMPTS = 4;

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

/** Parse an SSE byte stream into events. */
export function createSseParser(onEvent: (data: string) => void): (chunk: string) => void {
  let buffer = "";
  return (chunk: string) => {
    buffer += chunk;
    let idx: number;
    while ((idx = buffer.indexOf("\n")) !== -1) {
      let line = buffer.slice(0, idx);
      buffer = buffer.slice(idx + 1);
      if (line.endsWith("\r")) line = line.slice(0, -1);
      if (line.startsWith("data:")) {
        const data = line.slice(5).trimStart();
        if (data === "[DONE]") continue;
        if (data.length > 0) onEvent(data);
      }
    }
  };
}

interface DeltaToolCall {
  index?: number;
  id?: string;
  function?: { name?: string; arguments?: string };
}

/**
 * Stream a chat completion from OpenRouter. Returns the assembled assistant message.
 * Retries with exponential backoff on retryable failures.
 */
export async function streamChat(
  messages: ChatMessage[],
  tools: ToolDef[],
  cb: StreamCallbacks | undefined,
  opts: ApiOptions,
): Promise<{ content: string | null; tool_calls: ToolCall[]; usage?: Usage }> {
  let attempt = 0;
  for (;;) {
    try {
      return await streamChatOnce(messages, tools, cb, opts);
    } catch (err) {
      if (opts.signal?.aborted) throw err;
      if (err instanceof ApiError && err.retryable && attempt < RETRY_MAX_ATTEMPTS - 1) {
        const delay = RETRY_BASE_MS * 2 ** attempt + Math.random() * 300;
        await sleep(delay);
        attempt++;
        continue;
      }
      throw err;
    }
  }
}

async function streamChatOnce(
  messages: ChatMessage[],
  tools: ToolDef[],
  cb: StreamCallbacks | undefined,
  opts: ApiOptions,
): Promise<{ content: string | null; tool_calls: ToolCall[]; usage?: Usage }> {
  const baseUrl = (opts.baseUrl ?? process.env.OX_BASE_URL ?? "https://openrouter.ai/api/v1").replace(/\/$/, "");
  const wireMessages = messages.map((m) => {
    if (!m.tool_calls || m.tool_calls.length === 0) return m;
    return {
      role: m.role,
      content: typeof m.content === "string" && m.content.length > 0 ? m.content : null,
      tool_calls: m.tool_calls.map((t) => ({ type: "function", id: t.id, name: undefined, function: { name: t.name, arguments: t.arguments } })),
    };
  });
  const body: Record<string, unknown> = {
    model: opts.model,
    messages: wireMessages,
    stream: true,
    stream_options: { include_usage: true },
  };
  if (tools.length > 0) body.tools = tools.map((t) => ({ type: "function", function: t }));
  body.max_tokens = opts.maxTokens ?? Number(process.env.OX_MAX_TOKENS ?? 32_000);
  if (opts.temperature !== undefined) body.temperature = opts.temperature;

  let res: Response;
  try {
    res = await fetch(`${baseUrl}/chat/completions`, {
      method: "POST",
      signal: opts.signal,
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${opts.apiKey}`,
        "HTTP-Referer": "https://github.com/theabecaster/ox",
        "X-Title": "Ox CLI",
      },
      body: JSON.stringify(body),
    });
  } catch (err) {
    if (opts.signal?.aborted) throw err;
    throw new ApiError(0, `network error reaching ${baseUrl}: ${err instanceof Error ? err.message : String(err)}`);
  }

  if (!res.ok || !res.body) {
    let detail = "";
    try {
      detail = (await res.text()).slice(0, 500);
    } catch {
      /* ignore */
    }
    throw new ApiError(res.status, `API error ${res.status}: ${detail || res.statusText}`);
  }

  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  const toolAcc = new Map<number, ToolCall>();
  let content = "";
  let usage: Usage | undefined;
  let sawNetworkError = false;

  const parse = createSseParser((data) => {
    try {
      const json = JSON.parse(data) as {
        choices?: Array<{
          delta?: {
            content?: string | null;
            reasoning?: string | null;
            tool_calls?: DeltaToolCall[];
          };
          finish_reason?: string | null;
        }>;
        usage?: Usage;
      };
      if (json.usage) {
        usage = json.usage;
        cb?.onUsage?.(json.usage);
      }
      const delta = json.choices?.[0]?.delta;
      if (!delta) {
        const finish = json.choices?.[0]?.finish_reason;
        if (finish === "network_error") {
          sawNetworkError = true;
        }
        return;
      }
      if (delta.reasoning) cb?.onThinking?.(delta.reasoning);
      if (delta.content) {
        content += delta.content;
        cb?.onText?.(delta.content);
      }
      if (delta.tool_calls) {
        for (const tc of delta.tool_calls) {
          const index = tc.index ?? 0;
          const cur =
            toolAcc.get(index) ?? { id: "", name: "", arguments: "" };
          if (tc.id) cur.id = tc.id;
          if (tc.function?.name) cur.name += tc.function.name;
          if (tc.function?.arguments) cur.arguments += tc.function.arguments;
          toolAcc.set(index, cur);
          cb?.onToolCallDelta?.(index, tc.id, tc.function?.name, tc.function?.arguments ?? "");
        }
      }
    } catch {
      /* ignore malformed keepalive lines */
    }
  });

  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      parse(decoder.decode(value, { stream: true }));
    }
  } catch (err) {
    if (opts.signal?.aborted) throw err;
    throw new ApiError(502, `stream interrupted before completion: ${err instanceof Error ? err.message : String(err)}`);
  }

  const toolCalls = [...toolAcc.entries()].sort(([a], [b]) => a - b).map(([, v]) => v);
  for (let i = 0; i < toolCalls.length; i++) {
    const tc = toolCalls[i]!;
    if (!tc.id) tc.id = `call_${i}`;
    if (!tc.name) tc.name = "unknown";
  }
  if (sawNetworkError) {
    throw new ApiError(503, "model provider network_error — transient upstream failure");
  }
  if (!content && toolCalls.length === 0 && !usage) {
    throw new ApiError(502, "empty completion stream from endpoint");
  }
  return { content: content.length > 0 ? content : null, tool_calls: toolCalls, usage };
}
