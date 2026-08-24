import fs from "node:fs";
import path from "node:path";
import type { ToolImpl, ToolRegistry } from "../types.js";
import { createBashTool, type ShellState } from "./bash.js";
import { createReadTool } from "./read.js";
import { createWriteTool } from "./write.js";
import { createEditTool } from "./edit.js";
import { createGlobTool } from "./glob.js";
import { createGrepTool } from "./grep.js";
import { createWebFetchTool } from "./webfetch.js";
import { createTodoTool, createMemoryTodoStore, type TodoStore } from "./todo.js";
import { createKillShellTool } from "./background.js";
import { createAskTool } from "./ask.js";

export interface ToolsOptions {
  initialCwd: string;
  scratchDir: string;
  todoStore?: TodoStore;
}

export class OxToolRegistry implements ToolRegistry {
  private map = new Map<string, ToolImpl>();
  shellState: ShellState;
  todoStore: TodoStore;
  private roots: string[];

  constructor(opts: ToolsOptions) {
    this.shellState = {
      cwd: opts.initialCwd,
      tasks: new Map(),
      taskCounter: 0,
      scratchDir: opts.scratchDir,
      initialCwd: opts.initialCwd,
    };
    this.todoStore = opts.todoStore ?? createMemoryTodoStore();
    this.roots = [opts.initialCwd];

    const tools: ToolImpl[] = [
      createBashTool(this.shellState),
      createReadTool(),
      createWriteTool(() => this.roots),
      createEditTool(() => this.roots),
      createGlobTool(),
      createGrepTool(() => this.shellState.cwd),
      createWebFetchTool(),
      createTodoTool(this.todoStore),
      createKillShellTool(this.shellState),
      createAskTool(),
    ];
    for (const t of tools) this.map.set(t.def.name, wrap(t));
  }

  addRaw(name: string, tool: ToolImpl): void {
    this.map.set(name, wrap(tool));
  }

  updateRoots(next: string[]): void {
    this.roots = next;
  }

  rootsProvider(): string[] {
    return this.roots;
  }

  get(name: string): ToolImpl | undefined {
    return this.map.get(name);
  }

  names(): string[] {
    return [...this.map.keys()];
  }

  defs() {
    return [...this.map.values()].map((t) => t.def);
  }
}

export function buildRegistry(opts: ToolsOptions): OxToolRegistry {
  return new OxToolRegistry(opts);
}

function wrap(tool: ToolImpl): ToolImpl {
  return {
    def: tool.def,
    readonly: tool.readonly,
    validate: tool.validate,
    async run(input: Record<string, unknown>, ctx: Parameters<ToolImpl["run"]>[1]) {
      try {
        return await tool.run(input, ctx);
      } catch (err) {
        return {
          output: `${tool.def.name} failed: ${err instanceof Error ? err.message : String(err)}`,
          isError: true,
        };
      }
    },
  };
}

export function ensureScratchDir(scratchRoot: string, sessionId: string): string {
  const dir = path.join(scratchRoot, sessionId.slice(0, 8));
  fs.mkdirSync(dir, { recursive: true });
  return dir;
}
