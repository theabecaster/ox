import type { Usage } from "./sse.js";

export function estimateTokens(text: string): number {
  return Math.ceil(text.length / 4);
}

export interface TokenTotals {
  prompt_tokens: number;
  completion_tokens: number;
  total_tokens: number;
}

export class UsageAccumulator {
  private prompt = 0;
  private completion = 0;
  private total = 0;

  add(u: Usage): void {
    this.prompt += u.prompt_tokens ?? 0;
    this.completion += u.completion_tokens ?? 0;
    this.total += u.total_tokens ?? (u.prompt_tokens ?? 0) + (u.completion_tokens ?? 0);
  }

  totals(): TokenTotals {
    return { prompt_tokens: this.prompt, completion_tokens: this.completion, total_tokens: this.total };
  }
}
