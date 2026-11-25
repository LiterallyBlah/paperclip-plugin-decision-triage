import { describe, expect, it, vi } from "vitest";
import { boardBlocked, COMPANY_ID, interactionCreated, setup, START, TRIAGE_AGENT_ID } from "./fixtures.js";

// Paused triage agent and daily-cap fixes (0.3.4). Literals (not imports) so this spec also runs, and fails on behaviour, against 0.3.3.
const NS = "decision-triage";
const ROUTE_ORIGIN_KIND = "plugin:paperclip.decision-triage:route";
const RECHECK_MS = 5 * 60 * 1000;
const DEBOUNCE_MS = 10_000;

type S = ReturnType<typeof setup>;

function make(config: Record<string, unknown> = {}) {
  const s = setup(Object.keys(config).length > 0 ? { config: { ...baseConfig(), ...config } } : {});
  const issues = s.harness.ctx.issues as unknown as Record<string, (...args: unknown[]) => unknown>;
  const original = issues.createComment.bind(issues);
  const createComment = vi.fn((...args: unknown[]) => original(...args));
  issues.createComment = createComment;
  return { ...s, createComment };
}

function baseConfig() {
  return {
    triageAgentId: TRIAGE_AGENT_ID,
    triageIssueId: "00000000-0000-4000-8000-0000000000a9",
    paperclipBaseUrl: "https://paperclip.example.test",
    investigationProjectId: "00000000-0000-4000-8000-0000000000f1",
  };
}

function setAgentStatus(s: S, status: string) {
  s.harness.seed({ agents: [{ id: TRIAGE_AGENT_ID, companyId: COMPANY_ID, name: "Triage", status } as never] });
}

const routeIssues = (s: S) => s.harness.ctx.issues.list({ companyId: COMPANY_ID, originKind: ROUTE_ORIGIN_KIND });
const pending = async (s: S) =>
  (((await s.harness.ctx.state.get({ scopeKind: "instance", namespace: NS, stateKey: "pending" })) as { items?: Array<Record<string, unknown>> } | null)?.items ?? []);
const missed = async (s: S) =>
  (((await s.harness.ctx.state.get({ scopeKind: "instance", namespace: NS, stateKey: "missed" })) as { items?: Array<Record<string, unknown>> } | null)?.items ?? []);
const capWakes = async (s: S, day: string) =>
  (((await s.harness.ctx.state.get({ scopeKind: "company", scopeId: COMPANY_ID, namespace: NS, stateKey: `cap:${day}` })) as { wakes?: number } | null)?.wakes ?? 0);
const DAY = new Date(START).toISOString().slice(0, 10);

describe("triage agent cannot be invoked: hold the batch, spend nothing", () => {
  for (const status of ["paused", "terminated", "pending_approval"]) {
    it(`${status}: no route issue, no invoke, no comment, no cap count; item still pending`, async () => {
      const s = make();
      setAgentStatus(s, status);
      await expect(s.triage.handle(boardBlocked())).resolves.toBe("queued");
      await s.clock.advance(DEBOUNCE_MS);
      await s.clock.advance(RECHECK_MS - 1);
      expect(await routeIssues(s)).toHaveLength(0);
      expect(s.invoke).not.toHaveBeenCalled();
      expect(s.createComment).not.toHaveBeenCalled();
      expect(await capWakes(s, DAY)).toBe(0);
      const items = await pending(s);
      expect(items).toHaveLength(1);
      expect(items[0]).toMatchObject({ attempts: 0 });
      expect(await missed(s)).toHaveLength(0);
    });
  }

  it("null agent (not found) is not invokable", async () => {
    const s = make({ triageAgentId: "00000000-0000-4000-8000-0000000000dd" });
    await s.triage.handle(boardBlocked());
    await s.clock.advance(DEBOUNCE_MS);
    expect(await routeIssues(s)).toHaveLength(0);
    expect(s.invoke).not.toHaveBeenCalled();
    expect(s.createComment).not.toHaveBeenCalled();
    expect(await capWakes(s, DAY)).toBe(0);
    expect(await pending(s)).toHaveLength(1);
  });

  it("agent resumed, recheck passes: exactly one route issue, one wake, cap +1", async () => {
    const s = make();
    setAgentStatus(s, "paused");
    await s.triage.handle(boardBlocked());
    await s.clock.advance(DEBOUNCE_MS);
    await s.clock.advance(RECHECK_MS); // still paused at the first recheck
    expect(s.invoke).not.toHaveBeenCalled();
    setAgentStatus(s, "idle");
    await s.clock.advance(RECHECK_MS);
    expect(await routeIssues(s)).toHaveLength(1);
    expect(s.invoke).toHaveBeenCalledTimes(1);
    expect(s.createComment).not.toHaveBeenCalled();
    expect(await capWakes(s, DAY)).toBe(1);
    expect(await pending(s)).toHaveLength(0);
    await s.clock.advance(RECHECK_MS * 3);
    expect(s.invoke).toHaveBeenCalledTimes(1);
    expect(await routeIssues(s)).toHaveLength(1);
  });

  it("agents.get throws: routing and wake still happen", async () => {
    const s = make();
    const get = vi.fn(async () => {
      throw new Error("missing required capability 'agents.read'");
    });
    (s.harness.ctx.agents as unknown as { get: unknown }).get = get;
    await s.triage.handle(boardBlocked());
    await s.clock.advance(DEBOUNCE_MS);
    expect(get).toHaveBeenCalled();
    expect(await routeIssues(s)).toHaveLength(1);
    expect(s.invoke).toHaveBeenCalledTimes(1);
    expect(await capWakes(s, DAY)).toBe(1);
  });
});

describe("daily cap reached: items are kept for the next UTC day", () => {
  it("capped card goes to the missed list due at 00:00 UTC; a sweep queues it only after midnight", async () => {
    const s = make({ maxWakesPerDay: 1 });
    await s.triage.handle(boardBlocked());
    await s.clock.advance(DEBOUNCE_MS);
    expect(s.invoke).toHaveBeenCalledTimes(1);
    // A card: not found again by any sweep, so before 0.3.4 a capped one never came back.
    await expect(s.triage.handle(interactionCreated())).resolves.toBe("queued");
    await s.clock.advance(DEBOUNCE_MS);
    expect(s.invoke).toHaveBeenCalledTimes(1);

    const midnight = Date.parse(`${DAY}T00:00:00.000Z`) + 24 * 60 * 60 * 1000;
    const held = await missed(s);
    expect(held).toHaveLength(1);
    expect(held[0]).toMatchObject({ kind: "interaction", retryAt: midnight });
    expect(held[0].rounds ?? 0).toBe(0);

    // Before midnight: the sweep does not queue it, and a repeat event does not double-store it.
    s.clock.now = midnight - 60_000;
    await s.triage.sweepRecoveries();
    await expect(s.triage.handle(interactionCreated())).resolves.toBe("duplicate");
    expect(await pending(s)).toHaveLength(0);
    expect(await missed(s)).toHaveLength(1);

    // After midnight: the sweep queues it and it is woken; cap 1 on the new day.
    s.clock.now = midnight + 1_000;
    await s.triage.sweepRecoveries();
    await s.clock.advance(DEBOUNCE_MS);
    expect(s.invoke).toHaveBeenCalledTimes(2);
    expect(await missed(s)).toHaveLength(0);
    expect(await pending(s)).toHaveLength(0);
    expect(await capWakes(s, new Date(midnight).toISOString().slice(0, 10))).toBe(1);
  });
});
