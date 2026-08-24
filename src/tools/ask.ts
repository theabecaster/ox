import type { AskQuestion, ToolImpl } from "../types.js";

export function createAskTool(): ToolImpl {
  return {
    def: {
      name: "AskUserQuestion",
      description:
        "Ask the user 1-4 multiple-choice questions with options. Use when a decision is genuinely needed (ambiguous requirements, conflicting approaches, confirmation before something irreversible). Do not overuse.",
      parameters: {
        type: "object",
        properties: {
          questions: {
            type: "array",
            description: "1-4 questions",
            items: {
              type: "object",
              properties: {
                question: { type: "string", description: "Complete question" },
                header: { type: "string", description: "Very short label (max 30 chars)" },
                options: {
                  type: "array",
                  description: "2-5 answer options",
                  items: {
                    type: "object",
                    properties: {
                      label: { type: "string", description: "Short option text" },
                      description: { type: "string", description: "Explanation of the choice" },
                    },
                    required: ["label"],
                  },
                },
                multiSelect: { type: "boolean", description: "Allow selecting several options" },
              },
              required: ["question", "header", "options"],
            },
          },
        },
        required: ["questions"],
      },
    },
    validate(input) {
      const qs = input.questions;
      if (!Array.isArray(qs) || qs.length < 1 || qs.length > 4) return "questions must contain 1-4 items";
      return null;
    },
    async run(input, ctx) {
      if (!ctx.askUser) {
        return { output: "AskUserQuestion is unavailable in this context", isError: true };
      }
      const questions = (input.questions as unknown[]).map((q) => {
        const rec = q as Record<string, unknown>;
        return {
          question: String(rec.question ?? ""),
          header: String(rec.header ?? "").slice(0, 30),
          multiSelect: rec.multiSelect === true,
          options: Array.isArray(rec.options)
            ? rec.options.map((o) => {
                const r = o as Record<string, unknown>;
                return { label: String(r.label ?? ""), description: r.description ? String(r.description) : undefined };
              })
            : [],
        } satisfies AskQuestion;
      });
      try {
        const answers = await ctx.askUser(questions);
        const lines = Object.entries(answers).map(([q, a]) => `${q} → ${a}`);
        return { output: `User answered:\n${lines.join("\n")}` };
      } catch (err) {
        return { output: `Question dismissed: ${err instanceof Error ? err.message : String(err)}`, isError: true };
      }
    },
  };
}
