import { spawn } from "node:child_process";
import type { Settings } from "./types.js";

export type HookEventName =
  | "SessionStart"
  | "SessionEnd"
  | "UserPromptSubmit"
  | "PreToolUse"
  | "PostToolUse"
  | "Stop";

export interface HookOutcome {
  blocked: boolean;
  reason?: string;
  context?: string;
  decision?: "allow" | "deny" | "ask";
  updatedInput?: Record<string, unknown>;
}

export const CONTEXT_EVENTS = new Set<HookEventName>(["UserPromptSubmit", "SessionStart"]);

interface HookCommand {
  command: string;
  timeout?: number;
}

export class HookRunner {
  private hooks: NonNullable<Settings["hooks"]>;

  constructor(hooks: Settings["hooks"], readonly cwd: string) {
    this.hooks = hooks ?? {};
  }

  has(event: HookEventName): boolean {
    return (this.hooks[event]?.length ?? 0) > 0;
  }

  async run(event: HookEventName, payload: Record<string, unknown>): Promise<HookOutcome> {
    const matchers = this.hooks[event] ?? [];
    let mergedContext = "";
    for (const m of matchers) {
      if (!matcherApplies(m.matcher, payload)) continue;
      for (const hook of m.hooks ?? []) {
        const cmd: HookCommand = { command: hook.command, timeout: hook.timeout };
        const outcome = await runOne(cmd, event, payload, this.cwd);
        if (outcome.blocked) return outcome;
        if (outcome.decision === "deny") {
          return { blocked: true, reason: outcome.reason, decision: outcome.decision, updatedInput: outcome.updatedInput };
        }
        if (outcome.decision) {
          return outcome;
        }
        if (outcome.context) {
          mergedContext += (mergedContext ? "\n" : "") + outcome.context;
        }
        if (outcome.updatedInput) {
          return { blocked: false, context: mergedContext || undefined, updatedInput: outcome.updatedInput };
        }
      }
    }
    return { blocked: false, context: mergedContext || undefined };
  }
}

function matcherApplies(matcher: string | undefined, payload: Record<string, unknown>): boolean {
  if (matcher === undefined || matcher === "" || matcher === "*") return true;
  const subject = String(payload.tool_name ?? payload.source ?? "");
  if (!subject) return matcher === "*";
  return matcher.split(/[|,]/).map((s) => s.trim()).includes(subject);
}

async function runOne(
  hook: HookCommand,
  event: HookEventName,
  payload: Record<string, unknown>,
  cwd: string,
): Promise<HookOutcome> {
  const inputJson = JSON.stringify({ hook_event_name: event, cwd, ...payload });
  const timeoutMs = Math.max(1, (hook.timeout ?? 30) * 1000);
  return new Promise((resolve) => {
    let settled = false;
    const finish = (o: HookOutcome) => {
      if (!settled) {
        settled = true;
        resolve(o);
      }
    };
    let child;
    try {
      child = spawn("bash", ["-lc", hook.command], {
        cwd,
        env: { ...process.env, OX_PROJECT_DIR: cwd },
        stdio: ["pipe", "pipe", "pipe"],
      });
    } catch (err) {
      finish({ blocked: false });
      void err;
      return;
    }
    const timer = setTimeout(() => {
      child.kill("SIGKILL");
      finish({ blocked: false });
    }, timeoutMs);

    let stdout = "";
    let stderr = "";
    child.stdout?.on("data", (d: Buffer) => {
      stdout += d.toString();
    });
    child.stderr?.on("data", (d: Buffer) => {
      stderr += d.toString();
    });
    child.on("error", () => {
      clearTimeout(timer);
      finish({ blocked: false });
    });
    child.on("close", (code) => {
      clearTimeout(timer);
      if (settled) return;
      settled = true;
      const outTrim = stdout.trim();
      if (code === 2) {
        resolve({ blocked: true, reason: (stderr.trim() || outTrim || "blocked by hook").slice(0, 2000) });
        return;
      }
      if (code === 0 && outTrim.startsWith("{")) {
        try {
          const parsed = JSON.parse(outTrim) as Record<string, unknown>;
          resolve(mapJsonOutcome(parsed));
          return;
        } catch {
          /* fall through */
        }
      }
      if (code === 0 && outTrim && CONTEXT_EVENTS.has(event)) {
        resolve({ blocked: false, context: outTrim.slice(0, 10_000) });
        return;
      }
      resolve({ blocked: false });
    });
    try {
      child.stdin?.write(inputJson + "\n");
      child.stdin?.end();
    } catch {
      /* ignore broken pipe */
    }
  });
}

function mapJsonOutcome(parsed: Record<string, unknown>): HookOutcome {
  const decisionField = parsed["decision"];
  const reason = typeof parsed["reason"] === "string" ? parsed["reason"] : undefined;
  const additionalContext =
    typeof parsed["additionalContext"] === "string" ? parsed["additionalContext"] : undefined;
  const hso = parsed["hookSpecificOutput"] as Record<string, unknown> | undefined;
  const permDecision = hso ? hso["permissionDecision"] : parsed["permissionDecision"];
  const permReason = hso
    ? hso["permissionDecisionReason"]
    : parsed["permissionDecisionReason"];
  const updatedInputRaw = hso
    ? hso["updatedInput"]
    : parsed["updatedInput"];
  const outcome: HookOutcome = {
    blocked: false,
    reason:
      typeof permReason === "string"
        ? permReason
        : reason,
    context: additionalContext,
  };
  if (decisionField === "block") {
    outcome.blocked = true;
    outcome.reason = reason;
    return outcome;
  }
  if (permDecision === "deny" || permDecision === "allow" || permDecision === "ask") {
    outcome.decision = permDecision;
    outcome.reason = typeof permReason === "string" ? permReason : undefined;
    if (permDecision === "deny") outcome.blocked = true;
  }
  if (updatedInputRaw && typeof updatedInputRaw === "object") {
    outcome.updatedInput = updatedInputRaw as Record<string, unknown>;
  }
  return outcome;
}
