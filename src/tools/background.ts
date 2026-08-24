import path from "node:path";
import type { ToolImpl } from "../types.js";
import type { ShellState } from "./bash.js";

export function createKillShellTool(state: ShellState): ToolImpl {
  return {
    def: {
      name: "KillShell",
      description:
        "Stop a background bash task by id (ids look like bg_1). Use for tasks started with Bash run_in_background=true or moved to background after a timeout.",
      parameters: {
        type: "object",
        properties: {
          taskId: { type: "string", description: "Background task id, e.g. bg_2" },
        },
        required: ["taskId"],
      },
    },
    async run(input) {
      const id = typeof input.taskId === "string" ? input.taskId : typeof input.id === "string" ? input.id : "";
      if (!id) return { output: "taskId is required", isError: true };
      const task = state.tasks.get(id);
      if (!task) {
        return { output: `Unknown background task: ${id}`, isError: true };
      }
      try {
        process.kill(-task.proc.pid!, "SIGTERM");
        setTimeout(() => {
          try {
            process.kill(-task.proc.pid!, "SIGKILL");
          } catch {
            /* already dead */
          }
        }, 2000);
      } catch {
        try {
          task.proc.kill("SIGKILL");
        } catch {
          /* already dead */
        }
      }
      state.tasks.delete(id);
      return { output: `Killed task ${id} (output file: ${path.basename(task.outputFile)})` };
    },
  };
}

export function listTasks(state: ShellState): string[] {
  return [...state.tasks.entries()].map(([id, t]) => {
    const alive = t.proc.exitCode === null && t.proc.signalCode === null;
    return `${id}: ${alive ? "running" : "finished"} — output: ${t.outputFile}`;
  });
}
