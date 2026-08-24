import { describe, expect, it, beforeAll } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  expandEnvStrings,
  McpManager,
  mcpAddServer,
  mcpListServers,
  mcpRemoveServer,
} from "../src/mcp.js";

let home = "";
let repo = "";
const fixture = fileURLToPath(new URL("./fixtures/fake-mcp-server.mjs", import.meta.url));

beforeAll(() => {
  home = fs.mkdtempSync(path.join(os.tmpdir(), "ox-mcp-home-"));
  repo = fs.mkdtempSync(path.join(os.tmpdir(), "ox-mcp-repo-"));
});

describe("env expansion", () => {
  it("expands vars with defaults and keeps missing literal", () => {
    const env = { A: "alpha" };
    expect(expandEnvStrings("${A}/x", env)).toBe("alpha/x");
    expect(expandEnvStrings("${B:-def}", env)).toBe("def");
    expect(expandEnvStrings("${B}", env)).toBe("${B}");
    expect(expandEnvStrings(["${A}"], env)).toEqual(["alpha"]);
  });
});

describe("config stores", () => {
  it("add/list/remove roundtrip in both scopes", async () => {
    await mcpAddServer({ scope: "project", name: "proj", config: { command: "node", args: ["p.js"] }, cwd: repo });
    await mcpAddServer({ scope: "local", name: "loc", config: { command: "node", args: ["l.js"] }, cwd: repo, home });
    let list = await mcpListServers({ cwd: repo, home });
    expect(list).toHaveLength(2);
    expect(list.find((s) => s.name === "proj")?.scope).toBe("project");
    await mcpRemoveServer({ scope: "local", name: "loc", cwd: repo, home });
    list = await mcpListServers({ cwd: repo, home });
    expect(list.map((s) => s.name)).toEqual(["proj"]);
    fs.rmSync(path.join(repo, ".mcp.json"));
  });
});

describe("McpManager", () => {
  it("connects to a stdio server, lists tools, and calls them", async () => {
    await mcpAddServer({ scope: "local", name: "fake", config: { command: process.execPath, args: [fixture] }, cwd: repo, home });
    const mgr = new McpManager({ cwd: repo, home });
    const states = await mgr.startAll();
    expect(states[0]?.status).toBe("connected");
    const tools = mgr.buildToolImpls();
    expect(tools.map((t) => t.def.name)).toContain("mcp__fake__echo");
    const echo = tools.find((t) => t.def.name === "mcp__fake__echo")!;
    const res = await echo.run({ text: "hi" }, dummyCtx());
    expect(res.output).toBe("echo:hi");
    const fail = tools.find((t) => t.def.name === "mcp__fake__fail")!;
    const bad = await fail.run({}, dummyCtx());
    expect(bad.isError).toBe(true);
    await mgr.stopAll();
    await mcpRemoveServer({ scope: "local", name: "fake", cwd: repo, home });
  });

  it("marks unreachable servers as error without throwing", async () => {
    await mcpAddServer({ scope: "local", name: "dead", config: { command: "definitely-not-a-real-binary-xyz" }, cwd: repo, home });
    const mgr = new McpManager({ cwd: repo, home, timeoutMs: 2000 });
    const states = await mgr.startAll();
    const dead = states.find((s) => s.name === "dead");
    expect(dead?.status).toBe("error");
    await mcpRemoveServer({ scope: "local", name: "dead", cwd: repo, home });
  });

  it("approval gate skips project servers when declined", async () => {
    await mcpAddServer({ scope: "project", name: "gated", config: { command: process.execPath, args: [fixture] }, cwd: repo });
    const mgr = new McpManager({ cwd: repo, home, approval: async () => false });
    await mgr.startAll();
    expect(mgr.buildToolImpls()).toHaveLength(0);
    fs.rmSync(path.join(repo, ".mcp.json"));
  });

  it("times out a silent server", async () => {
    const silent = path.join(home, "silent-server.mjs");
    fs.writeFileSync(
      silent,
      "process.stdin.resume();\nprocess.on('SIGTERM', () => process.exit(0));\n",
    );
    await mcpAddServer({ scope: "local", name: "silent", config: { command: process.execPath, args: [silent] }, cwd: repo, home });
    const mgr = new McpManager({ cwd: repo, home, timeoutMs: 500 });
    const states = await mgr.startAll();
    expect(states.find((s) => s.name === "silent")?.status).toBe("error");
    await mcpRemoveServer({ scope: "local", name: "silent", cwd: repo, home });
  });
});

function dummyCtx() {
  return {
    sessionId: "t",
    cwd: repo,
    addDirRoots: [],
    abort: new AbortController().signal,
    scratchDir: repo,
    requestPermission: async () => ({ behavior: "allow" }),
  };
}
