import type { ToolImpl } from "../types.js";

const ENTITIES: Record<string, string> = {
  "&amp;": "&",
  "&lt;": "<",
  "&gt;": ">",
  "&quot;": '"',
  "&#39;": "'",
  "&#x27;": "'",
  "&apos;": "'",
  "&nbsp;": " ",
};

export function htmlToText(html: string): string {
  let s = html;
  s = s.replace(/<!--[\s\S]*?-->/g, " ");
  s = s.replace(/<(script|style|noscript|svg|head)[\s\S]*?<\/\1>/gi, " ");
  const titleMatch = s.match(/<title[^>]*>([\s\S]*?)<\/title>/i);
  const title = titleMatch ? decodeEntities(titleMatch[1] ?? "").trim() : null;
  s = s
    .replace(/<\/(p|div|h[1-6]|li|tr|section|article|br|blockquote)>/gi, "\n")
    .replace(/<br\s*\/?>/gi, "\n")
    .replace(/<[^>]+>/g, " ");
  s = decodeEntities(s);
  s = s.replace(/[ \t]+/g, " ");
  s = s.replace(/\n\s*\n\s*\n+/g, "\n\n");
  s = s.split("\n").map((l) => l.trim()).join("\n").trim();
  return JSON.stringify({ title, text: s }) === JSON.stringify({ title: null, text: "" })
    ? ""
    : s;
}

function decodeEntities(s: string): string {
  return s
    .replace(/&#x([0-9a-fA-F]+);/g, (_, h) => String.fromCodePoint(parseInt(h, 16)))
    .replace(/&#(\d+);/g, (_, d) => String.fromCodePoint(parseInt(d, 10)))
    .replace(/&(amp|lt|gt|quot|#39|#x27|apos|nbsp);/g, (m) => ENTITIES[m] ?? m);
}

async function fetchFollowingSameHost(
  url: URL,
  signal: AbortSignal,
): Promise<{ finalUrl: URL; body: string }> {
  let current = url;
  for (let hop = 0; hop < 4; hop++) {
    const res = await fetch(current, { redirect: "manual", signal });
    if (res.status >= 300 && res.status < 400) {
      const loc = res.headers.get("location");
      if (!loc) return { finalUrl: current, body: await res.text() };
      const next = new URL(loc, current);
      if (next.hostname !== url.hostname) {
        throw new Error(`CROSS_HOST_REDIRECT:${next.protocol}//${next.hostname}${next.pathname}`);
      }
      current = next;
      continue;
    }
    if (!res.ok && res.status !== 304) {
      throw new Error(`HTTP ${res.status} ${res.statusText} for ${current}`);
    }
    return { finalUrl: current, body: await res.text() };
  }
  throw new Error("Too many redirects");
}

const MAX_CONTENT = 40_000;

export function createWebFetchTool(): ToolImpl {
  return {
    def: {
      name: "WebFetch",
      description:
        "Fetch a URL and convert the page to readable text (HTML is stripped). The tool returns the page content together with your question; analyze the content to answer it. HTTP upgrades to HTTPS. Cross-host redirects are not followed — you will be told the new URL.",
      parameters: {
        type: "object",
        properties: {
          url: { type: "string", description: "Absolute http(s) URL" },
          prompt: { type: "string", description: "What you want to learn from this page" },
        },
        required: ["url", "prompt"],
      },
    },
    async run(input, ctx) {
      const rawUrl = typeof input.url === "string" ? input.url : "";
      const prompt = typeof input.prompt === "string" ? input.prompt : "";
      let parsed: URL;
      try {
        parsed = new URL(rawUrl);
      } catch {
        return { output: `Invalid URL: ${rawUrl}`, isError: true };
      }
      if (parsed.protocol === "http:") parsed.protocol = "https:";
      if (parsed.protocol !== "https:") {
        return { output: `Only http(s) URLs are supported`, isError: true };
      }
      try {
        const { finalUrl, body } = await fetchFollowingSameHost(parsed, ctx.abort);
        const text = htmlToText(body).slice(0, MAX_CONTENT);
        if (!text) return { output: `No textual content at ${finalUrl}`, isError: true };
        return {
          output: `Content from ${finalUrl}:\n\n${text}\n\n---\nUser question: ${prompt}\n\nAnswer the question using only the content above; if it does not contain the answer, summarize what IS there.`,
        };
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        if (msg.startsWith("CROSS_HOST_REDIRECT:")) {
          return {
            output: `Redirected to a different host: ${msg.slice("CROSS_HOST_REDIRECT:".length)} — call WebFetch again on that URL explicitly.`,
          };
        }
        return { output: `WebFetch failed: ${msg}`, isError: true };
      }
    },
  };
}
