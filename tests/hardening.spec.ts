import { describe, expect, it } from "vitest";
import { MARKER_TTL_MS } from "../src/marker-index.js";
import { approvalCreated, BASE_CONFIG, boardBlocked, blockerAttentionEntered, blockerAttentionExited, COMPANY_ID, ISSUE_ID, setup, uuidN } from "./fixtures.js";

const DEBOUNCE_MS = 10_000;
const DAY = 24 * 60 * 60 * 1000;
const NO_FALLBACK = { ...BASE_CONFIG, triageIssueId: undefined };

function promptOf(call: unknown[]): string {
  return (call[2] as { prompt: string }).prompt;
}

async function missed(s: ReturnType<typeof setup>): Promise<Array<{ key: string }>> {
  const raw = (await s.harness.ctx.state.get({ scopeKind: "instance", namespace: "decision-triage", stateKey: "missed" })) as {
    items: Array<{ key: string }>;
  } | null;
  return raw?.items ?? [];
}

function woken(s: ReturnType<typeof setup>, key: string) {
  return s.harness.ctx.state.get({ scopeKind: "company", scopeId: COMPANY_ID, namespace: "decision-triage", stateKey: `woken:${key}` });
}

describe("items whose wake attempts all failed", () => {
  it("are kept in a durable missed list and carried by the next wake for the company", async () => {
    let fail = true;
    const s = setup({
      config: NO_FALLBACK,
      invoke: async () => {
        if (fail) throw new Error("busy");
        return { runId: "run-ok" };
      },
    });
    const first = approvalCreated(uuidN(1));
    await s.triage.handle(first);
    await s.clock.advance(DEBOUNCE_MS);
    await s.clock.advance(30_000);
    await s.clock.advance(30_000);
    expect(s.invoke).toHaveBeenCalledTimes(3);
    expect((await missed(s)).map((item) => item.key)).toEqual([`approval:${uuidN(1)}`]);
    expect(await woken(s, `approval:${uuidN(1)}`)).toBeNull();

    fail = false;
    // 0.3.0: the missed item backs off (5 min after its last failed round) before it rides along.
    await s.clock.advance(5 * 60 * 1000);
    await s.triage.handle(approvalCreated(uuidN(2)));
    await s.clock.advance(DEBOUNCE_MS);
    expect(s.invoke).toHaveBeenCalledTimes(4);
    const text = promptOf(s.invoke.mock.calls[3]);
    expect(text).toContain(uuidN(1));
    expect(text).toContain(uuidN(2));
    expect(await missed(s)).toHaveLength(0);
    expect(await woken(s, `approval:${uuidN(1)}`)).not.toBeNull();
  });

  it("survive a restart: start() queues them again", async () => {
    let fail = true;
    const s = setup({
      config: NO_FALLBACK,
      invoke: async () => {
        if (fail) throw new Error("busy");
        return { runId: "run-ok" };
      },
    });
    await s.triage.handle(approvalCreated(uuidN(1)));
    for (const ms of [DEBOUNCE_MS, 30_000, 30_000]) await s.clock.advance(ms);
    expect(await missed(s)).toHaveLength(1);
    s.triage.stop();
    s.timers.splice(0);
    fail = false;
    // 0.3.0: the back-off holds across a restart; once it has passed, start() queues the item again.
    s.clock.now += 5 * 60 * 1000;
    await s.make().start();
    await s.clock.advance(0);
    expect(s.invoke).toHaveBeenCalledTimes(4);
    expect(promptOf(s.invoke.mock.calls[3])).toContain(uuidN(1));
    expect(await missed(s)).toHaveLength(0);
  });

  it("a feed item that left the board is removed from the missed list", async () => {
    const s = setup({
      config: NO_FALLBACK,
      invoke: async () => {
        throw new Error("busy");
      },
    });
    await s.triage.handle(blockerAttentionEntered());
    for (const ms of [DEBOUNCE_MS, 30_000, 30_000]) await s.clock.advance(ms);
    expect(await missed(s)).toHaveLength(1);
    await s.triage.handle(blockerAttentionExited());
    expect(await missed(s)).toHaveLength(0);
  });
});

describe("timer handles", () => {
  it("a flush run outside the timer clears the armed timer before re-arming", async () => {
    const s = setup();
    await s.triage.handle(approvalCreated(uuidN(1)));
    expect(s.timers).toHaveLength(1);
    await s.triage.flushDue();
    expect(s.timers).toHaveLength(1);
    await s.clock.advance(DEBOUNCE_MS);
    expect(s.invoke).toHaveBeenCalledTimes(1);
    expect(s.timers).toHaveLength(0);
  });
});

describe("marker pruning", () => {
  it("prunes woken and cap markers untouched for 30 days; keeps fresh ones", async () => {
    const s = setup();
    await s.triage.handle(approvalCreated(uuidN(1)));
    await s.clock.advance(DEBOUNCE_MS);
    s.clock.now += 20 * DAY;
    await s.triage.handle(approvalCreated(uuidN(2)));
    await s.clock.advance(DEBOUNCE_MS);
    s.clock.now += 11 * DAY;
    // woken:approval-1 and the first day's cap marker.
    await expect(s.triage.markers.prune()).resolves.toBe(2);
    expect(await woken(s, `approval:${uuidN(1)}`)).toBeNull();
    expect(await woken(s, `approval:${uuidN(2)}`)).not.toBeNull();
  });

  it("a duplicate event refreshes the age, so dedupe holds for an item that keeps producing events", async () => {
    const s = setup();
    await s.triage.handle(approvalCreated(uuidN(1)));
    await s.clock.advance(DEBOUNCE_MS);
    for (let i = 0; i < 4; i += 1) {
      s.clock.now += 10 * DAY;
      await expect(s.triage.handle(approvalCreated(uuidN(1)))).resolves.toBe("duplicate");
    }
    await s.triage.markers.prune();
    expect(await woken(s, `approval:${uuidN(1)}`)).not.toBeNull();
    expect(s.invoke).toHaveBeenCalledTimes(1);
  });

  it("keeps a live human-owned block and an open episode past the age; prunes them once resolved", async () => {
    const s = setup();
    await s.triage.handle(boardBlocked());
    await s.triage.handle(blockerAttentionEntered());
    await s.clock.advance(DEBOUNCE_MS);
    s.clock.now += MARKER_TTL_MS + DAY;
    await expect(s.triage.markers.prune()).resolves.toBe(1); // the cap marker only
    await expect(s.triage.handle(boardBlocked())).resolves.toBe("duplicate");

    const issue = (await s.harness.ctx.issues.get(ISSUE_ID, COMPANY_ID)) as { status: string };
    issue.status = "in_progress";
    await s.triage.handle(blockerAttentionExited());
    s.clock.now += MARKER_TTL_MS + DAY;
    await expect(s.triage.markers.prune()).resolves.toBe(2);
    expect(s.invoke).toHaveBeenCalledTimes(1);
  });
});
