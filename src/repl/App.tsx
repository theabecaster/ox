import React, { useCallback, useEffect, useRef, useState } from "react";
import { Box, Text, useApp, useInput } from "ink";
import type { ChatMessage } from "../sse.js";
import type { AgentEvent, AskQuestion, PermissionRequest } from "../types.js";
import { runAgentTurns } from "../agent.js";
import { SessionStore } from "../sessions.js";
import { loadSubagents } from "../subagents.js";
import fs from "node:fs/promises";
import type { OxToolRegistry } from "../tools/index.js";
import type { PermissionManager } from "../permissions.js";
import type { HookRunner } from "../hooks.js";
import type { McpManager } from "../mcp.js";
import { renderSkill, type SkillDef } from "../skills.js";
import { MarkdownView } from "./markdown.js";
import { AskDialog, PermissionDialog, Spinner } from "./dialog.js";
import { compactMessages } from "../compaction.js";
import { runSubagent } from "../subagent-runner.js";
import { explainApiError } from "../errors.js";

type DisplayItem =
  | { kind: "user"; text: string }
  | { kind: "assistant"; text: string }
  | { kind: "tool"; id: string; name: string; summary: string; output?: string; isError?: boolean; expanded?: boolean }
  | { kind: "notice"; text: string }
  | { kind: "error"; text: string };

export interface ReplProps {
  cwd: string;
  model: string;
  apiKey: string;
  baseUrl: string;
  usingGateway: boolean;
  endpointSource: string;
  settings: Record<string, unknown>;
  session: SessionStore;
  registry: OxToolRegistry;
  permissions: PermissionManager;
  hooks: HookRunner;
  mcp: McpManager;
  skills: SkillDef[];
  memory: string;
  systemPrompt: string;
  initialMessages: ChatMessage[];
  initialPrompt?: string;
}

const MODE_LABELS: Record<string, string> = {
  default: "manual",
  acceptEdits: "accept edits",
  plan: "plan",
  bypassPermissions: "bypass",
};

export function Repl(props: ReplProps): React.ReactElement {
  const { exit } = useApp();
  const [items, setItems] = useState<DisplayItem[]>([]);
  const [input, setInput] = useState("");
  const [cursor, setCursor] = useState(0);
  const [busy, setBusy] = useState(false);
  const [streamText, setStreamText] = useState<string | null>(null);
  const [statusText, setStatusText] = useState<string>("");
  const [queue, setQueue] = useState<string[]>([]);
  const [permReq, setPermReq] = useState<PermissionRequest | null>(null);
  const [askReq, setAskReq] = useState<{ questions: AskQuestion[]; resolve: (a: Record<string, string>) => void } | null>(null);
  const [modeLabel, setModeLabel] = useState(MODE_LABELS[props.permissions.mode] ?? "manual");
  const [usageTokens, setUsageTokens] = useState(0);

  const msgsRef = useRef<ChatMessage[]>(props.initialMessages);
  const historyRef = useRef<string[]>([]);
  const histIdxRef = useRef<number>(-1);
  const abortRef = useRef<AbortController | null>(null);
  const busyRef = useRef(false);
  const streamBufRef = useRef("");
  const toolSummariesRef = useRef(new Map<string, string>());
  const queuedRunRef = useRef(false);

  const pendingPermResolveRef = useRef<((answer: { allow: boolean; persist?: "session" | "always"; message?: string }) => void) | null>(null);

  useEffect(() => {
    props.permissions.attachPrompter(async (req) => {
      return new Promise((resolve) => {
        setPermReq(req);
        pendingPermResolveRef.current = (answer) => {
          setPermReq(null);
          if (!answer.allow) {
            resolve({ behavior: "deny", message: answer.message ?? "denied by user" });
          } else {
            resolve({ behavior: "allow", persist: answer.persist });
          }
        };
      });
    });
  }, [props.permissions]);

  const pushItem = useCallback((item: DisplayItem) => {
    setItems((prev) => [...prev, item]);
  }, []);

  const runAgent = useCallback(
    async (prompt: string): Promise<void> => {
      setBusy(true);
      busyRef.current = true;
      setStatusText("");
      const ac = new AbortController();
      abortRef.current = ac;

      const subagentDepth = { n: 0 };
      const subagentDefs = await loadSubagents(props.cwd);

      const onEvent = (e: AgentEvent): void => {
        switch (e.type) {
          case "text_delta":
            streamBufRef.current += e.text;
            setStreamText(streamBufRef.current);
            break;
          case "tool_start":
            if (streamBufRef.current) {
              const t = streamBufRef.current;
              streamBufRef.current = "";
              setStreamText(null);
              pushItem({ kind: "assistant", text: t });
            }
            toolSummariesRef.current.set(e.callId, summarizeToolCall(e.name, e.input));
            pushItem({ kind: "tool", id: e.callId, name: e.name, summary: toolSummariesRef.current.get(e.callId) ?? "" });
            setStatusText(`${e.name}: ${(toolSummariesRef.current.get(e.callId) ?? "").slice(0, 60)}`);
            break;
          case "tool_end": {
            setItems((prev) =>
              prev.map((it) => (it.kind === "tool" && it.id === e.callId ? { ...it, output: e.output.slice(0, 400), isError: e.isError } : it)),
            );
            break;
          }
          case "usage":
            setUsageTokens((u) => u + (e.usage.total_tokens ?? 0));
            break;
          case "notice":
            pushItem({ kind: "notice", text: e.text });
            break;
          case "error":
            pushItem({ kind: "error", text: e.message });
            break;
          default:
            break;
        }
      };

      try {
        await props.session.appendMessage({ role: "user", content: prompt });
        const res = await runAgentTurns({
            messages: [...msgsRef.current, { role: "user" as const, content: prompt }],
            systemPrompt: props.systemPrompt,
            registry: props.registry,
            permissions: props.permissions,
            hooks: props.hooks,
            apiKey: props.apiKey,
            baseUrl: props.baseUrl,
            model: props.model,
            abort: ac.signal,
            events: onEvent,
            interactive: true,
            scratchDir: props.registry.shellState.scratchDir,
            sessionId: props.session.meta.id,
            cwd: props.cwd,
            addDirRoots: [],
            subagentRunner: async (req) => {
              if (subagentDepth.n >= 3) return "(subagent depth limit reached)";
              const defs = await subagentDefs;
              const defName = req.subagentType && defs.has(req.subagentType) ? req.subagentType : "general-purpose";
              const def = defs.get(defName)!;
              subagentDepth.n += 1;
              try {
                return await runSubagent({
                  prompt: req.prompt,
                  def,
                  parentRegistry: props.registry,
                  permissions: props.permissions,
                  apiKey: props.apiKey,
                  baseUrl: props.baseUrl,
                  model: req.model ?? props.model,
                  abort: ac.signal,
                  sessionId: props.session.meta.id,
                  cwd: props.cwd,
                  addDirRoots: [],
                  scratchDir: props.registry.shellState.scratchDir,
                  depth: subagentDepth.n,
                });
              } finally {
                subagentDepth.n -= 1;
              }
            },
            askUser: async (questions) => {
              return new Promise((resolve) => {
                setAskReq({ questions, resolve });
              });
            },
            onNewMessage: async (message) => {
              await props.session.appendMessage(message);
            },
        });
        msgsRef.current = res.messages;
      } catch (err) {
        pushItem({ kind: "error", text: explainApiError(err, { usingGateway: props.usingGateway, baseUrl: props.baseUrl }) });
      } finally {
        if (streamBufRef.current) {
          const t = streamBufRef.current;
          streamBufRef.current = "";
          setStreamText(null);
          pushItem({ kind: "assistant", text: t });
        }
        setBusy(false);
        busyRef.current = false;
        setStatusText("");
        abortRef.current = null;
      }
    },
    [props, pushItem],
  );

  const handleSubmit = useCallback(
    async (raw: string) => {
      const text = raw.trim();
      setInput("");
      setCursor(0);
      if (!text) return;
      historyRef.current.unshift(text);
      histIdxRef.current = -1;

      if (text.startsWith("/")) {
        const handled = await handleSlash(text);
        if (handled) return;
      }

      pushItem({ kind: "user", text });
      await runAgent(text);
    },

    [pushItem, runAgent],
  );

  useEffect(() => {
    if (!busy && queue.length > 0 && !queuedRunRef.current) {
      const next = queue[0]!;
      setQueue((q) => q.slice(1));
      void handleSubmit(next);
    }
  }, [busy, queue, handleSubmit]);

  const initialFiredRef = useRef(false);
  useEffect(() => {
    if (props.initialPrompt && !initialFiredRef.current && !busy) {
      initialFiredRef.current = true;
      void handleSubmit(props.initialPrompt);
    }
  }, [props.initialPrompt, busy, handleSubmit]);

  async function handleSlash(raw: string): Promise<boolean> {
    const space = raw.indexOf(" ");
    const cmd = (space === -1 ? raw : raw.slice(0, space)).slice(1).toLowerCase();
    const rest = space === -1 ? "" : raw.slice(space + 1).trim();

    switch (cmd) {
      case "help": {
        pushItem({
          kind: "assistant",
          text: [
            "## Ox commands",
            "",
            "- `/help` — this help",
            "- `/init` — analyze the repo and write an AGENTS.md",
            "- `/compact [instructions]` — summarize the conversation to free context",
            "- `/clear` — start a fresh conversation",
            "- `/model` — show active model",
            "- `/resume [id]` — list or load a previous session",
            "- `/permissions` — show permission mode and rules",
            "- `/memory` — show loaded project memory",
            "- `/config` — show effective configuration",
            "- `/status` — session status",
            "- `/cost` — token usage this session",
            "- `/add-dir <path>` — grant access to another directory",
            "- `/agents` — list available subagents",
            "- `/hooks` — list configured hooks",
            "- `/mcp` — MCP server status",
            "- `/doctor` — diagnose installation",
            "- `/export` — export the conversation to a file",
            "- `/exit` — quit (also Ctrl+C twice)",
            "",
            "Prefixes: `!command` runs a shell command directly; `@path` mentions a file.",
          ].join("\n"),
        });
        return true;
      }
      case "exit":
      case "quit": {
        exit();
        return true;
      }
      case "clear": {
        msgsRef.current = [];
        setItems([]);
        return true;
      }
      case "cost": {
        pushItem({ kind: "assistant", text: `Session tokens: ${usageTokens}` });
        return true;
      }
      case "model": {
        pushItem({ kind: "assistant", text: `Model: ${props.model}\nOverride with OX_MODEL env var.` });
        return true;
      }
      case "memory": {
        pushItem({ kind: "assistant", text: props.memory.trim() ? props.memory : "No AGENTS.md/OX.md found for this project." });
        return true;
      }
      case "permissions": {
        const p = props.permissions;
        pushItem({
          kind: "assistant",
          text: `Mode: ${MODE_LABELS[p.mode] ?? p.mode}\nAllow rules: ${[...(p as unknown as { allow: Set<string> }).allow ?? []].join(", ") || "none"}\nCycle modes with Shift+Tab.`,
        });
        return true;
      }
      case "agents": {
        const defs = await loadSubagents(props.cwd);
        const lines = [...defs.values()].map((d) => `- ${d.name}: ${d.description}`);
        pushItem({ kind: "assistant", text: `Subagents:\n${lines.join("\n")}` });
        return true;
      }
      case "hooks": {
        const hooksCfg = (props.settings.hooks ?? {}) as Record<string, Array<{ hooks?: Array<{ command: string }> }>>;
        const lines = Object.entries(hooksCfg).map(
          ([event, ms]) => `${event}: ${(ms ?? []).map((m) => (m.hooks ?? []).map((x) => x.command).join(", ")).join("; ")}`,
        );
        pushItem({ kind: "assistant", text: lines.length ? `Hooks:\n${lines.join("\n")}` : "No hooks configured." });
        return true;
      }
      case "mcp": {
        const st = props.mcp.status();
        const lines = st.map((s) => `- ${s.name} (${s.source}): ${s.status}${s.error ? ` — ${s.error}` : ""} — ${s.tools.length} tools`);
        pushItem({ kind: "assistant", text: lines.length ? `MCP servers:\n${lines.join("\n")}` : "No MCP servers configured (.ox/mcp.json or .mcp.json)." });
        return true;
      }
      case "add-dir": {
        if (!rest) {
          pushItem({ kind: "notice", text: "Usage: /add-dir <path>" });
          return true;
        }
        const abs = rest.startsWith("~") ? rest.replace("~", process.env.HOME ?? "") : rest;
        props.registry.updateRoots([...props.registry.rootsProvider(), abs]);
        pushItem({ kind: "notice", text: `Added working directory: ${abs}` });
        return true;
      }
      case "status": {
        pushItem({
          kind: "assistant",
          text: `Session ${props.session.meta.id}\nProject ${props.cwd}\nModel ${props.model}\nMode ${modeLabel}\nTools ${props.registry.names().length}\nTokens used ${usageTokens}`,
        });
        return true;
      }
      case "config": {
        pushItem({ kind: "assistant", text: `Settings files: ~/.ox/settings.json, .ox/settings.json, .ox/settings.local.json\nEffective:\n\`\`\`json\n${JSON.stringify(props.settings, null, 2)}\n\`\`\`` });
        return true;
      }
      case "doctor": {
        const lines = [
          `Ox CLI`,
          `Node ${process.version}`,
          `Endpoint: ${props.endpointSource} (${props.baseUrl})`,
          `Model: ${props.model}`,
          `Session dir: ~/.ox/projects`,
          `MCP servers: ${props.mcp.status().filter((s) => s.status === "connected").length}/${props.mcp.status().length} connected`,
        ];
        pushItem({ kind: "assistant", text: lines.join("\n") });
        return true;
      }
      case "export": {
        const text = await props.session.exportText();
        const file = `ox-export-${Date.now()}.md`;
        await fs.writeFile(file, text);
        pushItem({ kind: "notice", text: `Exported to ${file}` });
        return true;
      }
      case "resume": {
        if (rest) {
          const loaded = await SessionStore.load(rest, props.cwd);
          if (!loaded) {
            pushItem({ kind: "error", text: `Session not found: ${rest}` });
            return true;
          }
          msgsRef.current = loaded.entries.filter((e) => e.type === "message").map((e) => (e as { message: ChatMessage }).message);
          pushItem({ kind: "notice", text: `Resumed ${loaded.meta.title} (${msgsRef.current.length} messages)` });
          return true;
        }
        const list = await SessionStore.list(props.cwd, undefined, 10);
        const lines = list.map((s) => `${s.meta.id.slice(0, 8)}  ${s.meta.updatedAt.slice(0, 16)}  ${s.meta.title} (${s.messageCount} msgs)`);
        pushItem({ kind: "assistant", text: lines.length ? `Recent sessions:\n${lines.join("\n")}\n\nLoad one with /resume <id>` : "No sessions yet." });
        return true;
      }
      case "compact": {
        setBusy(true);
        try {
          const res = await compactMessages({
            messages: msgsRef.current,
            apiKey: props.apiKey,
            model: props.model,
            instructions: rest || undefined,
          });
          msgsRef.current = res.messages;
          pushItem({ kind: "notice", text: `Compacted to ${res.summary.length} chars of summary` });
        } catch (err) {
          pushItem({ kind: "error", text: `Compact failed: ${err instanceof Error ? err.message : err}` });
        } finally {
          setBusy(false);
        }
        return true;
      }
      case "init": {
        const initPrompt =
          "Analyze this codebase and create a concise AGENTS.md file at the repository root covering: build/test/lint commands, project structure overview, and code conventions you observed. Keep it under 60 lines. If an AGENTS.md already exists, improve it.";
        pushItem({ kind: "user", text: initPrompt });
        await runAgent(initPrompt);
        return true;
      }
      default: {
        const skill = props.skills.find((s) => s.name.toLowerCase() === cmd);
        if (skill) {
          const rendered = renderSkill(skill, rest);
          pushItem({ kind: "user", text: `/${cmd}${rest ? " " + rest : ""}` });
          await runAgent(rendered);
          return true;
        }
        pushItem({ kind: "error", text: `Unknown command: /${cmd} (try /help)` });
        return true;
      }
    }
  }

  useInput(
    (data, key) => {
      if (permReq || askReq) return;

      if (key.upArrow) {
        if (histIdxRef.current < historyRef.current.length - 1) {
          histIdxRef.current += 1;
          const h = historyRef.current[histIdxRef.current] ?? "";
          setInput(h);
          setCursor(h.length);
        }
        return;
      }
      if (key.downArrow) {
        if (histIdxRef.current > 0) {
          histIdxRef.current -= 1;
          const h = historyRef.current[histIdxRef.current] ?? "";
          setInput(h);
          setCursor(h.length);
        } else {
          histIdxRef.current = -1;
          setInput("");
          setCursor(0);
        }
        return;
      }
      if (key.leftArrow) {
        setCursor((c) => Math.max(0, c - 1));
        return;
      }
      if (key.rightArrow) {
        setCursor((c) => Math.min(input.length, c + 1));
        return;
      }
      if (key.tab && key.shift) {
        const m = props.permissions.cycleMode(true);
        setModeLabel(MODE_LABELS[m] ?? m);
        return;
      }
      if (key.return) {
        if (input.endsWith("\\")) {
          const next = input.slice(0, -1) + "\n";
          setInput(next);
          setCursor(next.length);
          return;
        }
        if (key.meta || data.includes("\n")) {
          /* multiline paste handled by data */
        }
        if (busy) {
          setQueue((q) => [...q, input.trim()].filter(Boolean));
          setInput("");
          setCursor(0);
          return;
        }
        void handleSubmit(input);
        return;
      }
      if (key.escape) {
        if (busy) {
          abortRef.current?.abort();
          pushItem({ kind: "notice", text: "Interrupting…" });
        } else if (input) {
          setInput("");
          setCursor(0);
        }
        return;
      }
      if (key.ctrl && data === "c") {
        if (busy) {
          abortRef.current?.abort();
          return;
        }
        if (input) {
          setInput("");
          setCursor(0);
          return;
        }
        exit();
        return;
      }
      if (key.backspace || key.delete) {
        if (cursor > 0) {
          const next = input.slice(0, cursor - 1) + input.slice(cursor);
          setInput(next);
          setCursor(cursor - 1);
        }
        return;
      }
      if (data === "j" && key.ctrl) {
        const next = input.slice(0, cursor) + "\n" + input.slice(cursor);
        setInput(next);
        setCursor(cursor + 1);
        return;
      }
      if (data && !key.ctrl && !key.meta) {
        const insert = data.endsWith("\r") ? data.slice(0, -1) + "\n" : data;
        const next = input.slice(0, cursor) + insert + input.slice(cursor);
        setInput(next);
        setCursor(cursor + insert.length);
      }
    },
    { isActive: !(permReq !== null || askReq !== null) },
  );

  const before = input.slice(0, cursor);
  const after = input.slice(cursor);

  return (
    <Box flexDirection="column" paddingX={1}>
      <Box flexDirection="column">
        {items.map((it, i) => {
          switch (it.kind) {
            case "user":
              return (
                <Box key={i} marginTop={1}>
                  <Text color="cyan" bold>
                    &gt;{" "}
                  </Text>
                  <Text color="white">{collapseNewlines(it.text)}</Text>
                </Box>
              );
            case "assistant":
              return (
                <Box key={i} marginTop={1}>
                  <MarkdownView content={it.text} />
                </Box>
              );
            case "tool":
              return (
                <Box key={i} marginLeft={1} marginTop={0}>
                  <Text color={it.isError ? "red" : "greenBright"}>
                    {it.isError ? "✘" : "⏺"} {it.name}
                  </Text>
                  <Text dimColor>({truncate(it.summary, 70)})</Text>
                  {it.output ? (
                    <Text dimColor>{truncate(it.output.split("\n")[0] ?? "", 90)}</Text>
                  ) : null}
                </Box>
              );
            case "notice":
              return (
                <Text key={i} color="yellowBright">
                  ⚠ {it.text}
                </Text>
              );
            case "error":
              return (
                <Text key={i} color="red">
                  ✖ {it.text}
                </Text>
              );
          }
        })}
      </Box>

      {streamText !== null ? (
        <Box marginTop={1}>
          <MarkdownView content={streamText} />
        </Box>
      ) : null}

      {permReq ? (
        <PermissionDialog
          request={permReq}
          onAnswer={(answer) => {
            const resolver = pendingPermResolveRef.current;
            pendingPermResolveRef.current = null;
            resolver?.(answer);
          }}
        />
      ) : null}

      {askReq ? (
        <AskDialog
          questions={askReq.questions}
          onAnswers={(answers) => {
            askReq.resolve(answers);
            setAskReq(null);
          }}
        />
      ) : null}

      <Box marginTop={1} borderStyle="round" borderColor={busy ? "gray" : "yellowBright"}>
        <Box flexDirection="row">
          <Text color="yellowBright">&gt; </Text>
          <Text wrap="wrap">{before}</Text>
          {!busy ? <Text inverse> </Text> : null}
          <Text wrap="wrap">{after}</Text>
        </Box>
      </Box>

      <Box justifyContent="space-between">
        <Box gap={2}>
          {busy ? <Spinner label={statusText || "thinking…"} /> : <Text> </Text>}
          {queue.length > 0 ? <Text dimColor>({queue.length} queued)</Text> : null}
        </Box>
        <Text dimColor>
          [{modeLabel}] {props.model} · {shortCwd(props.cwd)} · {usageTokens} tok · ? for /help
        </Text>
      </Box>
    </Box>
  );
}

function summarizeToolCall(name: string, input: Record<string, unknown>): string {
  if (typeof input.command === "string") return input.command;
  if (typeof input.file_path === "string") return input.file_path;
  if (typeof input.url === "string") return input.url;
  if (typeof input.pattern === "string") return input.pattern;
  const s = JSON.stringify(input);
  return s.length > 80 ? s.slice(0, 77) + "..." : s;
}

function truncate(s: string, n: number): string {
  return s.length > n ? s.slice(0, n - 1) + "…" : s;
}

function collapseNewlines(s: string): string {
  return s.length > 400 ? truncate(s.replace(/\n+/g, " "), 400) : s.replace(/\n+/g, " ");
}

function shortCwd(cwd: string): string {
  const home = process.env.HOME ?? "";
  return cwd.startsWith(home) ? "~" + cwd.slice(home.length) : cwd;
}
