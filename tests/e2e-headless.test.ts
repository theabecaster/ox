import { describe, expect, it, beforeAll, afterAll } from "vitest";
import { spawn } from "node:child_process";
import fs from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const bin = path.join(repoRoot, "dist", "index.js");

let server: http.Server;
let port = 0;
let noteFile = "";
const seenAuth: string[] = [];
const seenToolCallShapes: string[] = [];

function sse(res: http.ServerResponse, obj: unknown): void {
  res.write(`data: ${JSON.stringify(obj)}\n\n`);
}

beforeAll(async () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "ox-e2e-"));
  noteFile = path.join(tmp, "note.txt");
  fs.writeFileSync(noteFile, "hello-from-file");
  server = http.createServer((req, res) => {
    let body = "";
    req.on("data", (c) => (body += c));
    req.on("end", () => {
      seenAuth.push(String(req.headers.authorization));
      const parsed = JSON.parse(body) as {
        messages: Array<Record<string, unknown>>;
        max_tokens?: number;
      };
      const hasToolResult = parsed.messages.some((m) => m.role === "tool");
      const denied = parsed.messages.some(
        (m) => m.role === "tool" && String(m.content).includes("[Request denied"),
      );
      const wantsWrite = JSON.stringify(parsed.messages).includes("try writing");
      if (process.env.OX_E2E_DEBUG) console.error("[mock] msgs:", JSON.stringify(parsed.messages).slice(0, 400), "wantsWrite:", wantsWrite);
      for (const m of parsed.messages) {
        const tcs = m.tool_calls as Array<Record<string, unknown>> | undefined;
        if (tcs) seenToolCallShapes.push(JSON.stringify(tcs[0]));
      }
      expect(parsed.max_tokens).toBeGreaterThan(0);
      res.writeHead(200, { "Content-Type": "text/event-stream" });
      sse(res, { id: "x", choices: [{ index: 0, delta: { role: "assistant", reasoning: "thinking…" } }] });
      if (!hasToolResult) {
        const toolCall = wantsWrite
          ? {
              index: 0,
              id: "call_w",
              function: {
                name: "Write",
                arguments: JSON.stringify({ file_path: "out.txt", content: "x" }),
              },
            }
          : {
              index: 0,
              id: "call_1",
              function: { name: "Read", arguments: JSON.stringify({ file_path: noteFile }) },
            };
        sse(res, { id: "x", choices: [{ index: 0, delta: { tool_calls: [toolCall] } }] });
        sse(res, { id: "x", choices: [{ index: 0, delta: {} }], usage: { prompt_tokens: 20, completion_tokens: 10, total_tokens: 30 } });
      } else if (denied) {
        sse(res, { id: "x", choices: [{ index: 0, delta: { content: "BLOCKED-OK" } }] });
        sse(res, { id: "x", choices: [{ index: 0, delta: {} }], usage: { prompt_tokens: 40, completion_tokens: 8, total_tokens: 48 } });
      } else {
        sse(res, { id: "x", choices: [{ index: 0, delta: { content: "The file says hello-from-file." } }] });
        sse(res, { id: "x", choices: [{ index: 0, delta: {} }], usage: { prompt_tokens: 40, completion_tokens: 8, total_tokens: 48 } });
      }
      res.write("data: [DONE]\n\n");
      res.end();
    });
  });
  await new Promise<void>((resolve) => {
    server.listen(0, "127.0.0.1", () => {
      const addr = server.address() as { port: number };
      port = addr.port;
      resolve();
    });
  });
});

afterAll(() => {
  server.close();
});

function runCli(args: string[], cwd: string): Promise<{ code: number | null; stdout: string; stderr: string }> {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, [bin, ...args], {
      cwd,
      stdio: ["ignore", "pipe", "pipe"],
      env: {
        ...process.env,
        OPENROUTER_API_KEY: "test-key-e2e",
        OX_BASE_URL: `http://127.0.0.1:${port}/v1`,
        HOME: cwd,
      },
    });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (d) => (stdout += d));
    child.stderr.on("data", (d) => (stderr += d));
    child.on("close", (code) => resolve({ code, stdout, stderr }));
  });
}

describe("headless e2e over real HTTP", () => {
  it("completes an agentic turn with tool use and returns text", async () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "ox-e2e-run-"));
    const r = await runCli(["-p", "read note.txt and tell me what it says"], tmp);
    expect(r.code).toBe(0);
    expect(r.stdout).toContain("hello-from-file");
    expect(seenAuth).toContain("Bearer test-key-e2e");
    expect(seenToolCallShapes.some((s) => s.includes('"type":"function"'))).toBe(true);
  }, 60_000);

  it("emits valid stream-json events", async () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "ox-e2e-sj-"));
    const r = await runCli(["-p", "go", "--output-format", "stream-json"], tmp);
    expect(r.code).toBe(0);
    const lines = r.stdout.trim().split("\n").map((l) => JSON.parse(l));
    expect(lines[0]).toMatchObject({ type: "system", subtype: "init" });
    expect(lines.at(-1)).toMatchObject({ type: "result", subtype: "success" });
    expect((lines.at(-1) as { session_id: string }).session_id).toBeTruthy();
  }, 60_000);

  it("json output includes result envelope", async () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "ox-e2e-js-"));
    const r = await runCli(["-p", "again", "--output-format", "json"], tmp);
    expect(r.code).toBe(0);
    const parsed = JSON.parse(r.stdout);
    expect(parsed.result).toContain("hello-from-file");
    expect(parsed.usage.total_tokens).toBeGreaterThan(0);
  }, 60_000);

  it("permission denial in default mode blocks writes and the model adapts", async () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "ox-e2e-deny-"));
    const r = await runCli(["-p", "try writing a file"], tmp);
    expect(r.code).toBe(0);
    expect(r.stdout).toContain("BLOCKED-OK");
    expect(fs.existsSync(path.join(tmp, "out.txt"))).toBe(false);
  }, 60_000);
});
