import {
  streamChat,
  type ChatMessage,
  type ToolCall,
  type Usage,
} from "./sse.js";
import { UsageAccumulator } from "./tokens.js";
import type {
  AgentEventSink,
  ToolContext,
  ToolImpl,
  ToolRegistry,
} from "./types.js";
import { READONLY_TOOLS, type PermissionManager } from "./permissions.js";
import type { HookRunner } from "./hooks.js";

export interface RunAgentOptions {
  messages: ChatMessage[];
  systemPrompt: string;
  registry: ToolRegistry;
  permissions: PermissionManager;
  hooks?: HookRunner;
  apiKey: string;
  model: string;
  baseUrl?: string;
  maxTurns?: number;
  abort: AbortSignal;
  events: AgentEventSink;
  interactive: boolean;
  stream?: typeof streamChat;
  askUser?: ToolContext["askUser"];
  subagentRunner?: ToolContext["runSubagent"];
  scratchDir: string;
  sessionId: string;
  cwd: string;
  addDirRoots: string[];
  onNewMessage?: (message: ChatMessage) => Promise<void> | void;
}

export interface RunAgentResult {
  messages: ChatMessage[];
  usage: Usage;
  turns: number;
}

type StreamFn = typeof streamChat;

export function buildToolSummary(name: string, input: Record<string, unknown>): string {
  if (name === "Bash" && typeof input.command === "string") return input.command;
  if (typeof input.file_path === "string") return `${input.file_path}`;
  if (name === "WebFetch" && typeof input.url === "string") return input.url;
  if (name === "Grep" && typeof input.pattern === "string") return input.pattern;
  if (name === "Glob" && typeof input.pattern === "string") return input.pattern;
  const s = JSON.stringify(input);
  return s.length > 120 ? s.slice(0, 117) + "..." : s;
}

export async function runAgentTurns(o: RunAgentOptions): Promise<RunAgentResult> {
  const stream: StreamFn = o.stream ?? streamChat;
  const msgs: ChatMessage[] = [{ role: "system", content: o.systemPrompt }, ...o.messages];
  const usageAcc = new UsageAccumulator();
  const maxTurns = o.maxTurns ?? 50;
  let turns = 0;

  for (let turn = 1; turn <= maxTurns; turn++) {
    if (o.abort.aborted) {
      o.events({ type: "notice", text: "Interrupted" });
      break;
    }
    turns = turn;
    let assistant: { content: string | null; tool_calls: ToolCall[] };
    try {
      assistant = await stream(
        msgs,
        o.registry.defs(),
        {
          onText: (t) => o.events({ type: "text_delta", text: t }),
          onThinking: (t) => o.events({ type: "thinking_delta", text: t }),
          onUsage: (u) => {
            usageAcc.add(u);
            o.events({ type: "usage", usage: u });
          },
        },
        { apiKey: o.apiKey, model: o.model, baseUrl: o.baseUrl, signal: o.abort },
      );
    } catch (err) {
      if (o.abort.aborted) {
        o.events({ type: "notice", text: "Interrupted" });
        break;
      }
      const message = err instanceof Error ? err.message : String(err);
      o.events({ type: "error", message });
      throw err;
    }

    const assistantMsg: ChatMessage = { role: "assistant", content: assistant.content };
    if (assistant.tool_calls.length > 0) assistantMsg.tool_calls = assistant.tool_calls;
    msgs.push(assistantMsg);
    if (typeof assistant.content === "string" && assistant.content.length > 0) {
      o.events({ type: "assistant_message", text: assistant.content });
    }
    await o.onNewMessage?.(assistantMsg);

    if (assistant.tool_calls.length === 0) break;

    for (const call of assistant.tool_calls) {
      if (o.abort.aborted) {
        const interrupted = toolMessage(call, "[interrupted]");
        msgs.push(interrupted);
        await o.onNewMessage?.(interrupted);
        continue;
      }
      await executeToolCall(call, o, msgs);
    }
  }

  return { messages: msgs.slice(1), usage: usageAcc.totals(), turns };
}

function toolMessage(call: ToolCall, text: string): ChatMessage {
  return { role: "tool", tool_call_id: call.id, name: call.name, content: text };
}

async function executeToolCall(
  call: ToolCall,
  o: RunAgentOptions,
  msgs: ChatMessage[],
): Promise<void> {
  const pushToolMsg = async (message: ChatMessage): Promise<void> => {
    msgs.push(message);
    await o.onNewMessage?.(message);
  };
  let input: Record<string, unknown>;
  try {
    input = call.arguments.trim() === "" ? {} : (JSON.parse(call.arguments) as Record<string, unknown>);
  } catch (err) {
    const msg = `Invalid JSON arguments for ${call.name}: ${err instanceof Error ? err.message : String(err)}`;
    o.events({ type: "tool_start", callId: call.id, name: call.name, input: {} });
    o.events({ type: "tool_end", callId: call.id, name: call.name, output: msg, isError: true });
    await pushToolMsg(toolMessage(call, msg));
    return;
  }

  o.events({ type: "tool_start", callId: call.id, name: call.name, input });

  const tool: ToolImpl | undefined = o.registry.get(call.name);
  if (!tool) {
    const msg = `Unknown tool: ${call.name}`;
    o.events({ type: "tool_end", callId: call.id, name: call.name, output: msg, isError: true });
    await pushToolMsg(toolMessage(call, msg));
    return;
  }

  if (tool.validate) {
    const invalid = tool.validate(input);
    if (invalid) {
      o.events({ type: "tool_end", callId: call.id, name: call.name, output: invalid, isError: true });
      await pushToolMsg(toolMessage(call, invalid));
      return;
    }
  }

  let workingInput = input;

  if (o.hooks?.has("PreToolUse")) {
    const hookOutcome = await o.hooks.run("PreToolUse", {
      tool_name: call.name,
      tool_input: workingInput,
      tool_use_id: call.id,
    });
    if (hookOutcome.blocked) {
      const msg = `PreToolUse hook blocked ${call.name}: ${hookOutcome.reason ?? "no reason given"}`;
      o.events({ type: "tool_end", callId: call.id, name: call.name, output: msg, isError: true });
      await pushToolMsg(toolMessage(call, msg));
      return;
    }
    if (hookOutcome.decision === "deny") {
      const msg = `denied by hook: ${hookOutcome.reason ?? "no reason"}`;
      o.events({ type: "tool_end", callId: call.id, name: call.name, output: msg, isError: true });
      await pushToolMsg(toolMessage(call, msg));
      return;
    }
    if (hookOutcome.updatedInput) workingInput = hookOutcome.updatedInput;
    if (hookOutcome.context) o.events({ type: "notice", text: hookOutcome.context });
  }

  if (!READONLY_TOOLS.has(call.name)) {
    const decision = await o.permissions.decide(
      {
        toolName: call.name,
        summary: buildToolSummary(call.name, workingInput),
        input: workingInput,
        suggestRule: suggestRuleFor(call.name, workingInput),
      },
      { interactive: o.interactive },
    );
    if (decision.behavior === "deny") {
      const msg = `[Request denied: ${decision.message ?? "by user"}]`;
      o.events({ type: "tool_end", callId: call.id, name: call.name, output: msg, isError: true });
      await pushToolMsg(toolMessage(call, msg));
      return;
    }
    if (decision.updatedInput) workingInput = decision.updatedInput;
  }

  const ctx: ToolContext = {
    sessionId: o.sessionId,
    cwd: o.cwd,
    addDirRoots: o.addDirRoots,
    abort: o.abort,
    scratchDir: o.scratchDir,
    requestPermission: () => Promise.resolve({ behavior: "allow" }),
    askUser: o.askUser,
    runSubagent: o.subagentRunner,
  };

  let resultText: string;
  let isError = false;
  let images: Array<{ url: string }> | undefined;
  try {
    const res = await tool.run(workingInput, ctx);
    resultText = res.output;
    isError = res.isError === true;
    images = res.images;
  } catch (err) {
    resultText = err instanceof Error ? err.message : String(err);
    isError = true;
  }

  if (!isError && o.hooks?.has("PostToolUse")) {
    const hookOutcome = await o.hooks.run("PostToolUse", {
      tool_name: call.name,
      tool_input: workingInput,
      tool_result: resultText.slice(0, 2000),
    });
    if (hookOutcome.blocked) {
      resultText += `\nPostToolUse hook: ${hookOutcome.reason ?? "blocked"}`;
    } else if (hookOutcome.context) {
      o.events({ type: "notice", text: hookOutcome.context });
    }
  }

  const message: ChatMessage =
    images && images.length > 0
      ? {
          role: "tool",
          tool_call_id: call.id,
          name: call.name,
          content: [
            { type: "text", text: resultText },
            ...images.map((i) => ({ type: "image_url" as const, image_url: { url: i.url } })),
          ],
        }
      : toolMessage(call, resultText);
  await pushToolMsg(message);
  o.events({
    type: "tool_end",
    callId: call.id,
    name: call.name,
    output: resultText.length > 500 ? resultText.slice(0, 497) + "..." : resultText,
    isError,
  });
}

export function suggestRuleFor(name: string, input: Record<string, unknown>): string | null {
  switch (name) {
    case "Bash":
      if (typeof input.command !== "string") return null;
      return `Bash(${firstToken(input.command)})`;
    case "Edit":
    case "Write":
      return typeof input.file_path === "string" ? `${name}(${input.file_path})` : null;
    case "Read": {
      if (typeof input.file_path !== "string") return null;
      const dir = Math.max(input.file_path.lastIndexOf("/"), 0);
      return `Read(${input.file_path.slice(0, dir)}/**)`;
    }
    case "WebFetch":
      if (typeof input.url !== "string") return null;
      try {
        return `WebFetch(domain:${new URL(input.url).hostname})`;
      } catch {
        return null;
      }
    default:
      return null;
  }
}

function firstToken(command: string): string {
  return command.trim().split(/\s+/)[0] ?? command.trim();
}
