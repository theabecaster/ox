import path from "node:path";
import type { PermissionDecision, PermissionMode, PermissionRequest, Settings } from "./types.js";

export const READONLY_TOOLS = new Set([
  "Read",
  "Grep",
  "Glob",
  "WebFetch",
  "TodoWrite",
  "AskUserQuestion",
  "KillShell",
]);

export function ruleMatches(rule: string, toolName: string, input: Record<string, unknown>): boolean {
  const open = rule.indexOf("(");
  if (open === -1) {
    const bare = rule.trim();
    if (bare !== toolName) return false;
    if (bare === "Bash" || bare === "Read" || bare === "Edit" || bare === "WebFetch") return true;
    return true;
  }
  const name = rule.slice(0, open).trim();
  if (name !== toolName) return false;
  const close = rule.lastIndexOf(")");
  const spec = close > open ? rule.slice(open + 1, close) : "";
  return specifierMatches(name, spec, input);
}

function targetOf(toolName: string, input: Record<string, unknown>): string | null {
  switch (toolName) {
    case "Bash":
      return typeof input.command === "string" ? input.command : null;
    case "Read":
    case "Write":
    case "Edit":
    case "Grep":
    case "Glob":
      return typeof input.file_path === "string"
        ? input.file_path
        : typeof input.path === "string"
          ? input.path
          : null;
    case "WebFetch":
      return typeof input.url === "string" ? input.url : null;
    default:
      return null;
  }
}

function specifierMatches(toolName: string, spec: string, input: Record<string, unknown>): boolean {
  const target = targetOf(toolName, input);
  if (target === null) return spec === "" || spec === "*";
  if (toolName === "WebFetch") {
    if (spec.startsWith("domain:")) {
      try {
        const host = new URL(target).hostname;
        const wanted = spec.slice("domain:".length).toLowerCase();
        return host === wanted || host.endsWith("." + wanted);
      } catch {
        return false;
      }
    }
    return false;
  }
  if (toolName === "Bash") {
    if (spec.endsWith(" *")) {
      const base = spec.slice(0, -2);
      return target === base || target.startsWith(base + " ");
    }
    if (spec === "*") return true;
    return target.startsWith(spec);
  }
  return globMatch(spec, target);
}

export function globMatch(pattern: string, target: string): boolean {
  const norm = (s: string): string[] => s.replace(/^\.\//, "").split("/").filter((seg) => seg !== "" && seg !== ".");
  const p = norm(pattern);
  const s = norm(target);
  if (!pattern.includes("/")) {
    return segmentMatch(pattern, s[s.length - 1] ?? "");
  }
  return matchSegments(p, s);
}

function matchSegments(p: string[], s: string[]): boolean {
  if (p.length === 0) return s.length === 0;
  const head = p[0]!;
  if (head === "**") {
    if (p.length === 1) return true;
    for (let i = 0; i <= s.length; i++) {
      if (matchSegments(p.slice(1), s.slice(i))) return true;
    }
    return false;
  }
  if (s.length === 0) return false;
  if (!segmentMatch(head, s[0]!)) return false;
  return matchSegments(p.slice(1), s.slice(1));
}

function segmentMatch(pat: string, seg: string): boolean {
  if (pat === "*") return seg.length > 0;
  let rx = "";
  for (const ch of pat) {
    if (ch === "*") rx += "[^/]*";
    else if (ch === "?") rx += ".";
    else rx += ch.replace(/[.+^${}()|[\]\\]/g, "\\$&");
  }
  return new RegExp(`^${rx}$`).test(seg);
}

function resolveInsideRoots(p: string, roots: string[]): boolean {
  const abs = path.resolve(p);
  return roots.some((r) => abs === r || abs.startsWith(r + path.sep));
}

export interface PermissionPromptResult {
  behavior: "allow" | "deny";
  message?: string;
  updatedInput?: Record<string, unknown>;
  persist?: "session" | "always";
}

export class PermissionManager {
  mode: PermissionMode;
  private allow: Set<string>;
  private deny: Set<string>;
  private ask: Set<string>;
  readonly roots: string[];
  private onPersistRule?: (rule: string) => Promise<void> | void;
  private prompter?: (req: PermissionRequest) => Promise<PermissionPromptResult>;

  constructor(opts: {
    settings?: Partial<Settings>;
    cwd: string;
    addDirRoots?: string[];
    onPersistRule?: (rule: string) => Promise<void> | void;
    prompter?: (req: PermissionRequest) => Promise<PermissionPromptResult>;
  }) {
    this.mode = opts.settings?.permissions?.defaultMode ?? "default";
    this.allow = new Set(opts.settings?.permissions?.allow ?? []);
    this.deny = new Set(opts.settings?.permissions?.deny ?? []);
    this.ask = new Set(opts.settings?.permissions?.ask ?? []);
    this.roots = [path.resolve(opts.cwd), ...(opts.addDirRoots ?? []).map((r) => path.resolve(r))];
    this.onPersistRule = opts.onPersistRule;
    this.prompter = opts.prompter;
  }

  addSessionRule(rule: string): void {
    this.allow.add(rule);
  }

  checkRules(req: PermissionRequest): "allow" | "deny" | "ask" {
    for (const rule of this.deny) {
      if (ruleMatches(rule, req.toolName, req.input)) return "deny";
    }
    for (const rule of this.ask) {
      if (ruleMatches(rule, req.toolName, req.input)) return "ask";
    }
    for (const rule of this.allow) {
      if (ruleMatches(rule, req.toolName, req.input)) return "allow";
    }
    return "ask";
  }

  attachPrompter(p: (req: PermissionRequest) => Promise<PermissionPromptResult>): void {
    this.prompter = p;
  }

  async decide(
    req: PermissionRequest,
    opts: { interactive: boolean },
  ): Promise<PermissionDecision> {
    if (this.mode === "bypassPermissions") return { behavior: "allow" };
    const ruled = this.checkRules(req);
    if (ruled === "deny") return { behavior: "deny", message: "denied by permissions.deny rules" };
    if (ruled === "allow") return { behavior: "allow" };

    if (this.mode === "plan") {
      if (!READONLY_TOOLS.has(req.toolName)) {
        return { behavior: "deny", message: `plan mode blocks ${req.toolName}` };
      }
      return { behavior: "allow" };
    }

    if (
      this.mode === "acceptEdits" &&
      (req.toolName === "Edit" || req.toolName === "Write")
    ) {
      const fp = req.input.file_path;
      if (typeof fp === "string" && resolveInsideRoots(fp, this.roots)) return { behavior: "allow" };
    }
    if (
      this.mode === "acceptEdits" &&
      req.toolName === "Bash" &&
      typeof req.input.command === "string"
    ) {
      if (SAFE_FS_COMMANDS.has(firstWord(req.input.command))) return { behavior: "allow" };
    }

    if (this.prompter && opts.interactive) {
      const result = await this.prompter(req);
      if (result.persist === "always" && req.suggestRule) {
        await this.onPersistRule?.(req.suggestRule);
        this.addSessionRule(req.suggestRule);
      } else if (result.persist === "always" && !req.suggestRule) {
        /* nothing to persist */
      }
      if (result.persist === "session" && req.suggestRule) {
        this.addSessionRule(req.suggestRule);
      }
      return result.behavior === "allow" ? { behavior: "allow" } : { behavior: "deny", message: result.message };
    }

    if (!opts.interactive) {
      return {
        behavior: "deny",
        message: `permission required for ${req.toolName} in non-interactive mode (allowlist it or use --dangerously-skip-permissions)`,
      };
    }
    return { behavior: "deny", message: "no prompter available" };
  }

  setMode(m: PermissionMode): void {
    this.mode = m;
  }

  cycleMode(includeBypass: boolean): PermissionMode {
    const order: PermissionMode[] = includeBypass
      ? ["default", "acceptEdits", "plan", "bypassPermissions"]
      : ["default", "acceptEdits", "plan"];
    const idx = order.indexOf(this.mode);
    this.mode = order[(idx + 1) % order.length]!;
    return this.mode;
  }
}

function firstWord(command: string): string {
  return command.trim().split(/\s+/)[0] ?? "";
}

export const SAFE_FS_COMMANDS = new Set([
  "mkdir",
  "touch",
  "mv",
  "cp",
  "ln",
  "cat",
  "ls",
  "pwd",
  "echo",
  "head",
  "tail",
  "wc",
  "diff",
  "date",
  "which",
]);
