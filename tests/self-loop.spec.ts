import { describe, expect, it, vi } from "vitest";
import type { PluginEvent } from "@paperclipai/plugin-sdk";
import { COMPANY_ID, event, OTHER_AGENT_ID, PROJECT_ID, setup, uuidN } from "./fixtures.js";

// The two self-routing loop causes that exhausted the daily wake cap (fixed in 0.3.3).
// Literals (not imported) so this spec runs, and fails on behaviour, against 0.3.2.
const TRIAGE_AGENT = "00000000-0000-4000-8000-0000000000ee";
const ROUTE_ORIGIN_KIND = "plugin:paperclip.decision-triage:route";
const CAP_ORIGIN_KIND = "plugin:paperclip.decision-triage:daily-cap";
const CONFIG = { triageAgentId: TRIAGE_AGENT, paperclipBaseUrl: "https://paperclip.example.test", investigationProjectId: PROJECT_ID };
const DEBOUNCE_MS = 10_000;
const COOLDOWN_MS = 2 * 60 * 60 * 1000;
const BLOCKED_AT = "2026-01-02T09:59:00.000Z";
const SOURCE = OTHER_AGENT_ID;

let seq = 0x4310;
const next = () => uuidN((seq += 1));

type S = ReturnType<typeof setup>;

function make(): S & { create: ReturnType<typeof vi.fn> } {
  const s = setup({ config: CONFIG });
  s.harness.seed({
    agents: [{ id: TRIAGE_AGENT, companyId: COMPANY_ID, name: "triage-agent", status: "idle" } as never],
    // Neutralise the shared fixture's board-blocked issue so each test counts its own items only.
    issues: [{ id: uuidN(0xa1), companyId: COMPANY_ID, identifier: "EX-42", title: "Shared", status: "in_progress" } as never],
  });
  const issues = s.harness.ctx.issues as unknown as Record<string, (...args: unknown[]) => unknown>;
  const original = issues.create.bind(issues);
  const create = vi.fn((...args: unknown[]) => original(...args));
  issues.create = create;
  return { ...s, create };
}

function issue(id: string, identifier: string, extra: Record<string, unknown> = {}) {
  return { id, companyId: COMPANY_ID, identifier, title: `Item ${identifier}`, status: "blocked", assigneeAgentId: SOURCE, assigneeUserId: null, unblockDescriptor: null, blockedTransitionAt: BLOCKED_AT, ...extra } as never;
}

function seed(s: S, issues: unknown[]) {
  s.harness.seed({ issues: issues as never });
}

function enter(terminalId: string, blockedIssueId: string): PluginEvent {
  return event("issue.blocker_attention_changed", {
    entityType: "issue",
    entityId: terminalId,
    actorType: "system",
    actorId: undefined,
    payload: { terminalBlockerIssueId: terminalId, dedupKey: `blocker:${terminalId}`, blockedIssueId, entered: true, state: "stalled", blockingTreeLive: false, activityAt: BLOCKED_AT },
  });
}

function exit(terminalId: string): PluginEvent {
  return event("issue.blocker_attention_changed", {
    entityType: "issue",
    entityId: terminalId,
    actorType: "system",
    actorId: undefined,
    payload: { terminalBlockerIssueId: terminalId, dedupKey: `blocker:${terminalId}`, entered: false },
  });
}

function attention(terminalId: string, visible = true) {
  return { blockerAttention: { state: "stalled", blockingTreeLive: false, terminalBlockerIssueId: terminalId, terminalBlocker: visible ? { id: terminalId } : null } };
}

async function routes(s: S) {
  return s.harness.ctx.issues.list({ companyId: COMPANY_ID, originKind: ROUTE_ORIGIN_KIND });
}

describe("Change A: a blocker tree whose terminal the triage agent holds is not routed", () => {
  it("event: the terminal is a plugin routing issue -> no routing issue, no wake", async () => {
    const s = make();
    const route = next();
    const blocked = next();
    seed(s, [issue(route, "EX-501", { originKind: ROUTE_ORIGIN_KIND, originId: "recovery:x", assigneeAgentId: null }), issue(blocked, "EX-502")]);
    await expect(s.triage.handle(enter(route, blocked))).resolves.toBe("not_eligible");
    await s.clock.advance(DEBOUNCE_MS);
    expect(s.create).not.toHaveBeenCalled();
    expect(s.invoke).not.toHaveBeenCalled();
  });

  it("event: the terminal is the plugin's daily-cap issue -> no routing issue, no wake", async () => {
    const s = make();
    const cap = next();
    const blocked = next();
    seed(s, [issue(cap, "EX-503", { originKind: CAP_ORIGIN_KIND, originId: "daily-cap:2026-01-02", assigneeAgentId: OTHER_AGENT_ID }), issue(blocked, "EX-504")]);
    await expect(s.triage.handle(enter(cap, blocked))).resolves.toBe("not_eligible");
    await s.clock.advance(DEBOUNCE_MS);
    expect(s.create).not.toHaveBeenCalled();
    expect(s.invoke).not.toHaveBeenCalled();
  });

  it("event: the terminal is assigned to the triage agent -> no routing issue, no wake", async () => {
    const s = make();
    const held = next();
    const blocked = next();
    seed(s, [issue(held, "EX-505", { assigneeAgentId: TRIAGE_AGENT.toUpperCase() }), issue(blocked, "EX-506")]);
    await expect(s.triage.handle(enter(held, blocked))).resolves.toBe("not_eligible");
    await s.clock.advance(DEBOUNCE_MS);
    expect(s.create).not.toHaveBeenCalled();
    expect(s.invoke).not.toHaveBeenCalled();
  });

  it("sweep: a blocked issue whose terminal is a plugin-own or triage-owned issue -> nothing queued", async () => {
    const s = make();
    const route = next();
    const held = next();
    const selfHeld = next();
    const a = next();
    const b = next();
    seed(s, [
      issue(route, "EX-511", { originKind: ROUTE_ORIGIN_KIND, originId: "recovery:y", assigneeAgentId: null, status: "todo" }),
      issue(held, "EX-512", { assigneeAgentId: TRIAGE_AGENT, status: "in_progress" }),
      // Source is its own terminal and the triage agent holds it.
      issue(selfHeld, "EX-513", { assigneeAgentId: TRIAGE_AGENT, ...attention(selfHeld) }),
      issue(a, "EX-514", attention(route)),
      // Terminal declared but not embedded: read with issues.get.
      issue(b, "EX-515", { blockerAttention: { state: "needs_attention", blockingTreeLive: false, terminalBlockerIssueId: held, terminalBlocker: { id: held } } }),
    ]);
    await expect(s.triage.sweepRecoveries()).resolves.toMatchObject({ queued: 0, errors: 0 });
    await s.clock.advance(DEBOUNCE_MS);
    expect(s.create).not.toHaveBeenCalled();
    expect(s.invoke).not.toHaveBeenCalled();
  });
});

describe("Change A keeps existing routing", () => {
  it("event: an unreadable (private) terminal is still routed as an episode", async () => {
    const s = make();
    const hidden = next();
    const blocked = next();
    seed(s, [issue(blocked, "EX-521")]);
    await expect(s.triage.handle(enter(hidden, blocked))).resolves.toBe("queued");
    await s.clock.advance(DEBOUNCE_MS);
    const all = await routes(s);
    expect(all).toHaveLength(1);
    expect(all[0].originId).toMatch(new RegExp(`^episode:blocker:${hidden}@`));
    expect(s.invoke).toHaveBeenCalledTimes(1);
  });

  it("sweep: a visible terminal that cannot be read is still routed as an episode", async () => {
    const s = make();
    const hidden = next();
    const blocked = next();
    seed(s, [issue(blocked, "EX-522", attention(hidden))]);
    await expect(s.triage.sweepRecoveries()).resolves.toMatchObject({ queued: 1 });
    await s.clock.advance(DEBOUNCE_MS);
    expect((await routes(s)).map((entry) => entry.originId)).toEqual([expect.stringMatching(new RegExp(`^episode:blocker:${hidden}@`))]);
    expect(s.invoke).toHaveBeenCalledTimes(1);
  });

  it("event: a human-owned terminal the triage agent does not hold still routes unblock_owner", async () => {
    const s = make();
    const terminal = next();
    const blocked = next();
    seed(s, [issue(terminal, "EX-523", { unblockDescriptor: { owner: "board", action: "Board decides" } }), issue(blocked, "EX-524")]);
    await expect(s.triage.handle(enter(terminal, blocked))).resolves.toBe("queued");
    await s.clock.advance(DEBOUNCE_MS);
    const all = await routes(s);
    expect(all).toHaveLength(1);
    expect(all[0].originId).toBe(`blocker:${terminal}:${BLOCKED_AT}`);
    expect(all[0].description).toContain("unblock_owner");
    expect(s.invoke).toHaveBeenCalledTimes(1);
  });

  it("sweep: an agent-held terminal (not the triage agent) is still routed", async () => {
    const s = make();
    const terminal = next();
    const blocked = next();
    seed(s, [issue(terminal, "EX-525", { status: "in_progress" }), issue(blocked, "EX-526", attention(terminal))]);
    await expect(s.triage.sweepRecoveries()).resolves.toMatchObject({ queued: 1 });
    await s.clock.advance(DEBOUNCE_MS);
    expect(await routes(s)).toHaveLength(1);
    expect(s.invoke).toHaveBeenCalledTimes(1);
  });
});

describe("Change B: an episode that re-enters within 2 h is not routed again", () => {
  it("enter -> wake -> exit -> enter within 2 h: one routing issue, one wake; after 2 h: a second of each", async () => {
    const s = make();
    const terminal = next();
    const blocked = next();
    seed(s, [issue(terminal, "EX-531"), issue(blocked, "EX-532")]);
    await expect(s.triage.handle(enter(terminal, blocked))).resolves.toBe("queued");
    await s.clock.advance(DEBOUNCE_MS);
    expect(s.invoke).toHaveBeenCalledTimes(1);
    const [first] = await routes(s);

    for (const gap of [60_000, 30 * 60_000, 60 * 60_000]) {
      await expect(s.triage.handle(exit(terminal))).resolves.toBe("episode_closed");
      s.clock.now += gap;
      await expect(s.triage.handle(enter(terminal, blocked))).resolves.toBe("duplicate");
      await s.clock.advance(DEBOUNCE_MS);
    }
    expect(await routes(s)).toHaveLength(1);
    expect(s.create).toHaveBeenCalledTimes(1);
    expect(s.invoke).toHaveBeenCalledTimes(1);
    // The reopened episode keeps its routing issue and its last wake time.
    const marker = await s.harness.ctx.state.get({ scopeKind: "company", scopeId: COMPANY_ID, namespace: "decision-triage", stateKey: `woken:episode:blocker:${terminal}` });
    expect(marker).toMatchObject({ open: true, routeIssueId: first.id });

    await s.triage.handle(exit(terminal));
    s.clock.now += COOLDOWN_MS;
    await expect(s.triage.handle(enter(terminal, blocked))).resolves.toBe("queued");
    await s.clock.advance(DEBOUNCE_MS);
    const all = await routes(s);
    expect(all).toHaveLength(2);
    expect(s.invoke).toHaveBeenCalledTimes(2);
    expect((s.invoke.mock.calls[1][2] as { prompt: string }).prompt).toContain(`routing issue ${all.find((entry) => entry.id !== first.id)!.id}`);
  });

  it("the sweep path honours the cooldown too", async () => {
    const s = make();
    const terminal = next();
    const blocked = next();
    seed(s, [issue(terminal, "EX-533", { status: "in_progress" }), issue(blocked, "EX-534", attention(terminal))]);
    await expect(s.triage.sweepRecoveries()).resolves.toMatchObject({ queued: 1 });
    await s.clock.advance(DEBOUNCE_MS);
    const [first] = await routes(s);
    // The triage agent started on it, so the routing issue is not closed as stale.
    await s.harness.ctx.issues.update(first.id, { status: "in_progress" }, COMPANY_ID);
    await s.triage.handle(exit(terminal));
    s.clock.now += 10 * 60_000;
    await expect(s.triage.sweepRecoveries()).resolves.toMatchObject({ queued: 0, duplicate: 1 });
    await s.clock.advance(DEBOUNCE_MS);
    expect(await routes(s)).toHaveLength(1);
    expect(s.invoke).toHaveBeenCalledTimes(1);
  });

  it("a stale routing issue cancelled by the sweep releases the episode, which routes normally when it returns", async () => {
    const s = make();
    const terminal = next();
    const blocked = next();
    seed(s, [issue(terminal, "EX-535"), issue(blocked, "EX-536")]);
    await s.triage.handle(enter(terminal, blocked));
    await s.clock.advance(DEBOUNCE_MS);
    await s.triage.handle(exit(terminal));
    await expect(s.triage.sweepRecoveries()).resolves.toMatchObject({ closed: 1 });
    await expect(s.triage.handle(enter(terminal, blocked))).resolves.toBe("queued");
    await s.clock.advance(DEBOUNCE_MS);
    const all = await routes(s);
    expect(all).toHaveLength(2);
    expect(all.filter((entry) => entry.status === "todo")).toHaveLength(1);
    expect(s.invoke).toHaveBeenCalledTimes(2);
  });
});

describe("replay of the 23 Nov 18:29-18:30 cascade", () => {
  it("routing issue blocked -> attention enter on it, repeated: no extra routing issue and no extra wake", async () => {
    const s = make();
    const terminal = next();
    const blocked = next();
    seed(s, [issue(terminal, "EX-541"), issue(blocked, "EX-542")]);
    await s.triage.handle(enter(terminal, blocked));
    await s.clock.advance(DEBOUNCE_MS);
    expect(s.invoke).toHaveBeenCalledTimes(1);
    const [route] = await routes(s);

    // The triage agent works the routing issue (the tree goes live) and then blocks it on the source.
    await s.triage.handle(exit(terminal));
    await s.harness.ctx.issues.update(route.id, { status: "blocked" }, COMPANY_ID);
    for (let round = 0; round < 4; round += 1) {
      // The host flags the routing issue's own tree as non-live, and the original tree re-enters.
      await s.triage.handle(enter(route.id, blocked));
      await s.triage.handle(enter(terminal, blocked));
      s.clock.now += 30_000;
      await s.clock.advance(DEBOUNCE_MS);
      await s.triage.handle(exit(route.id));
      await s.triage.handle(exit(terminal));
    }
    seed(s, [issue(blocked, "EX-542", attention(route.id))]);
    await s.triage.sweepRecoveries();
    await s.clock.advance(DEBOUNCE_MS);

    expect(s.create).toHaveBeenCalledTimes(1);
    expect(await routes(s)).toHaveLength(1);
    expect(s.invoke).toHaveBeenCalledTimes(1);
  });
});
