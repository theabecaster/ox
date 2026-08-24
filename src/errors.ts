import { ApiError } from "./sse.js";

export interface ErrorContext {
  usingGateway: boolean;
  baseUrl: string;
}

export function explainApiError(err: unknown, ctx: ErrorContext): string {
  if (err instanceof ApiError) {
    if (err.status === 0) {
      return [
        ctx.usingGateway
          ? "The Ox free gateway could not be reached."
          : `Could not reach ${ctx.baseUrl}.`,
        "",
        "Things to try:",
        "- Check your internet connection.",
        `- If the gateway is paused or retired, use your own OpenRouter key instead: set OPENROUTER_API_KEY (or OX_API_KEY), then rerun ox.`,
        "- Or point OX_BASE_URL at another OpenRouter-compatible endpoint.",
      ].join("\n");
    }
    if (err.status === 401 || err.status === 403) {
      return [
        "Authentication failed against the model endpoint.",
        ctx.usingGateway
          ? "The gateway rejected this request. It may have been disabled. Set your own OPENROUTER_API_KEY to continue."
          : "Your API key looks invalid or revoked. Update OPENROUTER_API_KEY / OX_API_KEY.",
      ].join("\n");
    }
    if (err.status === 402) {
      return "The endpoint reports insufficient credits. If you are using your own key, top it up on openrouter.ai; otherwise the free gateway may be exhausted for today.";
    }
    if (err.status === 429) {
      return "Rate limited by the model endpoint. Wait a moment and retry; if you keep hitting limits, set your own OPENROUTER_API_KEY.";
    }
    if (ctx.usingGateway && (err.status === 404 || err.status === 502 || err.status === 503)) {
      return [
        "The Ox free gateway is not responding right now — it may be paused or retired.",
        "",
        "You can keep working immediately with your own key:",
        "  export OPENROUTER_API_KEY=sk-or-…   (free at openrouter.ai)",
        "then rerun ox. You can also point OX_BASE_URL at any OpenRouter-compatible endpoint.",
      ].join("\n");
    }
  }
  const message = err instanceof Error ? err.message : String(err);
  return message;
}
