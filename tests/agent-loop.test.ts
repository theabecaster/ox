import { describe, expect, it } from "vitest";
import { runAgentTurns } from "../src/agent.js";
import { PermissionManager } from "../src/permissions.js";
import type { ApiOptions, ChatMessage, StreamCallbacks, ToolDef } from "../src/sse.js";
import type { AgentEvent, ToolRegistry } from "../src/types.js";
import type { RunAgentOptions } from "../src/agent.js";
import type { ToolImpl } from "../src/types.js";

type FakeStep = {
  content?: string | null;
  toolCalls?: Array<{ id: string; name: string; args?: Record<string, unknown>; rawArgs?: string }>;
};

function fakeStream(script: FakeStep[]) {
  let call = 0;
  const seenMessages: ChatMessage[][] = [];
  const stream = async (
    messages: ChatMessage[],
    _tools: ToolDef[],
    cb?: StreamCallbacks,
    _opts?: ApiOptions,
  ) => {
    seenMessages.push(structuredClone(messages));
    const step = script[call++]!;
    for (const tc of step.toolCalls ?? []) {
      cb?.onToolCallDelta?.(0, tc.id, tc.name, tc.rawArgs ?? JSON.stringify(tc.args ?? {}));
    }
    if (step.content) cb?.onText?.(step.content);
    cb?.onUsage?.({ prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 });
    return {
      content: step.content ?? null,
      tool_calls: (step.toolCalls ?? []).map((t) => ({
        id: t.id,
        name: t.name,
        arguments: t.rawArgs ?? JSON.stringify(t.args ?? {}),
      })),
      usage: { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 },
    };
    void _opts;
    void messages;
    void _tools;
  };
  return { stream: stream as unknown as typeof import("../src/sse.js").streamChat, seenMessages };
}

function registry(tools: ToolImpl[]): ToolRegistry {
  const map = new Map(tools.map((t) => [t.def.name, t]));
  return { get: (n) => map.get(n), names: () => [...map.keys()], defs: () => tools.map((t) => t.def) };
}

const echoTool: ToolImpl = {
  def: { name: "Echo", description: "echo", parameters: { type: "object", properties: { text: { type: "string" } }, required: ["text"] } },
  run: async (input) => ({ output: `echo:${String(input.text)}` }),
};

const boomTool: ToolImpl = {
  def: { name: "Boom", description: "throws", parameters: { type: "object", properties: {} } },
  run: async () => {
    throw new Error("kaput");
  },
};

function base(overrides: Partial<RunAgentOptions> = {}): { opts: RunAgentOptions; events: AgentEvent[] } {
  const events: AgentEvent[] = [];
  const perms = new PermissionManager({ cwd: "/repo" });
  perms.mode = "bypassPermissions";
  const opts: RunAgentOptions = {
    messages: [{ role: "user", content: "go" }],
    systemPrompt: "sys",
    registry: registry([echoTool, boomTool]),
    permissions: perms,
    apiKey: "k",
    model: "m",
    abort: new AbortController().signal,
    events: (e) => events.push(e),
    interactive: false,
    scratchDir: "/tmp",
    sessionId: "s",
    cwd: "/repo",
    addDirRoots: [],
    ...overrides,
  };
  return { opts, events };
}

describe("agent loop", () => {
  it("runs a tool turn then a final text turn", async () => {
    const { stream, seenMessages } = fakeStream([
      { toolCalls: [{ id: "t1", name: "Echo", args: { text: "hi" } }] },
      { content: "done" },
    ]);
    const { opts, events } = base({ stream });
    const res = await runAgentTurns(opts);
    expect(res.turns).toBe(2);
    expect(seenMessages[1]!.some((m) => m.role === "tool" && m.content === "echo:hi")).toBe(true);
    expect(events.filter((e) => e.type === "tool_start")).toHaveLength(1);
    expect(events.some((e) => e.type === "assistant_message")).toBe(true);
    expect(res.usage.total_tokens).toBe(30);
  });

  it("persists each message exactly once via onNewMessage", async () => {
    const { stream } = fakeStream([
      { toolCalls: [{ id: "t1", name: "Echo", args: { text: "x" } }] },
      { content: "ok" },
    ]);
    const persisted: string[] = [];
    const { opts } = base({ stream, onNewMessage: (m) => void persisted.push(m.role) });
    await runAgentTurns(opts);
    expect(persisted).toEqual(["assistant", "tool", "assistant"]);
  });

  it("invalid JSON arguments produce an error tool result without crashing", async () => {
    const { stream } = fakeStream([
      { toolCalls: [{ id: "bad", name: "Echo", rawArgs: "{not json" }] },
      { content: "recovered" },
    ]);
    const { opts, events } = base({ stream });
    const res = await runAgentTurns(opts);
    const ends = events.filter((e) => e.type === "tool_end") as Array<{ isError: boolean; output: string }>;
    expect(ends[0]!.isError).toBe(true);
    expect(ends[0]!.output).toContain("Invalid JSON");
    expect(res.turns).toBe(2);
  });

  it("unknown tool yields error result", async () => {
    const { stream } = fakeStream([
      { toolCalls: [{ id: "u1", name: "Nope" }] },
      { content: "fine" },
    ]);
    const { opts, events } = base({ stream });
    await runAgentTurns(opts);
    const ends = events.filter((e) => e.type === "tool_end") as Array<{ isError: boolean; output: string }>;
    expect(ends[0]!.isError).toBe(true);
    expect(ends[0]!.output).toContain("Unknown tool");
  });

  it("throwing tool is captured as error result", async () => {
    const { stream } = fakeStream([
      { toolCalls: [{ id: "b1", name: "Boom" }] },
      { content: "handled" },
    ]);
    const { opts, events } = base({ stream });
    await runAgentTurns(opts);
    const ends = events.filter((e) => e.type === "tool_end") as Array<{ isError: boolean }>;
    expect(ends[0]!.isError).toBe(true);
  });

  it("permission denial blocks the tool and continues", async () => {
    const perms = new PermissionManager({ cwd: "/repo" });
    const { stream } = fakeStream([
      { toolCalls: [{ id: "d1", name: "Echo", args: { text: "no" } }] },
      { content: "gave up" },
    ]);
    const { opts, events } = base({ stream, permissions: perms });
    const res = await runAgentTurns(opts);
    const ends = events.filter((e) => e.type === "tool_end") as Array<{ isError: boolean }>;
    expect(ends[0]!.isError).toBe(true);
    expect(res.messages.some((m) => m.role === "tool" && String(m.content).includes("[Request denied"))).toBe(true);
  });

  it("abort before first turn stops with notice", async () => {
    const ac = new AbortController();
    const { stream } = fakeStream([{ content: "one" }]);
    const { opts, events } = base({ stream, abort: ac.signal });
    ac.abort();
    const res = await runAgentTurns(opts);
    expect(events.some((e) => e.type === "notice")).toBe(true);
    expect(res.turns).toBeLessThanOrEqual(1);
  });
});
