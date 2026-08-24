import type { ToolImpl, TodoItem } from "../types.js";

export interface TodoStore {
  get(): TodoItem[];
  set(todos: TodoItem[]): void;
}

export function createMemoryTodoStore(): TodoStore {
  let todos: TodoItem[] = [];
  return { get: () => todos, set: (t) => void (todos = t) };
}

function render(todos: TodoItem[]): string {
  const marks = new Map([
    ["pending", "[ ]"],
    ["in_progress", "[~]"],
    ["completed", "[x]"],
  ]);
  const lines = todos.map((t) => `${marks.get(t.status)} ${t.content} (${t.priority})`);
  const counts = {
    pending: todos.filter((t) => t.status === "pending").length,
    in_progress: todos.filter((t) => t.status === "in_progress").length,
    completed: todos.filter((t) => t.status === "completed").length,
  };
  return [
    `Todo list updated: ${counts.in_progress} in progress, ${counts.pending} pending, ${counts.completed} completed`,
    ...lines,
  ].join("\n");
}

export function createTodoTool(store: TodoStore): ToolImpl {
  return {
    def: {
      name: "TodoWrite",
      description:
        "Maintain a structured task checklist for the current session. Replace the whole list each call. Use it for multi-step work: mark exactly one task in_progress while working, completed only when truly done.",
      parameters: {
        type: "object",
        properties: {
          todos: {
            type: "array",
            description: "The full todo list (replaces previous)",
            items: {
              type: "object",
              properties: {
                content: { type: "string" },
                status: { type: "string", enum: ["pending", "in_progress", "completed"] },
                priority: { type: "string", enum: ["high", "medium", "low"] },
              },
              required: ["content", "status", "priority"],
            },
          },
        },
        required: ["todos"],
      },
    },
    validate(input) {
      if (!Array.isArray(input.todos)) return "todos must be an array";
      return null;
    },
    async run(input) {
      const raw = input.todos as Array<Record<string, unknown>>;
      const todos: TodoItem[] = [];
      for (const t of raw) {
        if (typeof t.content !== "string") continue;
        const status =
          t.status === "in_progress" || t.status === "completed" ? t.status : "pending";
        const priority = t.priority === "high" || t.priority === "low" ? t.priority : "medium";
        todos.push({ content: t.content, status, priority });
      }
      store.set(todos);
      return { output: render(todos) };
    },
  };
}
