// Regression: on the live host the scheduled sweep failed with `the worker referenced a missing,
// expired, or unknown invocation scope`. The SDK stamps each host call with the AsyncLocalStorage
// invocation in scope, and a timer callback inherits the async context that armed it. This fake host
// enforces scopes like Paperclip: a call stamped with an ended invocation is refused; a call with no
// invocation at all is proactive work for a configured company and is allowed. The fixture's timers
// keep the arming context (`timerContext`), as Node's real setTimeout does.
import { AsyncLocalStorage } from "node:async_hooks";
import { describe, expect, it } from "vitest";
import { ROUTE_ORIGIN_KIND, detached } from "../src/triage.js";
import { BASE_CONFIG, COMPANY_ID, boardBlocked, setup, type Setup } from "./fixtures.js";

const MIN = 60_000;
const HOST_APIS = ["companies", "config", "issues", "agents", "state"] as const;

function scopedHost(s: Setup) {
  const als = new AsyncLocalStorage<{ id: number; active: boolean }>();
  let next = 0;
  const violations: string[] = [];
  const calls: string[] = [];
  const ctx = s.harness.ctx as unknown as Record<string, Record<string, unknown>>;
  for (const api of HOST_APIS) {
    const target = ctx[api];
    for (const name of Object.keys(target)) {
      const real = target[name];
      if (typeof real !== "function") continue;
      const method = `${api}.${name}`;
      target[name] = (...args: unknown[]) => {
        calls.push(method);
        const inv = als.getStore();
        if (inv && !inv.active) {
          violations.push(method);
          return Promise.reject(new Error(`Plugin "test" is not allowed to perform "${method}": the worker referenced a missing, expired, or unknown invocation scope`));
        }
        return (real as (...a: unknown[]) => unknown).apply(target, args);
      };
    }
  }
  /** Runs fn as one host invocation; its scope expires when fn settles. */
  async function invoke<T>(fn: () => Promise<T> | T): Promise<T> {
    const inv = { id: ++next, active: true };
    try {
      return await als.run(inv, async () => fn());
    } finally {
      inv.active = false;
    }
  }
  return { als, invoke, violations, calls };
}

async function routes(s: Setup) {
  return (await s.harness.ctx.issues.list({ companyId: COMPANY_ID, originKind: ROUTE_ORIGIN_KIND, limit: 50 } as never)).filter(
    (issue) => (issue as unknown as { originKind?: string }).originKind === ROUTE_ORIGIN_KIND,
  );
}

describe("timer work never runs from an expired invocation scope", () => {
  it("detached() drops the invocation in scope; a host call after the invocation ended succeeds through it", async () => {
    const s = setup({ timerContext: true });
    const host = scopedHost(s);
    let later: (() => Promise<unknown>) | null = null;
    await host.invoke(() => {
      later = () => s.harness.ctx.issues.list({ companyId: COMPANY_ID } as never);
    });
    const run = later as unknown as () => Promise<unknown>;
    // Negative control: the closure still carries the ended invocation and is refused.
    await expect(host.als.run({ id: 99, active: false }, run)).rejects.toThrow(/invocation scope/);
    await expect(host.als.run({ id: 99, active: false }, () => detached(run))).resolves.toBeDefined();
    expect(host.violations).toEqual(["issues.list"]);
  });

  it("the scheduled sweep armed inside the configuring invocation routes a missed item once, after that invocation ended", async () => {
    const s = setup({ sweepIntervalMs: 5 * MIN, timerContext: true });
    const host = scopedHost(s);
    // start() and the config replay run inside an invocation that then ends.
    await host.invoke(async () => {
      await s.triage.start();
      s.triage.noteConfigChanged(COMPANY_ID, BASE_CONFIG);
    });
    await s.clock.advance(30_000); // first scheduled sweep
    await s.clock.advance(MIN); // its debounced flush
    expect(s.invoke).toHaveBeenCalledTimes(1);
    expect(await routes(s)).toHaveLength(1);
    await s.clock.advance(5 * MIN); // next scheduled sweep: no duplicate
    await s.clock.advance(MIN);
    expect(s.invoke).toHaveBeenCalledTimes(1);
    expect(await routes(s)).toHaveLength(1);
    expect(host.violations).toEqual([]);
    expect(host.calls).toContain("issues.list");
    expect(s.harness.logs.filter((entry) => entry.message === "decision triage: recovery sweep failed")).toHaveLength(0);
    expect(s.harness.logs.filter((entry) => entry.message === "decision triage: sweep finished").map((entry) => entry.meta?.companies)).toEqual([1, 1]);
    s.triage.stop(true);
  });

  it("the debounced flush armed inside an event invocation wakes after that invocation ended", async () => {
    const s = setup({ timerContext: true });
    const host = scopedHost(s);
    await host.invoke(() => s.triage.handle(boardBlocked()));
    const before = host.calls.length;
    await s.clock.advance(5 * MIN); // past the debounce window
    expect(host.calls.length).toBeGreaterThan(before);
    expect(s.invoke).toHaveBeenCalledTimes(1);
    expect(host.violations).toEqual([]);
    expect(s.harness.logs.filter((entry) => entry.message === "decision triage: flush failed")).toHaveLength(0);
  });
});

