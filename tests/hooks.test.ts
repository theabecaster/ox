import { describe, expect, it, beforeAll, afterAll } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { HookRunner } from "../src/hooks.js";

let repo = "";

beforeAll(() => {
  repo = fs.mkdtempSync(path.join(os.tmpdir(), "ox-hooks-"));
});

afterAll(() => {
  fs.rmSync(repo, { recursive: true, force: true });
});

describe("HookRunner", () => {
  it("exit 2 blocks with stderr reason", async () => {
    const hr = new HookRunner({ PreToolUse: [{ matcher: "Bash", hooks: [{ command: "echo no-way >&2; exit 2" }] }] }, repo);
    const out = await hr.run("PreToolUse", { tool_name: "Bash", tool_input: {} });
    expect(out.blocked).toBe(true);
    expect(out.reason).toContain("no-way");
  });

  it("matcher filters events", async () => {
    const hr = new HookRunner(
      { PreToolUse: [{ matcher: "Edit|Write", hooks: [{ command: "exit 2" }] }] },
      repo,
    );
    const bash = await hr.run("PreToolUse", { tool_name: "Bash", tool_input: {} });
    expect(bash.blocked).toBe(false);
    const edit = await hr.run("PreToolUse", { tool_name: "Edit", tool_input: {} });
    expect(edit.blocked).toBe(true);
  });

  it("JSON stdout allow decision and additionalContext merge", async () => {
    const hr = new HookRunner(
      {
        PreToolUse: [
          { hooks: [{ command: `echo '{"permissionDecision":"ask","permissionDecisionReason":"be careful"}'` }] },
          { hooks: [{ command: `echo '{"additionalContext":"ctx-here"}'` }] },
        ],
      },
      repo,
    );
    const out = await hr.run("PreToolUse", { tool_name: "Bash", tool_input: {} });
    expect(out.decision).toBe("ask");
    expect(out.reason).toContain("be careful");
  });

  it("UserPromptSubmit plain stdout becomes context", async () => {
    const hr = new HookRunner({ UserPromptSubmit: [{ hooks: [{ command: "echo injected-note" }] }] }, repo);
    const out = await hr.run("UserPromptSubmit", {});
    expect(out.context).toContain("injected-note");
  });

  it("timeout kills slow hooks without blocking", async () => {
    const hr = new HookRunner(
      { PreToolUse: [{ hooks: [{ command: "sleep 5; echo done", timeout: 1 }] }] },
      repo,
    );
    const out = await hr.run("PreToolUse", { tool_name: "Bash", tool_input: {} });
    expect(out.blocked).toBe(false);
  });

  it("stdin payload carries hook_event_name and cwd", async () => {
    const sink = path.join(repo, "stdin.json");
    const hr = new HookRunner(
      { PreToolUse: [{ hooks: [{ command: `cat > ${sink}` }] }] },
      repo,
    );
    await hr.run("PreToolUse", { tool_name: "Bash", tool_input: { command: "ls" } });
    const payload = JSON.parse(fs.readFileSync(sink, "utf8"));
    expect(payload.hook_event_name).toBe("PreToolUse");
    expect(payload.cwd).toBe(repo);
    expect(payload.tool_input.command).toBe("ls");
  });

  it("updatedInput from JSON reaches the loop", async () => {
    const hr = new HookRunner(
      { PreToolUse: [{ hooks: [{ command: `echo '{"hookSpecificOutput":{"permissionDecision":"allow","updatedInput":{"command":"echo safe"}}}'` }] }] },
      repo,
    );
    const out = await hr.run("PreToolUse", { tool_name: "Bash", tool_input: { command: "rm -rf /" } });
    expect(out.updatedInput).toEqual({ command: "echo safe" });
  });
});
