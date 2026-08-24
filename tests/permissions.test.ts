import { describe, expect, it } from "vitest";
import { globMatch, PermissionManager } from "../src/permissions.js";

function mgr(opts: Partial<ConstructorParameters<typeof PermissionManager>[0]> = {}): PermissionManager {
  return new PermissionManager({ cwd: "/repo", ...opts });
}

const bashReq = (command: string) => ({ toolName: "Bash", summary: command, input: { command }, suggestRule: null });

describe("globMatch", () => {
  it("matches ** and single *", () => {
    expect(globMatch("/src/**", "/repo/src/a/b.ts")).toBe(false);
    const p = globMatch("src/**", "src/a/b.ts");
    expect(p).toBe(true);
    expect(globMatch("*.ts", "src/x.ts")).toBe(true);
    expect(globMatch("*.ts", "src/x.js")).toBe(false);
  });
});

describe("ruleMatches via manager rules", () => {
  it("deny beats allow", async () => {
    const m = mgr({
      settings: { permissions: { allow: ["Bash(git *)"], deny: ["Bash(git push *)"] } },
    });
    expect(await m.decide(bashReq("git status"), { interactive: false })).toMatchObject({ behavior: "allow" });
    expect(await m.decide(bashReq("git push origin main"), { interactive: false })).toMatchObject({ behavior: "deny" });
  });

  it("prefix rule requires space-star semantics", async () => {
      const m = mgr({ settings: { permissions: { allow: ["Bash(git diff *)"] } } });
    expect(await m.decide(bashReq("git diff HEAD"), { interactive: false })).toMatchObject({ behavior: "allow" });
    expect(await m.decide(bashReq("git diff-index"), { interactive: false })).toMatchObject({ behavior: "deny" });
  });

  it("ask rules route to prompter interactively", async () => {
    let prompted = 0;
    const m = mgr({
      settings: { permissions: { ask: ["Bash(rm *)"] } },
      prompter: async () => {
        prompted++;
        return { behavior: "allow" };
      },
    });
    const res = await m.decide(bashReq("rm -rf build"), { interactive: true });
    expect(res).toMatchObject({ behavior: "allow" });
    expect(prompted).toBe(1);
  });

  it("persist always calls onPersistRule with suggested rule", async () => {
    const persisted: string[] = [];
    const m = mgr({
      onPersistRule: async (rule) => void persisted.push(rule),
      prompter: async () => ({ behavior: "allow", persist: "always" }),
    });
    await m.decide({ toolName: "WebFetch", summary: "", input: { url: "https://example.com/x" }, suggestRule: "WebFetch(domain:example.com)" }, { interactive: true });
    expect(persisted).toEqual(["WebFetch(domain:example.com)"]);
  });
});

describe("modes", () => {
  it("bypass allows everything", async () => {
    const m = mgr();
    m.mode = "bypassPermissions";
    expect(await m.decide(bashReq("anything"), { interactive: false })).toMatchObject({ behavior: "allow" });
  });

  it("plan blocks writes allows reads", async () => {
    const m = mgr();
    m.mode = "plan";
    expect(await m.decide({ toolName: "Read", summary: "", input: { file_path: "/repo/a" }, suggestRule: null }, { interactive: false })).toMatchObject({ behavior: "allow" });
    expect(await m.decide({ toolName: "Write", summary: "", input: { file_path: "/repo/a" }, suggestRule: null }, { interactive: false })).toMatchObject({ behavior: "deny" });
  });

  it("acceptEdits auto-allows in-root edits and safe fs commands only", async () => {
    const m = mgr();
    m.mode = "acceptEdits";
    expect(
      await m.decide({ toolName: "Edit", summary: "", input: { file_path: "/repo/src/a.ts" }, suggestRule: null }, { interactive: false }),
    ).toMatchObject({ behavior: "allow" });
    expect(
      await m.decide({ toolName: "Edit", summary: "", input: { file_path: "/etc/passwd" }, suggestRule: null }, { interactive: false }).catch(() => ({ behavior: "deny" })),
      ).toMatchObject({ behavior: "deny" });
    expect(await m.decide(bashReq("mkdir -p x"), { interactive: false })).toMatchObject({ behavior: "allow" });
    expect(await m.decide(bashReq("curl evil"), { interactive: false })).toMatchObject({ behavior: "deny" });
  });

  it("cycleMode order includes bypass when allowed", () => {
    const m = mgr();
    expect(m.cycleMode(true)).toBe("acceptEdits");
    expect(m.cycleMode(true)).toBe("plan");
    expect(m.cycleMode(true)).toBe("bypassPermissions");
    expect(m.cycleMode(true)).toBe("default");
  });
});
