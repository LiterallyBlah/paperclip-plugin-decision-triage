import { describe, expect, it } from "vitest";
import { parseConfig } from "../src/config.js";
import { safeTitle } from "../src/text.js";
import { BASE_CONFIG, TRIAGE_AGENT_ID } from "./fixtures.js";

describe("parseConfig", () => {
  it("applies defaults", () => {
    const parsed = parseConfig(BASE_CONFIG);
    expect(parsed.ok).toBe(true);
    if (!parsed.ok) return;
    expect(parsed.config).toMatchObject({
      enabled: true,
      debounceSeconds: 10,
      maxWakesPerDay: 50,
      investigationAssigneeAgentId: TRIAGE_AGENT_ID,
      triggers: { approvals: true, interactions: true, blockerAttention: true, decisions: true },
    });
  });

  it.each([
    [{ triageAgentId: undefined }, "triageAgentId is required"],
    [{ triageAgentId: "triage-agent" }, "triageAgentId must be a UUID"],
    [{ triageIssueId: "../x" }, "triageIssueId must be a UUID"],
    [{ investigationProjectId: 7 }, "investigationProjectId must be a UUID"],
    [{ investigationAssigneeAgentId: "x" }, "investigationAssigneeAgentId must be a UUID"],
    [{ paperclipBaseUrl: "http://paperclip.example.test" }, "paperclipBaseUrl must use https"],
    [{ paperclipBaseUrl: "https://u:p@paperclip.example.test" }, "paperclipBaseUrl must not contain credentials"],
    [{ debounceSeconds: -1 }, "debounceSeconds must be an integer from 0 to 300"],
    [{ maxWakesPerDay: 0 }, "maxWakesPerDay must be an integer from 1 to 10000"],
    [{ enabled: "no" }, "enabled must be a boolean"],
    [{ triggerz: {} }, 'unknown config key "triggerz"'],
    [{ triggers: { approvalz: true } }, 'triggers has unknown key "approvalz"'],
  ])("rejects %j", (patch, message) => {
    const parsed = parseConfig({ ...BASE_CONFIG, ...patch });
    expect(parsed.ok).toBe(false);
    if (parsed.ok) return;
    expect(parsed.errors.join("; ")).toContain(message);
  });

  it("allows plain http only with allowInsecureHttp", () => {
    expect(parseConfig({ ...BASE_CONFIG, paperclipBaseUrl: "http://localhost:3100", allowInsecureHttp: true }).ok).toBe(true);
  });
});

describe("safeTitle", () => {
  it("bounds length and strips control, bidi and markdown characters", () => {
    expect(safeTitle("a".repeat(500))!.length).toBe(120);
    expect(safeTitle("x‮y\u0000z")).toBe("x y z");
    expect(safeTitle("**bold** `code` <b>")).toBe("bold code b");
    expect(safeTitle("   ")).toBeNull();
    expect(safeTitle(42)).toBeNull();
  });
});
