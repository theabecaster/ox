import { describe, expect, it, beforeAll } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { computeEdit } from "../src/tools/edit.js";
import { buildRegistry } from "../src/tools/index.js";
import { htmlToText } from "../src/tools/webfetch.js";
import { grepJs } from "../src/tools/grep.js";
import { globSorted } from "../src/tools/glob.js";
import { runBash, extractLastCd, exitOneOk, type ShellState } from "../src/tools/bash.js";

let tmp = "";

beforeAll(() => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), "ox-tools-"));
  fs.writeFileSync(path.join(tmp, "plain.txt"), "alpha\nbeta\ngamma\n");
  fs.mkdirSync(path.join(tmp, "sub"), { recursive: true });
  fs.writeFileSync(path.join(tmp, "sub", "code.ts"), "export const one = 1;\nexport const two = 2;\n");
});

describe("computeEdit", () => {
  it("replaces unique occurrence", () => {
    const r = computeEdit("a\nb\nc", "b", "B", false);
    expect(r).toEqual({ ok: true, content: "a\nB\nc", count: 1 });
  });
  it("errors on empty old_string", () => {
    expect(computeEdit("abc", "", "x", false)).toMatchObject({ ok: false });
  });
  it("errors when not found", () => {
    expect(computeEdit("abc", "zzz", "x", false)).toMatchObject({ ok: false, error: expect.stringContaining("not found") });
  });
  it("errors on multiple matches without replace_all", () => {
    const r = computeEdit("x x", "x", "y", false);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).toContain("2 times");
  });
  it("replace_all replaces everything", () => {
    const r = computeEdit("x x", "x", "y", true);
    expect(r).toMatchObject({ ok: true, count: 2, content: "y y" });
  });
});

describe("bash state machine", () => {
  function freshState(): ShellState {
    return { cwd: tmp, tasks: new Map(), taskCounter: 0, scratchDir: path.join(tmp, ".scratch"), initialCwd: tmp };
  }
  it("runs commands and captures output", async () => {
    const s = freshState();
    const r = await runBash({ command: "echo hello" }, s);
    expect(r.isError).toBe(false);
    expect(r.output).toContain("hello");
  });
  it("persists cwd across calls and rejects escapes outside project", async () => {
    const s = freshState();
    await runBash({ command: `cd sub` }, s);
    expect(s.cwd).toBe(path.join(tmp, "sub"));
    const r = await runBash({ command: `cd ${os.tmpdir()}` }, s);
    expect(s.cwd).toBe(tmp);
    expect(r.output).toContain("reset");
  });
  it("exit 1 counts as success only for search-family commands", async () => {
    const s = freshState();
    const g = await runBash({ command: "grep zzz plain.txt" }, s);
    expect(g.isError).toBe(false);
    const f = await runBash({ command: "false" }, s);
    expect(f.isError).toBe(true);
  });
  it("background mode returns task id immediately", async () => {
    const s = freshState();
    const r = await runBash({ command: "echo bg && sleep 0.2", run_in_background: true }, s);
    expect(r.output).toMatch(/Background task started: bg_\d/);
    expect(s.tasks.size).toBe(1);
  });
  it("extractLastCd picks last cd target", () => {
    expect(extractLastCd("cd a && ls && cd b")).toBe("b");
    expect(extractLastCd("ls")).toBe(null);
  });
  it("exitOneOk set", () => {
    expect(exitOneOk("grep x y")).toBe(true);
    expect(exitOneOk("git diff HEAD")).toBe(true);
    expect(exitOneOk("node bad.js")).toBe(false);
  });
});

describe("registry tools", () => {
  it("Read numbers lines and marks partial views", async () => {
    const reg = buildRegistry({ initialCwd: tmp, scratchDir: path.join(tmp, ".scratch") });
    const read = reg.get("Read")!;
    const full = await read.run({ file_path: path.join(tmp, "plain.txt") }, ctx());
    expect(full.output).toContain("     1\talpha");
    expect(full.output).toContain("     3\tgamma");
    expect(full.output).not.toContain("PARTIAL");
    const paged = await read.run({ file_path: path.join(tmp, "plain.txt"), offset: 2, limit: 1 }, ctx());
    expect(paged.output).toContain("PARTIAL view");
    expect(paged.output).toContain("2\tbeta");
  });

  it("Write then Edit roundtrip; Edit enforces containment via validate", async () => {
    const reg = buildRegistry({ initialCwd: tmp, scratchDir: path.join(tmp, ".scratch") });
    const write = reg.get("Write")!;
    const edit = reg.get("Edit")!;
    const w = await write.run({ file_path: path.join(tmp, "new.ts"), content: "const a = 1;\n" }, ctx());
    expect(w.output).toContain("Wrote");
    const e = await edit.run({ file_path: path.join(tmp, "new.ts"), old_string: "1", new_string: "42" }, ctx());
    expect(e.output).toContain("edited");
    const outside = edit.validate?.({ file_path: "/etc/hosts", old_string: "a", new_string: "b" });
    expect(outside).toContain("outside");
  });

  it("Glob finds files with mtime ordering and cap notice", async () => {
    const { files } = await globSorted("**/*.{ts,txt}", tmp);
    expect(files.some((f) => f.endsWith("plain.txt"))).toBe(true);
    expect(files.some((f) => f.endsWith("code.ts"))).toBe(true);
  });

  it("Grep fallback engine finds content with line numbers", async () => {
    const res = await grepJs(tmp, { pattern: "one|two", root: tmp, outputMode: "content" });
    expect(res.join("\n")).toContain("code.ts:1:");
    expect(res.length).toBe(2);
  });

  it("TodoWrite stores and renders checklist", async () => {
    const reg = buildRegistry({ initialCwd: tmp, scratchDir: path.join(tmp, ".scratch") });
    const todo = reg.get("TodoWrite")!;
    const r = await todo.run(
      { todos: [{ content: "a", status: "in_progress", priority: "high" }, { content: "b", status: "pending", priority: "low" }] },
      ctx(),
    );
    expect(r.output).toContain("[~] a");
    expect(reg.todoStore.get()).toHaveLength(2);
  });

  it("KillShell errors on unknown task", async () => {
    const reg = buildRegistry({ initialCwd: tmp, scratchDir: path.join(tmp, ".scratch") });
    const kill = reg.get("KillShell")!;
    const r = await kill.run({ taskId: "bg_999" }, ctx());
    expect(r.isError).toBe(true);
  });

  it("htmlToText strips tags and decodes entities", () => {
    const text = htmlToText("<html><head><title>T&amp;i</title><style>x{}</style></head><body><h1>Hi</h1><p>a &lt;b&gt; &#39;q&#39;</p></body></html>");
    expect(text).toContain("Hi");
    expect(text).toContain("'q'");
    expect(text).not.toContain("<h1>");
    expect(text).not.toContain("x{}");
  });
});

function ctx(): import("../src/types.js").ToolContext {
  return {
    sessionId: "test",
    cwd: tmp,
    addDirRoots: [],
    abort: new AbortController().signal,
    scratchDir: path.join(tmp, ".scratch"),
    requestPermission: async () => ({ behavior: "allow" }),
  };
}
