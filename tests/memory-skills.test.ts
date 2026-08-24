import { describe, expect, it, beforeAll } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { loadMemory, expandImports } from "../src/memory.js";
import { parseFrontmatter, renderSkill, splitArgs, loadSkills } from "../src/skills.js";
import { BUILTIN_SUBAGENTS, loadSubagents } from "../src/subagents.js";
import { compactMessages, shouldCompact } from "../src/compaction.js";
import type { ChatMessage } from "../src/sse.js";

let sandbox = "";
let home = "";
let repo = "";

beforeAll(() => {
  sandbox = fs.mkdtempSync(path.join(os.tmpdir(), "ox-mem-"));
  home = path.join(sandbox, "home");
  const prjRoot = path.join(sandbox, "ws", "prj");
  repo = path.join(prjRoot, "apps", "web");
  fs.mkdirSync(path.join(home, ".ox"), { recursive: true });
  fs.mkdirSync(path.join(repo, ".ox"), { recursive: true });
  fs.writeFileSync(path.join(home, ".ox", "AGENTS.md"), "# global rules\nbe terse");
});

describe("memory", () => {
  it("loads ancestor chain root-down with user first", async () => {
    const grand = path.dirname(path.dirname(repo));
    fs.writeFileSync(path.join(grand, "OX.md"), "grand rule");
    fs.writeFileSync(path.join(repo, ".ox", "AGENTS.md"), "repo rule");
    try {
      const mem = await loadMemory({ cwd: repo, home });
      expect(mem.indexOf("be terse")).toBeGreaterThanOrEqual(0);
      expect(mem.indexOf("repo rule")).toBeGreaterThan(mem.indexOf("grand rule"));
    } finally {
      fs.rmSync(path.join(grand, "OX.md"));
    }
  });

  it("expands @imports relative to importer and skips fenced refs", async () => {
    fs.writeFileSync(path.join(repo, "extra.md"), "imported content");
    const raw = "line with @extra.md\n\n```\n@extra.md stays literal\n```\n";
    const out = await expandImports(raw, repo);
    expect(out).toContain("imported content");
    expect(out).toContain("@extra.md stays literal");
  });

  it("caps import depth", async () => {
    fs.writeFileSync(path.join(repo, "self1.md"), "a @self1.md");
    const out = await expandImports("start @self1.md", repo, 0, new Set());
    expect(out.length).toBeLessThan(500);
  });
});

describe("skills frontmatter + rendering", () => {
  it("parses yaml-lite frontmatter", () => {
    const { attrs, body } = parseFrontmatter(`---\ndescription: do things\nallowed-tools: Read Grep\ndisable-model-invocation: true\nargument-hint: [file]\n---\nBody $ARGUMENTS`);
    expect(attrs["description"]).toBe("do things");
    expect(attrs["disable-model-invocation"]).toBe(true);
    expect(attrs["allowed-tools"]).toBe("Read Grep");
    expect(body).toContain("$ARGUMENTS");
  });

  it("renders substitutions and positional args", () => {
    const skill = {
      name: "t",
      body: "run on ${OX_PROJECT_DIR} with $2 and $ARGUMENTS",
      disableModelInvocation: false,
      userInvocable: true,
    };
    const out = renderSkill(skill as never, 'a.txt "b c"');
    expect(out).toContain(process.cwd());
    expect(out).toContain("with b c and");
  });

  it("splitArgs handles quotes", () => {
    expect(splitArgs(`a "b c" d`)).toEqual(["a", "b c", "d"]);
  });

  it("loadSkills merges user+project with project shadowing", async () => {
    fs.mkdirSync(path.join(home, ".ox", "commands"), { recursive: true });
    fs.mkdirSync(path.join(repo, ".ox", "commands"), { recursive: true });
    fs.writeFileSync(path.join(home, ".ox", "commands", "deploy.md"), "---\ndescription: user version\n---\nuser");
    fs.writeFileSync(path.join(repo, ".ox", "commands", "deploy.md"), "---\ndescription: project version\n---\nproj");
    const skills = await loadSkills(repo, home);
    const deploy = skills.find((s) => s.name === "deploy");
    expect(deploy?.source).toBe("project");
    expect(deploy?.description).toBe("project version");
  });

  it("loadSubagents includes builtins and custom defs", async () => {
    fs.mkdirSync(path.join(repo, ".ox", "agents"), { recursive: true });
    fs.writeFileSync(
      path.join(repo, ".ox", "agents", "reviewer.md"),
      "---\nname: reviewer\ndescription: reviews code\ntools: [Read, Grep]\nmodel: inherit\n---\nYou review.",
    );
    const defs = await loadSubagents(repo, home);
    expect(defs.has("Explore")).toBe(true);
    expect(defs.has("general-purpose")).toBe(true);
    expect(defs.get("reviewer")?.tools).toEqual(["Read", "Grep"]);
    expect(BUILTIN_SUBAGENTS.get("Explore")?.description).toContain("thoroughness");
  });
});

describe("compaction", () => {
  it("threshold logic", () => {
    expect(shouldCompact(89_000, 100_000)).toBe(false);
    expect(shouldCompact(91_000, 100_000)).toBe(true);
    expect(shouldCompact(5000, 0)).toBe(false);
  });

  it("summarizes via injected stream and returns summary message", async () => {
    const calls: Array<{ messages: ChatMessage[]; usedTools: boolean }> = [];
    const fakeStream = async (messages: ChatMessage[], tools: unknown[]) => {
      calls.push({ messages, usedTools: tools.length > 0 });
      return { content: "SUMMARY BULLETS", tool_calls: [], usage: {} };
    };
    const messages: ChatMessage[] = [
      { role: "user", content: "fix the bug" },
      { role: "assistant", content: null, tool_calls: [{ id: "1", name: "Read", arguments: '{"file_path":"a.ts"}' }] },
      { role: "tool", tool_call_id: "1", name: "Read", content: "contents" },
      { role: "assistant", content: "fixed it" },
    ];
    const res = await compactMessages({ messages, apiKey: "k", model: "m", instructions: "keep paths", stream: fakeStream as never });
    expect(res.summary).toBe("SUMMARY BULLETS");
    expect(res.messages).toHaveLength(1);
    expect(String(res.messages[0]!.content)).toContain("SUMMARY");
    expect(calls[0]!.usedTools).toBe(false);
    expect(JSON.stringify(calls[0]!.messages)).toContain("keep paths");
    expect(JSON.stringify(calls[0]!.messages)).toContain("file_path");
  });
});
