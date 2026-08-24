import { describe, expect, it } from "vitest";
import {
  mergeSettings,
  projectSlug,
  resolveApiKey,
  resolveModel,
  settingsPaths,
} from "../src/config.js";
import { resolveEndpoint, RELEASE_GATEWAY_URL } from "../src/endpoint.js";
import { explainApiError } from "../src/errors.js";
import { ApiError } from "../src/sse.js";
import { DEFAULT_MODEL } from "../src/types.js";

describe("config", () => {
  it("projectSlug sanitizes paths", () => {
    expect(projectSlug("/Users/abe/my proj")).toBe("Users-abe-my-proj");
    expect(projectSlug("/")).toBe("root");
  });

  it("mergeSettings overrides scalars and unions lists", () => {
    const merged = mergeSettings([
      { model: "a", permissions: { allow: ["Bash(ls)"], deny: ["Read(.env)"], defaultMode: "default" } },
      { model: "b", permissions: { allow: ["Bash(ls)", "Edit(/tmp/**)"] } },
    ]);
    expect(merged.model).toBe("b");
    expect(merged.permissions?.allow).toEqual(["Bash(ls)", "Edit(/tmp/**)"]);
    expect(merged.permissions?.deny).toEqual(["Read(.env)"]);
    expect(merged.permissions?.defaultMode).toBe("default");
  });

  it("mergeSettings concatenates hooks per event", () => {
    const merged = mergeSettings([
      { hooks: { PreToolUse: [{ matcher: "Bash", hooks: [{ command: "a" }] }] } },
      { hooks: { PreToolUse: [{ hooks: [{ command: "b" }] }] } },
    ]);
    expect(merged.hooks?.PreToolUse).toHaveLength(2);
  });

  it("settingsPaths are ordered", () => {
    const p = settingsPaths("/repo", "/home");
    expect(p.user).toBe("/home/.ox/settings.json");
    expect(p.project).toBe("/repo/.ox/settings.json");
    expect(p.local).toBe("/repo/.ox/settings.local.json");
  });

  it("resolveApiKey prefers env chain", () => {
    expect(resolveApiKey({}).key).toBeNull();
    expect(resolveApiKey({ OPENROUTER_API_KEY: "k1" })).toMatchObject({ key: "k1", source: "env:OPENROUTER_API_KEY" });
    expect(resolveApiKey({ OX_API_KEY: "k2", OPENROUTER_API_KEY: "k1" }).source).toBe("env:OX_API_KEY");
    expect(resolveApiKey({ OX_API_KEY: "   " }).key).toBeNull();
  });

  it("resolveModel precedence", () => {
    expect(resolveModel({}, undefined, {})).toBe(DEFAULT_MODEL);
    expect(resolveModel({ model: "m" }, undefined, {})).toBe("m");
    expect(resolveModel({ model: "m" }, "flag", {})).toBe("flag");
    expect(resolveModel({ model: "m" }, undefined, { OX_MODEL: "env" })).toBe("env");
    expect(resolveModel({}, "flag", { OX_MODEL: "env" })).toBe("flag");
  });
});

describe("endpoint resolution", () => {
  it("own key goes direct", () => {
    const e = resolveEndpoint({ key: "sk-or-x", keySource: "env:OX_API_KEY" });
    expect(e.usingGateway).toBe(false);
    expect(e.apiKey).toBe("sk-or-x");
  });

  it("no key falls back to release gateway", () => {
    const e = resolveEndpoint({});
    expect(e.usingGateway).toBe(true);
    expect(e.baseUrl).toBe(RELEASE_GATEWAY_URL);
    expect(e.apiKey).toBeNull();
  });

  it("explicit gateway setting wins over direct default", () => {
    const e = resolveEndpoint({ key: "k", settings: { gateway: "https://my.proxy/v1" } });
    expect(e.baseUrl).toBe("https://my.proxy/v1");
    expect(e.usingGateway).toBe(false);
  });
});

describe("explainApiError", () => {
  it("guides when the gateway is down", () => {
    const msg = explainApiError(new ApiError(503, "gateway down"), { usingGateway: true, baseUrl: "https://gw" });
    expect(msg).toContain("free gateway");
    expect(msg).toContain("OPENROUTER_API_KEY");
  });

  it("explains bad own key", () => {
    const msg = explainApiError(new ApiError(401, "nope"), { usingGateway: false, baseUrl: "https://openrouter.ai/api/v1" });
    expect(msg).toContain("invalid or revoked");
  });

  it("network errors mention the base url", () => {
    const msg = explainApiError(new ApiError(0, "network error"), { usingGateway: false, baseUrl: "https://x.example" });
    expect(msg).toContain("https://x.example");
  });
});
