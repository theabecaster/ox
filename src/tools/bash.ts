import { spawn, type ChildProcess } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import type { ToolImpl } from "../types.js";

export interface BashTask {
  id: string;
  proc: ChildProcess;
  outputFile: string;
}

export interface ShellState {
  cwd: string;
  tasks: Map<string, BashTask>;
  taskCounter: number;
  scratchDir: string;
  initialCwd: string;
}

export const EXIT_ONE_OK = new Set([
  "grep",
  "egrep",
  "fgrep",
  "rg",
  "find",
  "diff",
  "test",
  "[",
]);

const GIT_OK_PREFIXES = ["git diff", "git grep"];

export function exitOneOk(command: string): boolean {
  const first = command.trim().split(/\s+/)[0] ?? "";
  if (EXIT_ONE_OK.has(first)) return true;
  const two = command.trim().split(/\s+/).slice(0, 2).join(" ");
  return GIT_OK_PREFIXES.includes(two);
}

export function firstWord(command: string): string {
  return command.trim().split(/\s+/)[0] ?? "";
}

export function extractLastCd(command: string): string | null {
  let last: string | null = null;
  const segments = command.split(/&&|;|\n/);
  for (let i = 0; i < segments.length; i++) {
    const seg = segments[i]!.trim();
    const m = seg.match(/^cd\s+(.+)$/);
    if (!m) continue;
    if (i + 1 >= segments.length || segments.slice(i + 1).some((s) => s.trim() !== "")) {
      last = m[1]!.trim().replace(/^["']|["']$/g, "");
    }
  }
  return last;
}

export function truncateOutput(output: string, limit = 30_000): { text: string; truncated: boolean } {
  if (output.length <= limit) return { text: output, truncated: false };
  const head = output.slice(0, Math.floor(limit * 0.7));
  const tail = output.slice(-Math.floor(limit * 0.25));
  return {
    text: `${head}\n\n... [output truncated, ${output.length} chars total] ...\n\n${tail}`,
    truncated: true,
  };
}

export async function runBash(
  input: Record<string, unknown>,
  state: ShellState,
  onProgress?: (line: string) => void,
): Promise<{ output: string; isError: boolean }> {
  const command = typeof input.command === "string" ? input.command : null;
  if (!command || command.trim() === "") {
    return { output: "command is required", isError: true };
  }
  const bgRequested = input.run_in_background === true;

  const prevCwd = state.cwd;

  if (bgRequested) {
    state.taskCounter += 1;
    const id = `bg_${state.taskCounter}`;
    const outputFile = path.join(state.scratchDir, `task-${id}.out`);
    await fs.promises.mkdir(state.scratchDir, { recursive: true });
    const out = fs.openSync(outputFile, "w");
    const proc = spawn("bash", ["-lc", command], {
      cwd: state.cwd,
      env: { ...process.env, OX_PROJECT_DIR: state.initialCwd },
      detached: true,
      stdio: ["ignore", out, out],
    });
    proc.unref();
    fs.closeSync(out);
    state.tasks.set(id, { id, proc, outputFile });
    return {
      output: `Background task started: ${id}\nOutput file: ${outputFile}\nRead the file with the Read tool to check progress; use KillShell with taskId ${id} to stop it.`,
      isError: false,
    };
  }

  const requestedTimeout = typeof input.timeout === "number" ? input.timeout : undefined;
  const timeoutMs = Math.min(Math.max(requestedTimeout ?? 120_000, 1000), 600_000);

  return new Promise((resolve) => {
    const child = spawn("bash", ["-lc", command], {
      cwd: state.cwd,
      env: { ...process.env, OX_PROJECT_DIR: state.initialCwd },
      stdio: ["ignore", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    let timedOut = false;
    let settled = false;

    child.stdout?.on("data", (d: Buffer) => {
      stdout += d.toString();
      const lines = d.toString().split("\n").filter(Boolean);
      if (onProgress && lines.length > 0) onProgress(lines[lines.length - 1]!);
    });
    child.stderr?.on("data", (d: Buffer) => {
      stderr += d.toString();
    });

    const timer = setTimeout(() => {
      timedOut = true;
      const longRunning =
        !firstWord(command).startsWith("sleep") && !command.includes("git ");
      if (longRunning) {
        state.taskCounter += 1;
        const id = `bg_${state.taskCounter}`;
        const outputFile = path.join(state.scratchDir, `task-${id}.out`);
        fs.writeFileSync(outputFile, stdout + stderr);
        state.tasks.set(id, { id, proc: child, outputFile });
        try {
          child.stdout?.destroy();
          child.stderr?.destroy();
          child.disconnect?.();
        } catch {
          /* noop */
        }
        child.unref();
        settle({
          output:
            `Command exceeded its ${Math.round(timeoutMs / 1000)}s timeout and was moved to the background as task ${id}.\n` +
            `Output so far is being written to: ${outputFile}\nUse KillShell with taskId ${id} to stop it.`,
          isError: false,
        });
      } else {
        child.kill("SIGKILL");
        settle({
          output: `Command killed after ${Math.round(timeoutMs / 1000)}s timeout.\nSTDOUT:\n${stdout}\nSTDERR:\n${stderr}`,
          isError: true,
        });
      }
    }, timeoutMs);

    function settle(result: { output: string; isError: boolean }): void {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve(result);
    }

    child.on("error", (err) => {
      settle({ output: `spawn failed: ${err.message}`, isError: true });
    });

    child.on("close", (code) => {
      if (settled) return;
      const combined = stdout + (stderr ? (stdout ? "\n" : "") + stderr : "");
      const cdTarget = extractLastCd(command);
      const result: { output: string; isError: boolean } = {
        output: combined,
        isError: code !== 0 && !(code === 1 && exitOneOk(command)),
      };
      if (timedOut) {
        /* handled by timer */
        return;
      }
      if (result.isError) {
        result.output = combined + (combined ? "\n" : "") + `(exit code ${code})`;
      }
      if (cdTarget) {
        const resolved = path.resolve(prevCwd, cdTarget);
        if (resolved.startsWith(state.initialCwd)) {
          state.cwd = resolved;
        } else {
          state.cwd = state.initialCwd;
          result.output += `\nShell cwd was reset to ${state.initialCwd}`;
        }
      }
      const t = truncateOutput(result.output);
      if (t.truncated) {
        const dumpPath = path.join(state.scratchDir, `bash-${Date.now()}.out`);
        try {
          fs.mkdirSync(state.scratchDir, { recursive: true });
          fs.writeFileSync(dumpPath, result.output);
          result.output = `${t.text}\n\n[Full output saved to: ${dumpPath}]`;
        } catch {
          result.output = t.text;
        }
      } else {
        result.output = t.text;
      }
      settle(result);
    });
  });
}

export function createBashTool(state: ShellState): ToolImpl {
  return {
    def: {
      name: "Bash",
      description:
        "Execute a bash command in the project directory. Working directory persists across calls via cd; environment variables do not persist between calls. Default timeout 120s (max 600s); long-running commands that exceed the timeout are moved to the background and reported with a task id. Output over ~30k chars is truncated with a path to the full dump.",
      parameters: {
        type: "object",
        properties: {
          command: { type: "string", description: "The bash command to run" },
          description: { type: "string", description: "Short human-readable description of what this does" },
          timeout: { type: "number", description: "Optional timeout in milliseconds (max 600000)" },
          run_in_background: { type: "boolean", description: "Start immediately in background and return a task id" },
        },
        required: ["command"],
      },
    },
    async run(input, ctx) {
      const res = await runBash(input, state, ctx.onProgress);
      return { output: res.output || "(no output)", isError: res.isError };
    },
  };
}
