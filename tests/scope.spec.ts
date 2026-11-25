import { describe, expect, it, vi } from "vitest";
import { ROUTE_ORIGIN_KIND } from "../src/triage.js";
import { BASE_CONFIG, COMPANY_ID, setup, type Setup } from "./fixtures.js";

// Synthetic identifiers only.
const OTHER_COMPANY_ID = "00000000-0000-4000-8000-000000000002";
const SCOPE_DENIED = 'Plugin "x" is not allowed to perform "companies.list": the worker referenced a missing, expired, or unknown invocation scope';
const MIN = 60_000;

/**
 * Models the deployed host (2026.1106.0) for the timer-driven sweep, which runs
 * outside any host invocation: while an event invocation of the worker is open,
 * an unscoped `companies.list` is denied, and a call that names a company is
 * admitted only for a configured company. A second company exists in the list
 * but has no stored config.
 */
function host(s: Setup, opts: { configured?: string[]; listed?: Array<{ id: string }> } = {}) {
  const load = { active: false };
  const configured = new Set(opts.configured ?? [COMPANY_ID]);
  const listed = opts.listed ?? [{ id: COMPANY_ID }, { id: OTHER_COMPANY_ID }];
  const listSpy = vi.fn(async () => {
    if (load.active) throw new Error(SCOPE_DENIED);
    return listed as never;
  });
  s.harness.ctx.companies.list = listSpy as never;
  const calls: Array<{ method: string; companyId: string | undefined }> = [];
  const gate = (method: string, companyId: string | undefined) => {
    calls.push({ method, companyId });
    if (load.active && (!companyId || !configured.has(companyId))) throw new Error("company context is required");
  };
  const configGet = s.harness.ctx.config.get.bind(s.harness.ctx.config);
  s.harness.ctx.config.get = (async (companyId?: string) => {
    gate("config.get", companyId);
    return companyId && configured.has(companyId) ? configGet(companyId as never) : {};
  }) as never;
  const issuesList = s.harness.ctx.issues.list.bind(s.harness.ctx.issues);
  s.harness.ctx.issues.list = (async (input: { companyId: string }) => {
    gate("issues.list", input.companyId);
    return issuesList(input as never);
  }) as never;
  return { load, listSpy, calls };
}

function logged(s: Setup, message: string) {
  return s.harness.logs.filter((entry) => entry.message === message);
}

async function routes(s: Setup) {
  return (await s.harness.ctx.issues.list({ companyId: COMPANY_ID, originKind: ROUTE_ORIGIN_KIND, limit: 50 } as never)).filter(
    (issue) => (issue as unknown as { originKind?: string }).originKind === ROUTE_ORIGIN_KIND,
  );
}

describe("sweep company enumeration (no invocation scope)", () => {
  it("sweeps the company learned from the start-up config replay under event load, routes a missed item once, and repeats with no duplicate", async () => {
    const s = setup();
    const { load, listSpy, calls } = host(s);
    await s.triage.start();
    // start() itself makes no company call: no list, no config read of any company.
    expect(listSpy).not.toHaveBeenCalled();
    expect(calls).toHaveLength(0);
    s.triage.noteConfigChanged(COMPANY_ID, BASE_CONFIG); // the host replays each stored config after start
    load.active = true; // events keep arriving from here on
    const first = await s.triage.sweepRecoveries();
    expect(first).toMatchObject({ source: "configured", candidates: 1, companies: 1, queued: 1, errors: 0 });
    await s.clock.advance(MIN);
    expect(s.invoke).toHaveBeenCalledTimes(1);
    expect(await routes(s)).toHaveLength(1);
    await s.clock.advance(5 * MIN);
    const second = await s.triage.sweepRecoveries();
    expect(second).toMatchObject({ source: "configured", companies: 1, queued: 0 });
    await s.clock.advance(MIN);
    expect(s.invoke).toHaveBeenCalledTimes(1);
    expect(await routes(s)).toHaveLength(1);
    expect(listSpy).not.toHaveBeenCalled(); // the sweep never needed the list
    // The unconfigured company is never read or written once the set is known.
    expect(calls.filter((call) => call.companyId === OTHER_COMPANY_ID)).toHaveLength(0);
    expect(calls.filter((call) => call.companyId === undefined)).toHaveLength(0);
    const finished = logged(s, "decision triage: sweep finished");
    expect(finished.at(-1)?.meta).toMatchObject({ source: "configured", companies: 1, queued: 0 });
    // Counts only: no ids in the summary.
    expect(JSON.stringify(finished.map((entry) => entry.meta))).not.toContain(COMPANY_ID);
    expect(logged(s, "decision triage: company enumeration failed; nothing swept")).toHaveLength(0);
    s.triage.stop(true);
  });

  it("with nothing learned under event load the fallback list is denied: warned, nothing swept; the hook then fixes it", async () => {
    const s = setup();
    const { load } = host(s);
    load.active = true;
    await s.triage.start();
    expect(await s.triage.sweepRecoveries()).toMatchObject({ source: "list_failed", companies: 0, queued: 0 });
    const failed = logged(s, "decision triage: company enumeration failed; nothing swept");
    expect(failed).toHaveLength(1);
    expect(failed[0].meta).toMatchObject({ outcome: "company_list_failed", errorName: "Error" });
    expect(JSON.stringify(failed[0].meta)).not.toContain(COMPANY_ID);
    s.triage.noteConfigChanged(COMPANY_ID, BASE_CONFIG); // e.g. the host's start-up replay or a save
    expect(await s.triage.sweepRecoveries()).toMatchObject({ source: "configured", companies: 1, queued: 1 });
    s.triage.stop(true);
  });

  it("forgets a company whose config is cleared, adds it back, and ignores ids that are not UUIDs", async () => {
    const s = setup();
    const { load } = host(s);
    s.triage.noteConfigChanged(COMPANY_ID, BASE_CONFIG);
    load.active = true;
    expect(await s.triage.sweepRecoveries()).toMatchObject({ source: "configured", candidates: 1 });
    s.triage.noteConfigChanged(COMPANY_ID, {});
    expect(await s.triage.sweepRecoveries()).toMatchObject({ source: "list_failed", candidates: 0, companies: 0 });
    s.triage.noteConfigChanged(COMPANY_ID.toUpperCase(), BASE_CONFIG);
    expect(await s.triage.sweepRecoveries()).toMatchObject({ source: "configured", candidates: 1, companies: 1 });
    s.triage.noteConfigChanged("acme", BASE_CONFIG);
    s.triage.noteConfigChanged(null, BASE_CONFIG);
    s.triage.noteConfigChanged(undefined, BASE_CONFIG);
    s.triage.noteConfigChanged(`${OTHER_COMPANY_ID}; drop`, BASE_CONFIG);
    expect(await s.triage.sweepRecoveries()).toMatchObject({ source: "configured", candidates: 1 });
  });

  it("falls back to the company list when nothing is learned, skipping unconfigured companies and ids that are not UUIDs", async () => {
    const s = setup();
    const { listSpy, calls } = host(s, { listed: [{ id: COMPANY_ID }, { id: OTHER_COMPANY_ID }, { id: "acme" }] });
    const outcome = await s.triage.sweepRecoveries();
    expect(listSpy).toHaveBeenCalledTimes(1);
    expect(outcome).toMatchObject({ source: "list", candidates: 2, companies: 1, noConfig: 1, queued: 1 });
    expect(calls.some((call) => call.companyId === "acme")).toBe(false);
    // The unconfigured company's config is read (empty) and nothing else.
    expect(calls.filter((call) => call.companyId === OTHER_COMPANY_ID).map((call) => call.method)).toEqual(["config.get"]);
  });

  it("logs an empty enumeration with an outcome code", async () => {
    const s = setup();
    host(s, { listed: [] });
    expect(await s.triage.sweepRecoveries()).toMatchObject({ source: "list", candidates: 0, companies: 0 });
    const empty = logged(s, "decision triage: no companies to sweep");
    expect(empty).toHaveLength(1);
    expect(empty[0].meta).toMatchObject({ outcome: "no_companies" });
  });

  it("kill switch under event load: the configured company is counted as disabled, with no side effects", async () => {
    const s = setup({ config: { ...BASE_CONFIG, enabled: false } });
    const { load } = host(s);
    s.triage.noteConfigChanged(COMPANY_ID, { ...BASE_CONFIG, enabled: false });
    load.active = true;
    expect(await s.triage.sweepRecoveries()).toMatchObject({ source: "configured", candidates: 1, disabled: 1, companies: 0, queued: 0 });
    await s.clock.advance(MIN);
    expect(s.invoke).not.toHaveBeenCalled();
    expect(await routes(s)).toHaveLength(0);
    expect(await s.harness.ctx.state.get({ scopeKind: "instance", namespace: "decision-triage", stateKey: "pending" })).toBeNull();
  });

  it("the timer-driven sweep uses the configured set (scheduled path, no manual call)", async () => {
    const s = setup({ sweepIntervalMs: 5 * MIN });
    const { load, listSpy } = host(s);
    await s.triage.start();
    s.triage.noteConfigChanged(COMPANY_ID, BASE_CONFIG);
    load.active = true;
    await s.clock.advance(30_000); // first scheduled sweep
    await s.clock.advance(MIN);
    expect(s.invoke).toHaveBeenCalledTimes(1);
    await s.clock.advance(5 * MIN); // next scheduled sweep
    await s.clock.advance(MIN);
    expect(s.invoke).toHaveBeenCalledTimes(1);
    expect(listSpy).not.toHaveBeenCalled();
    expect(logged(s, "decision triage: recovery sweep failed")).toHaveLength(0);
    expect(logged(s, "decision triage: sweep finished").map((entry) => entry.meta?.companies)).toEqual([1, 1]);
    s.triage.stop(true);
  });
});
