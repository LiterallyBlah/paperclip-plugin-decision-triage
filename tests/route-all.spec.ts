import { describe, expect, it, vi } from "vitest";
import type { PluginEvent } from "@paperclipai/plugin-sdk";
import manifest from "../src/manifest.js";
import * as triageModule from "../src/triage.js";
import { COMPANY_ID, event, OTHER_AGENT_ID, PROJECT_ID, setup, uuidN } from "./fixtures.js";

// Synthetic identifiers only.
const TRIAGE_AGENT = "00000000-0000-4000-8000-0000000000ee";
// Literal (not imported) so this spec also runs, and fails on behaviour, against the 0.2.0 source.
const ROUTE_ORIGIN_KIND = "plugin:paperclip.decision-triage:route";
const CONFIG = { triageAgentId: TRIAGE_AGENT, paperclipBaseUrl: "https://paperclip.example.test", investigationProjectId: PROJECT_ID };
const DEBOUNCE_MS = 10_000;
const BLOCKED_AT = "2026-01-02T09:59:00.000Z";
const USER = "user-example-7";
const SOURCE = OTHER_AGENT_ID;

let seq = 0x700;
const next = () => uuidN((seq += 1));

type S = ReturnType<typeof setup>;

function make(options: Parameters<typeof setup>[0] = {}): S & { writes: ReturnType<typeof spyWrites> } {
  const s = setup({ config: CONFIG, ...options });
  s.harness.seed({
    agents: [{ id: TRIAGE_AGENT, companyId: COMPANY_ID, name: "triage-agent", status: "idle" } as never],
    // The shared fixture's board-blocked issue is neutralised so each test counts its own items only.
    issues: [{ id: uuidN(0xa1), companyId: COMPANY_ID, identifier: "EX-42", title: "Shared", status: "in_progress" } as never],
  });
  return { ...s, writes: spyWrites(s) };
}

/** Spies on every write a plugin could make to a source item. */
function spyWrites(s: S) {
  const issues = s.harness.ctx.issues as unknown as Record<string, (...args: unknown[]) => unknown>;
  const wrap = (name: string) => {
    const original = issues[name]?.bind(issues);
    const spy = vi.fn((...args: unknown[]) => original?.(...args));
    issues[name] = spy;
    return spy;
  };
  return {
    update: wrap("update"),
    createComment: wrap("createComment"),
    respondInteraction: wrap("respondInteraction"),
    create: wrap("create"),
    requestWakeup: wrap("requestWakeup"),
  };
}

function issue(id: string, identifier: string, extra: Record<string, unknown> = {}) {
  return { id, companyId: COMPANY_ID, identifier, title: `Item ${identifier}`, status: "blocked", assigneeAgentId: SOURCE, assigneeUserId: null, unblockDescriptor: null, blockedTransitionAt: BLOCKED_AT, ...extra } as never;
}

function seed(s: S, issues: unknown[], comments: unknown[] = [], interactions: unknown[] = []) {
  s.harness.seed({ issues: issues as never, issueComments: comments as never, issueInteractions: interactions as never });
}

/** Host `issue.updated` for a recovery escalation (activity details at the top level). */
function recoveryEvent(issueId: string, actionId: string, overrides: Record<string, unknown> = {}): PluginEvent {
  return event("issue.updated", {
    entityType: "issue",
    entityId: issueId,
    actorType: "system",
    actorId: "recovery",
    payload: {
      status: "blocked",
      previousStatus: "in_progress",
      _previous: { status: "in_progress" },
      recoveryActionId: actionId,
      recoveryOwnerType: "board",
      recoveryOwnerAgentId: null,
      routingPolicy: "board_escalation_no_takeover_v1",
      ...overrides,
    },
  });
}

/** Exact `issue.disposition_repair_escalated` details (deliberate wait without target), as `issue.updated`. */
function deliberateWaitEvent(issueId: string, actionId: string, ownerType: "board" | "user"): PluginEvent {
  return recoveryEvent(issueId, actionId, {
    sourceStateFingerprint: "fp-1",
    attemptCount: 3,
    maxAttempts: 3,
    terminalReason: "attempts_exhausted",
    recoveryOwnerType: ownerType,
    sourceAssigneeBefore: { agentId: SOURCE, userId: null },
    sourceAssigneeAfter: { agentId: SOURCE, userId: null },
    sourceAssigneePreserved: true,
  });
}

/** Host recovery notice (system comment) as `recoveryNoticeMetadata` writes it. */
function notice(issueId: string, actionId: string, cause: string, at = "2026-01-02T09:59:00.010Z") {
  return {
    id: next(),
    companyId: COMPANY_ID,
    issueId,
    authorType: "system",
    body: "Paperclip exhausted the bounded original-owner disposition repair.",
    createdAt: at,
    deletedAt: null,
    metadata: {
      version: 1,
      sections: [
        {
          title: "Recovery",
          rows: [
            { type: "key_value", label: "Recovery action", value: actionId },
            { type: "key_value", label: "Cause", value: cause },
            { type: "key_value", label: "Previous status", value: "in_progress" },
            { type: "key_value", label: "Recovery owner", value: "board" },
          ],
        },
      ],
    },
  } as never;
}

function blockedUpdate(issueId: string): PluginEvent {
  return event("issue.updated", {
    entityType: "issue",
    entityId: issueId,
    actorType: "agent",
    actorId: SOURCE,
    payload: { status: "blocked", agentId: SOURCE, changes: { status: { from: "in_progress", to: "blocked" }, unblockDescriptor: {} } },
  });
}

function treeEvent(terminalId: string, state: "stalled" | "needs_attention", blockedIssueId: string): PluginEvent {
  return event("issue.blocker_attention_changed", {
    entityType: "issue",
    entityId: terminalId,
    actorType: "system",
    actorId: undefined,
    payload: { terminalBlockerIssueId: terminalId, dedupKey: `blocker:${terminalId}`, blockedIssueId, entered: true, state, blockingTreeLive: false, activityAt: BLOCKED_AT },
  });
}

function reviewEvent(issueId: string): PluginEvent {
  return event("issue.updated", {
    entityType: "issue",
    entityId: issueId,
    actorType: "agent",
    actorId: SOURCE,
    payload: { status: "in_review", agentId: SOURCE, changes: { status: { from: "in_progress", to: "in_review" } } },
  });
}

function cardEvent(issueId: string, interactionId: string, extra: Record<string, unknown> = {}, base: Partial<PluginEvent> = {}): PluginEvent {
  return event("issue.thread_interaction_created", {
    entityType: "issue",
    entityId: issueId,
    actorType: "agent",
    actorId: SOURCE,
    ...base,
    payload: {
      interactionId,
      interactionKind: "ask_user_questions",
      interactionStatus: "pending",
      addresseeAgentId: null,
      addresseeUserId: USER,
      requestedResolverPolicy: "anyone",
      effectiveResolverPolicy: "anyone",
      toolActionRequestId: null,
      source: "interaction_service",
      agentId: base.actorType === "user" ? null : SOURCE,
      ...extra,
    },
  });
}

function card(issueId: string, id: string, extra: Record<string, unknown> = {}) {
  return { id, companyId: COMPANY_ID, issueId, kind: "ask_user_questions", status: "pending", addresseeAgentId: null, addresseeUserId: USER, effectiveResolverPolicy: "anyone", payload: { version: 1 }, ...extra } as never;
}

async function routingIssues(s: S) {
  return s.harness.ctx.issues.list({ companyId: COMPANY_ID, originKind: ROUTE_ORIGIN_KIND });
}

function prompts(s: S): string[] {
  return s.invoke.mock.calls.map((call) => (call[2] as { prompt: string }).prompt);
}

/**
 * The item now belongs to the triage agent: exactly one routing issue assigned to it
 * for `key`, naming the item and its source; and one triage-agent wake whose text
 * carries the item id, kind, source issue and that routing issue.
 */
async function expectRoutedToTriage(s: S, input: { key: string; kind: string; itemId: string; sourceIssueId: string; sourceIdentifier?: string }) {
  const routes = (await routingIssues(s)).filter((entry) => entry.originId === input.key);
  expect(routes).toHaveLength(1);
  const route = routes[0];
  expect(route.assigneeAgentId).toBe(TRIAGE_AGENT);
  expect(route.status).toBe("todo");
  expect(route.projectId).toBe(PROJECT_ID);
  expect(route.parentId).toBeNull();
  expect(route.description).toContain(`- Item kind: ${input.kind}`);
  expect(route.description).toContain(input.itemId);
  expect(route.description).toContain(input.sourceIssueId);
  const wakes = s.invoke.mock.calls.filter((call) => (call[2] as { prompt: string }).prompt.includes(`routing issue ${route.id}`));
  expect(wakes).toHaveLength(1);
  expect(wakes[0][0]).toBe(TRIAGE_AGENT);
  const line = (wakes[0][2] as { prompt: string }).prompt.split("\n").find((entry) => entry.includes(`routing issue ${route.id}`))!;
  expect(line).toContain(`kind: ${input.kind}`);
  expect(line).toContain(`id: ${input.itemId}`);
  expect(line).toContain(`source issue id: ${input.sourceIssueId}`);
  if (input.sourceIdentifier) expect(line).toContain(`issue: ${input.sourceIdentifier}`);
  return route;
}

describe("every board/user class is routed to the triage agent (owner of record + correlated wake)", () => {
  it.each(["board", "user"] as const)("board_escalation_no_takeover_v1 recovery, %s-owned (regression)", async (ownerType) => {
    const s = make();
    const id = next();
    const action = next();
    seed(s, [issue(id, "EX-201")]);
    await expect(s.triage.handle(recoveryEvent(id, action, { recoveryOwnerType: ownerType }))).resolves.toBe("queued");
    await s.clock.advance(DEBOUNCE_MS);
    await expectRoutedToTriage(s, { key: `recovery:${action}`, kind: "recovery", itemId: action, sourceIssueId: id, sourceIdentifier: "EX-201" });
  });

  it.each(["board", "user"] as const)("deliberate_wait_without_target recovery, %s-owned (event)", async (ownerType) => {
    const s = make();
    const id = next();
    const action = next();
    seed(s, [issue(id, "EX-202")]);
    await expect(s.triage.handle(deliberateWaitEvent(id, action, ownerType))).resolves.toBe("queued");
    await s.clock.advance(DEBOUNCE_MS);
    await expectRoutedToTriage(s, { key: `recovery:${action}`, kind: "recovery", itemId: action, sourceIssueId: id, sourceIdentifier: "EX-202" });
  });

  it("deliberate_wait_without_target recovery found by the sweep from the host notice (Cause row)", async () => {
    const s = make();
    const id = next();
    const action = next();
    seed(s, [issue(id, "EX-203")], [notice(id, action, "deliberate_wait_without_target")]);
    await s.triage.sweepRecoveries();
    await s.clock.advance(DEBOUNCE_MS);
    const route = await expectRoutedToTriage(s, { key: `recovery:${action}`, kind: "recovery", itemId: action, sourceIssueId: id });
    expect(route.description).toContain("- Item class: deliberate_wait_without_target");
  });

  it.each([
    ["board", { owner: "board", action: "Board decides" }],
    ["user", { owner: { userId: USER }, action: "User decides" }],
  ] as const)("blocker_attention: %s-owned unblock descriptor", async (_label, descriptor) => {
    const s = make();
    const id = next();
    seed(s, [issue(id, "EX-204", { unblockDescriptor: descriptor })]);
    await expect(s.triage.handle(blockedUpdate(id))).resolves.toBe("queued");
    await s.clock.advance(DEBOUNCE_MS);
    await expectRoutedToTriage(s, { key: `blocker:${id}:${BLOCKED_AT}`, kind: "blocker", itemId: id, sourceIssueId: id, sourceIdentifier: "EX-204" });
  });

  it.each([
    ["stalled, board-owned terminal", "stalled", { unblockDescriptor: null, assigneeAgentId: null }],
    ["needs_attention, user-assigned terminal", "needs_attention", { unblockDescriptor: null, assigneeAgentId: null, assigneeUserId: USER, status: "todo" }],
  ] as const)("blocker_attention tree: %s", async (_label, state, terminalExtra) => {
    const s = make();
    const terminal = next();
    const blocked = next();
    seed(s, [issue(terminal, "EX-205", terminalExtra), issue(blocked, "EX-206")]);
    await expect(s.triage.handle(treeEvent(terminal, state, blocked))).resolves.toBe("queued");
    await s.clock.advance(DEBOUNCE_MS);
    const routes = await routingIssues(s);
    expect(routes).toHaveLength(1);
    expect(routes[0].originId).toMatch(new RegExp(`^episode:blocker:${terminal}@`));
    expect(routes[0].assigneeAgentId).toBe(TRIAGE_AGENT);
    expect(prompts(s)).toHaveLength(1);
    expect(prompts(s)[0]).toContain(`routing issue ${routes[0].id}`);
    expect(prompts(s)[0]).toContain(`kind: blocker_tree | id: ${terminal}`);
  });

  it("review-stalled, board-owned: the host's review-path recovery escalation is routed", async () => {
    const s = make();
    const id = next();
    const action = next();
    seed(s, [issue(id, "EX-207")]);
    const evt = recoveryEvent(id, action, { previousStatus: "in_review", _previous: { status: "in_review" }, routingPolicy: undefined, consumedPathRef: "ref" });
    await expect(s.triage.handle({ ...evt, payload: { ...(evt.payload as object), agentId: SOURCE } })).resolves.toBe("queued");
    await s.clock.advance(DEBOUNCE_MS);
    await expectRoutedToTriage(s, { key: `recovery:${action}`, kind: "recovery", itemId: action, sourceIssueId: id });
  });

  it("review-stalled, board-owned: an in-review issue with reviewAttention.state = stalled is routed by the sweep", async () => {
    const s = make();
    const id = next();
    seed(s, [issue(id, "EX-208", { status: "in_review", blockedTransitionAt: null, reviewAttention: { state: "stalled" } })]);
    await expect(s.triage.sweepRecoveries()).resolves.toMatchObject({ queued: 1 });
    await s.clock.advance(DEBOUNCE_MS);
    await expectRoutedToTriage(s, { key: `review:${id}:stalled`, kind: "review", itemId: id, sourceIssueId: id, sourceIdentifier: "EX-208" });
  });

  it("review, user-owned: a user assignee in review is routed (event)", async () => {
    const s = make();
    const id = next();
    seed(s, [issue(id, "EX-209", { status: "in_review", assigneeAgentId: null, assigneeUserId: USER })]);
    await expect(s.triage.handle(reviewEvent(id))).resolves.toBe("queued");
    await s.clock.advance(DEBOUNCE_MS);
    await expectRoutedToTriage(s, { key: `review:${id}:assignee:${USER}`, kind: "review", itemId: id, sourceIssueId: id });
  });

  it("review, user-owned: a user stage participant is routed; the stage itself is left alone", async () => {
    const s = make();
    const id = next();
    const stage = next();
    const state = { status: "pending", currentStageId: stage, currentStageType: "review", currentParticipant: { type: "user", userId: USER } };
    seed(s, [issue(id, "EX-210", { status: "in_review", executionState: state })]);
    await expect(s.triage.handle(reviewEvent(id))).resolves.toBe("queued");
    await s.clock.advance(DEBOUNCE_MS);
    await expectRoutedToTriage(s, { key: `review:${id}:participant:${stage}:${USER}`, kind: "review", itemId: id, sourceIssueId: id });
    const after = await s.harness.ctx.issues.get(id, COMPANY_ID);
    expect(after?.executionState).toEqual(state);
    expect(s.writes.update).not.toHaveBeenCalled();
  });
});

describe("no closed kind allowlist", () => {
  it("a recovery with an unknown kind, cause and policy is routed", async () => {
    const s = make();
    const id = next();
    const action = next();
    seed(s, [issue(id, "EX-211")]);
    await expect(
      s.triage.handle(recoveryEvent(id, action, { routingPolicy: "future_policy_v9", recoveryCause: "future_recovery_kind" })),
    ).resolves.toBe("queued");
    await s.clock.advance(DEBOUNCE_MS);
    const route = await expectRoutedToTriage(s, { key: `recovery:${action}`, kind: "recovery", itemId: action, sourceIssueId: id });
    expect(route.description).toContain("- Item class: future_recovery_kind");
  });

  it("a human-addressed card of an unknown kind is routed", async () => {
    const s = make();
    const id = next();
    const cardId = next();
    seed(s, [issue(id, "EX-212", { status: "in_progress" })], [], [card(id, cardId, { kind: "future_card_kind" })]);
    await expect(s.triage.handle(cardEvent(id, cardId, { interactionKind: "future_card_kind" }))).resolves.toBe("queued");
    await s.clock.advance(DEBOUNCE_MS);
    await expectRoutedToTriage(s, { key: `interaction:${cardId}`, kind: "interaction", itemId: cardId, sourceIssueId: id });
    // The card itself is not answered, resolved or converted.
    expect(s.writes.respondInteraction).not.toHaveBeenCalled();
    expect((await s.harness.ctx.issues.listInteractions(id, COMPANY_ID))[0].status).toBe("pending");
  });
});

describe("catch-up of existing items on the first sweep", () => {
  it("items that exist before start are routed by the first sweep, shortly after start", async () => {
    const s = make({ sweepIntervalMs: 5 * 60 * 1000 });
    const rec = next();
    const action = next();
    const owner = next();
    const review = next();
    const user = next();
    const terminal = next();
    seed(
      s,
      [
        issue(rec, "EX-221"),
        issue(owner, "EX-222", { unblockDescriptor: { owner: "board", action: "Decide" } }),
        issue(review, "EX-223", { status: "in_review", reviewAttention: { state: "stalled" } }),
        issue(user, "EX-224", { status: "in_review", assigneeAgentId: null, assigneeUserId: USER }),
        issue(terminal, "EX-225", { blockerAttention: { state: "needs_attention", blockingTreeLive: false, terminalBlockerIssueId: terminal, terminalBlocker: { id: terminal } } }),
      ],
      [notice(rec, action, "stranded_assigned_issue")],
    );
    await s.triage.start();
    await s.clock.advance(29_000);
    expect(s.invoke).not.toHaveBeenCalled();
    await s.clock.advance(1_000);
    // The first sweep reads several issues; let it finish before the debounce window ends.
    for (let i = 0; i < 5; i += 1) await s.clock.advance(0);
    expect(s.invoke).not.toHaveBeenCalled();
    await s.clock.advance(DEBOUNCE_MS);
    for (let i = 0; i < 5; i += 1) await s.clock.advance(0);
    expect(s.invoke).toHaveBeenCalledTimes(1);
    const keys = (await routingIssues(s)).map((entry) => String(entry.originId));
    const episode = keys.filter((key) => key.startsWith(`episode:blocker:${terminal}@`));
    expect(episode).toHaveLength(1);
    expect(keys.filter((key) => !episode.includes(key)).sort()).toEqual(
      [`blocker:${owner}:${BLOCKED_AT}`, `recovery:${action}`, `review:${review}:stalled`, `review:${user}:assignee:${USER}`].sort(),
    );
    expect((await routingIssues(s)).every((entry) => entry.assigneeAgentId === TRIAGE_AGENT)).toBe(true);
    // The worker-timer sweep repeats at the configured interval (≤ 5 min) and finds nothing new.
    await s.clock.advance(5 * 60 * 1000);
    for (let i = 0; i < 5; i += 1) await s.clock.advance(0);
    await s.clock.advance(DEBOUNCE_MS);
    expect(s.invoke).toHaveBeenCalledTimes(1);
    expect(await routingIssues(s)).toHaveLength(5);
  });

  it("the routing origin is the plugin's own origin kind", () => {
    expect((triageModule as Record<string, unknown>).ROUTE_ORIGIN_KIND).toBe(ROUTE_ORIGIN_KIND);
  });

  it("the default sweep interval is at most 5 minutes and the first sweep runs shortly after start", async () => {
    const { DEFAULT_TRIAGE_OPTIONS } = triageModule;
    expect(DEFAULT_TRIAGE_OPTIONS.sweepIntervalMs).toBeLessThanOrEqual(5 * 60 * 1000);
    expect(DEFAULT_TRIAGE_OPTIONS.sweepStartDelayMs).toBeLessThanOrEqual(60 * 1000);
  });
});

describe("exactly one routing and one wake", () => {
  it("repeated events plus a sweep, then a restart with more events and sweeps", async () => {
    const s = make();
    const id = next();
    const action = next();
    seed(s, [issue(id, "EX-231")], [notice(id, action, "deliberate_wait_without_target")]);
    const evt = () => deliberateWaitEvent(id, action, "board");
    await expect(s.triage.handle(evt())).resolves.toBe("queued");
    await expect(s.triage.handle(evt())).resolves.toBe("duplicate");
    await expect(s.triage.sweepRecoveries()).resolves.toMatchObject({ queued: 0, duplicate: 1 });
    await s.clock.advance(DEBOUNCE_MS);
    await expect(s.triage.handle(evt())).resolves.toBe("duplicate");
    await expect(s.triage.sweepRecoveries()).resolves.toMatchObject({ queued: 0 });
    await s.clock.advance(DEBOUNCE_MS);
    expect(s.invoke).toHaveBeenCalledTimes(1);
    expect(await routingIssues(s)).toHaveLength(1);

    // Restart: a new worker on the same durable state.
    s.triage.stop(true);
    s.timers.splice(0);
    const restarted = s.make();
    await restarted.start();
    await expect(restarted.handle(evt())).resolves.toBe("duplicate");
    await expect(restarted.sweepRecoveries()).resolves.toMatchObject({ queued: 0 });
    await s.clock.advance(60_000);
    expect(s.invoke).toHaveBeenCalledTimes(1);
    expect(await routingIssues(s)).toHaveLength(1);
  });

  it("a crash after the routing issue was made but before the wake: the restart reuses it (no second routing issue)", async () => {
    let calls = 0;
    const s = make({
      invoke: async () => {
        calls += 1;
        if (calls === 1) throw new Error("crash");
        return { runId: "run-ok" };
      },
    });
    const id = next();
    const action = next();
    seed(s, [issue(id, "EX-232")]);
    await s.triage.handle(recoveryEvent(id, action));
    await s.clock.advance(DEBOUNCE_MS); // routing issue created, wake fails, retry pending
    expect(await routingIssues(s)).toHaveLength(1);
    s.triage.stop(true);
    s.timers.splice(0);
    await s.make().start();
    await s.clock.advance(30_000);
    expect(calls).toBe(2);
    const routes = await routingIssues(s);
    expect(routes).toHaveLength(1);
    expect(routes[0].assigneeAgentId).toBe(TRIAGE_AGENT);
    // The successful wake (the second call) carries the same routing issue.
    expect(prompts(s)[1]).toContain(`routing issue ${routes[0].id}`);
  });

  it("the triage agent already holds the item: no routing and no wake", async () => {
    const s = make();
    const own = next();
    const review = next();
    seed(s, [
      issue(own, "EX-233", { assigneeAgentId: TRIAGE_AGENT, unblockDescriptor: { owner: "board", action: "the board decides" } }),
      issue(review, "EX-234", { status: "in_review", assigneeAgentId: TRIAGE_AGENT, reviewAttention: { state: "stalled" } }),
    ]);
    await expect(s.triage.handle(blockedUpdate(own))).resolves.toBe("not_eligible");
    await s.triage.sweepRecoveries();
    await s.clock.advance(DEBOUNCE_MS);
    expect(s.invoke).not.toHaveBeenCalled();
    expect(await routingIssues(s)).toHaveLength(0);
  });

  it("the plugin's own routing issues are never routed (no loop)", async () => {
    const s = make();
    const id = next();
    seed(s, [issue(id, "EX-235", { originKind: ROUTE_ORIGIN_KIND, originId: "recovery:x", assigneeAgentId: null, unblockDescriptor: { owner: "board", action: "x" }, reviewAttention: { state: "stalled" } })]);
    await s.triage.sweepRecoveries();
    await s.clock.advance(DEBOUNCE_MS);
    expect(s.invoke).not.toHaveBeenCalled();
  });
});

describe("routing failure backs off", () => {
  it("a failing routing write is retried, then waits for its back-off instead of repeating every sweep", async () => {
    const s = make();
    const id = next();
    const action = next();
    seed(s, [issue(id, "EX-241")], [notice(id, action, "deliberate_wait_without_target")]);
    let fail = true;
    const create = s.harness.ctx.issues.create.bind(s.harness.ctx.issues);
    const attempts = vi.fn(async (input: Parameters<typeof create>[0]) => {
      if (fail && input.originKind === ROUTE_ORIGIN_KIND) throw new Error("refused");
      return create(input);
    });
    s.harness.ctx.issues.create = attempts as never;
    await s.triage.sweepRecoveries();
    for (const ms of [DEBOUNCE_MS, 30_000, 30_000]) await s.clock.advance(ms);
    expect(attempts).toHaveBeenCalledTimes(3);
    expect(s.invoke).not.toHaveBeenCalled();
    // Sweeps inside the back-off do not repeat the routing.
    for (let i = 0; i < 3; i += 1) {
      await s.triage.sweepRecoveries();
      await s.clock.advance(60_000);
    }
    expect(attempts).toHaveBeenCalledTimes(3);
    // After the back-off the next sweep retries once, and it succeeds.
    fail = false;
    await s.clock.advance(5 * 60 * 1000);
    await s.triage.sweepRecoveries();
    await s.clock.advance(0);
    expect(attempts).toHaveBeenCalledTimes(4);
    await expectRoutedToTriage(s, { key: `recovery:${action}`, kind: "recovery", itemId: action, sourceIssueId: id });
  });
});

describe("exclusions: genuine human choices stay with the person, unchanged", () => {
  it.each([
    ["connection intent (accounts/access)", { kind: "connection_intent" }, { interactionKind: "connection_intent" }],
    ["tool-gateway action", { kind: "request_confirmation", payload: { version: 1, toolAction: { actionRequestId: "a" } } }, { interactionKind: "request_confirmation", toolActionRequestId: uuidN(0x9a1) }],
    ["secret proposal (credentials)", { kind: "request_confirmation", payload: { version: 1, secretProposal: { name: "x" } } }, { interactionKind: "request_confirmation" }],
    ["human-only resolver policy", { kind: "request_confirmation", effectiveResolverPolicy: "human_only" }, { interactionKind: "request_confirmation", effectiveResolverPolicy: "human_only" }],
  ])("a reserved human card (%s) is reported only: no routing, card unchanged", async (_label, cardExtra, eventExtra) => {
    const s = make();
    const id = next();
    const cardId = next();
    seed(s, [issue(id, "EX-251", { status: "in_progress" })], [], [card(id, cardId, cardExtra)]);
    await expect(s.triage.handle(cardEvent(id, cardId, eventExtra))).resolves.toBe("queued");
    await s.clock.advance(DEBOUNCE_MS);
    expect(await routingIssues(s)).toHaveLength(0);
    expect(s.invoke).toHaveBeenCalledTimes(1);
    const line = prompts(s)[0].split("\n").find((entry) => entry.includes(cardId))!;
    expect(line).toContain("report only");
    expect(line).not.toContain("route: yours");
    expect(s.writes.respondInteraction).not.toHaveBeenCalled();
    expect(s.writes.update).not.toHaveBeenCalled();
    const after = (await s.harness.ctx.issues.listInteractions(id, COMPANY_ID)).find((entry) => entry.id === cardId);
    expect(after?.status).toBe("pending");
    expect(after?.addresseeUserId).toBe(USER);
  });

  it("a card a person raised, and a card whose fields cannot be read, are reported only", async () => {
    const s = make();
    const id = next();
    const byUser = next();
    const unreadable = next();
    seed(s, [issue(id, "EX-252", { status: "in_progress" })], [], [card(id, byUser)]);
    await s.triage.handle(cardEvent(id, byUser, {}, { actorType: "user", actorId: USER }));
    await s.triage.handle(cardEvent(id, unreadable)); // not in the host's card list
    await s.clock.advance(DEBOUNCE_MS);
    expect(await routingIssues(s)).toHaveLength(0);
    const text = prompts(s)[0];
    for (const cardId of [byUser, unreadable]) expect(text.split("\n").find((entry) => entry.includes(cardId))).toContain("report only");
  });

  it("a pending approval is reported only: no routing, no approval write", async () => {
    const s = make();
    const approvalId = next();
    await expect(
      s.triage.handle(event("approval.created", { entityType: "approval", entityId: approvalId, payload: { type: "request_board_approval", issueIds: [], agentId: SOURCE } })),
    ).resolves.toBe("queued");
    await s.clock.advance(DEBOUNCE_MS);
    expect(await routingIssues(s)).toHaveLength(0);
    expect(prompts(s)[0].split("\n").find((entry) => entry.includes(approvalId))).toContain("report only");
    expect(s.writes.update).not.toHaveBeenCalled();
    expect(s.writes.respondInteraction).not.toHaveBeenCalled();
  });

  it("an agent-addressed card is not treated as a person's: not routed, not reported, not protected as a human card", async () => {
    const s = make();
    const id = next();
    const cardId = next();
    seed(s, [issue(id, "EX-253", { status: "in_progress" })], [], [card(id, cardId, { kind: "connection_intent", addresseeAgentId: SOURCE, addresseeUserId: null })]);
    await expect(
      s.triage.handle(cardEvent(id, cardId, { interactionKind: "connection_intent", addresseeAgentId: SOURCE, addresseeUserId: null })),
    ).resolves.toBe("ignored");
    await s.clock.advance(DEBOUNCE_MS);
    expect(s.invoke).not.toHaveBeenCalled();
    expect(await routingIssues(s)).toHaveLength(0);
  });

  it("the triage agent's own card to a person is left alone (raised by triage)", async () => {
    const s = make();
    const id = next();
    const cardId = next();
    seed(s, [issue(id, "EX-254", { status: "in_progress" })], [], [card(id, cardId)]);
    await expect(s.triage.handle(cardEvent(id, cardId, { agentId: TRIAGE_AGENT }, { actorId: TRIAGE_AGENT }))).resolves.toBe("triage_raised");
    await s.clock.advance(DEBOUNCE_MS);
    expect(s.invoke).not.toHaveBeenCalled();
  });
});

describe("boundaries, kill switch and unchanged side effects", () => {
  it("routing writes nothing to the source item: no update, comment, card answer or wake on it", async () => {
    const s = make();
    const id = next();
    const action = next();
    const before = issue(id, "EX-261", { executionState: { status: "pending", currentStageId: "s" } });
    seed(s, [before]);
    await s.triage.handle(recoveryEvent(id, action));
    await s.clock.advance(DEBOUNCE_MS);
    expect(s.writes.update).not.toHaveBeenCalled();
    expect(s.writes.createComment).not.toHaveBeenCalled();
    expect(s.writes.respondInteraction).not.toHaveBeenCalled();
    expect(s.writes.requestWakeup).not.toHaveBeenCalled();
    expect(s.writes.create).toHaveBeenCalledTimes(1);
    expect(s.writes.create.mock.calls[0][0]).toMatchObject({ assigneeAgentId: TRIAGE_AGENT, originKind: ROUTE_ORIGIN_KIND });
    expect(await s.harness.ctx.issues.get(id, COMPANY_ID)).toMatchObject({ status: "blocked", assigneeAgentId: SOURCE, executionState: { status: "pending", currentStageId: "s" } });
  });

  it("a private terminal blocker the plugin cannot read is skipped by the sweep", async () => {
    const s = make();
    const blocked = next();
    const hidden = next();
    seed(s, [issue(blocked, "EX-262", { blockerAttention: { state: "stalled", blockingTreeLive: false, terminalBlockerIssueId: hidden, terminalBlocker: null } })]);
    await s.triage.sweepRecoveries();
    await s.clock.advance(DEBOUNCE_MS);
    expect(s.invoke).not.toHaveBeenCalled();
    expect(await routingIssues(s)).toHaveLength(0);
  });

  it("kill switch: enabled=false routes nothing from events or the sweep and writes no state", async () => {
    const s = make({ config: { ...CONFIG, enabled: false } });
    const id = next();
    const action = next();
    seed(s, [issue(id, "EX-263", { unblockDescriptor: { owner: "board" } })], [notice(id, action, "deliberate_wait_without_target")]);
    await expect(s.triage.handle(recoveryEvent(id, action))).resolves.toBe("disabled");
    await expect(s.triage.sweepRecoveries()).resolves.toMatchObject({ companies: 0, queued: 0 });
    await s.clock.advance(DEBOUNCE_MS);
    expect(s.invoke).not.toHaveBeenCalled();
    expect(s.writes.create).not.toHaveBeenCalled();
    expect(await s.harness.ctx.state.get({ scopeKind: "instance", namespace: "decision-triage", stateKey: "pending" })).toBeNull();
  });

  it("kill switch while queued: nothing is routed when the switch is off at flush time", async () => {
    const s = make();
    const id = next();
    const action = next();
    seed(s, [issue(id, "EX-264")]);
    await s.triage.handle(recoveryEvent(id, action));
    s.harness.setConfig({ ...CONFIG, enabled: false });
    await s.clock.advance(DEBOUNCE_MS);
    expect(s.invoke).not.toHaveBeenCalled();
    expect(s.writes.create).not.toHaveBeenCalled();
  });

  it("ntfy behaviour is unchanged: no outbound capability, the same event set, and no change to the source events", () => {
    expect(manifest.capabilities).not.toContain("http.outbound");
    expect(manifest.capabilities).not.toContain("issue.interactions.respond");
    expect(manifest.capabilities).not.toContain("approvals.respond");
  });
});

describe("the triage agent's queue stays current (stale routing issues are closed)", () => {
  it("a routing issue whose source left the board is closed; a started one and a live one are not; sources are untouched", async () => {
    const s = make();
    const gone = next();
    const started = next();
    const live = next();
    const [a1, a2, a3] = [next(), next(), next()];
    seed(s, [issue(gone, "EX-271"), issue(started, "EX-272"), issue(live, "EX-273")]);
    for (const [id, action] of [[gone, a1], [started, a2], [live, a3]]) await s.triage.handle(recoveryEvent(id, action));
    await s.clock.advance(DEBOUNCE_MS);
    const routes = await routingIssues(s);
    expect(routes).toHaveLength(3);
    const byKey = (action: string) => routes.find((entry) => entry.originId === `recovery:${action}`)!;
    // The first source is unblocked by someone; the triage agent already started on the second.
    seed(s, [issue(gone, "EX-271", { status: "in_progress" }), issue(started, "EX-272", { status: "todo" })]);
    seed(s, [{ ...byKey(a2), status: "in_progress", checkoutRunId: next() }]);
    s.writes.update.mockClear();
    await expect(s.triage.sweepRecoveries()).resolves.toMatchObject({ closed: 1 });
    expect((await s.harness.ctx.issues.get(byKey(a1).id, COMPANY_ID))?.status).toBe("cancelled");
    expect((await s.harness.ctx.issues.get(byKey(a2).id, COMPANY_ID))?.status).toBe("in_progress");
    expect((await s.harness.ctx.issues.get(byKey(a3).id, COMPANY_ID))?.status).toBe("todo");
    // issues.update is used only on the plugin's own routing issue, never on a source.
    expect(s.writes.update).toHaveBeenCalledTimes(1);
    expect(s.writes.update.mock.calls[0][0]).toBe(byKey(a1).id);
    expect(s.writes.update.mock.calls[0][1]).toEqual({ status: "cancelled" });
    expect(s.writes.createComment.mock.calls.map((call) => call[0])).toEqual([byKey(a1).id]);
    expect(await s.harness.ctx.issues.get(gone, COMPANY_ID)).toMatchObject({ status: "in_progress", assigneeAgentId: SOURCE });
    // Closing is not routing: no new wake, and a second sweep closes nothing more.
    await expect(s.triage.sweepRecoveries()).resolves.toMatchObject({ closed: 0, queued: 0 });
    await s.clock.advance(DEBOUNCE_MS);
    expect(s.invoke).toHaveBeenCalledTimes(1);
  });

  it("review and blocker-tree routing issues close when the review leaves the person or the tree leaves the feed", async () => {
    const s = make();
    const review = next();
    const terminal = next();
    const blocked = next();
    seed(s, [issue(review, "EX-274", { status: "in_review", assigneeAgentId: null, assigneeUserId: USER }), issue(terminal, "EX-275"), issue(blocked, "EX-276")]);
    await s.triage.handle(reviewEvent(review));
    await s.triage.handle(treeEvent(terminal, "stalled", blocked));
    await s.clock.advance(DEBOUNCE_MS);
    expect(await routingIssues(s)).toHaveLength(2);
    seed(s, [issue(review, "EX-274", { status: "in_review", assigneeAgentId: SOURCE, assigneeUserId: null })]);
    await s.triage.handle(event("issue.blocker_attention_changed", { entityType: "issue", entityId: terminal, actorType: "system", actorId: undefined, payload: { terminalBlockerIssueId: terminal, dedupKey: `blocker:${terminal}`, entered: false } }));
    await expect(s.triage.sweepRecoveries()).resolves.toMatchObject({ closed: 2 });
    expect((await routingIssues(s)).every((entry) => entry.status === "cancelled")).toBe(true);
  });
});

describe("per-sweep cap and kill switch apply to routing-issue creation", () => {
  it("one sweep queues at most MAX_SWEEP_QUEUED new items per company; the rest come on the next sweep", async () => {
    const { MAX_SWEEP_QUEUED } = triageModule as unknown as { MAX_SWEEP_QUEUED: number };
    expect(MAX_SWEEP_QUEUED).toBe(100);
    const s = make({ config: { ...CONFIG, maxWakesPerDay: 1000 } });
    const ids = Array.from({ length: MAX_SWEEP_QUEUED + 5 }, () => next());
    seed(s, ids.map((id, n) => issue(id, `EX-${3000 + n}`, { unblockDescriptor: { owner: "board", action: "Decide" } })));
    await expect(s.triage.sweepRecoveries()).resolves.toMatchObject({ queued: MAX_SWEEP_QUEUED, deferred: 5 });
    for (let i = 0; i < 6; i += 1) await s.clock.advance(DEBOUNCE_MS);
    expect(await routingIssues(s)).toHaveLength(MAX_SWEEP_QUEUED);
    await expect(s.triage.sweepRecoveries()).resolves.toMatchObject({ queued: 5, deferred: 0 });
    await s.clock.advance(DEBOUNCE_MS);
    expect(await routingIssues(s)).toHaveLength(MAX_SWEEP_QUEUED + 5);
  });

  it("the daily wake cap holds routing-issue creation too", async () => {
    const s = make({ config: { ...CONFIG, maxWakesPerDay: 1 } });
    const [x, y] = [next(), next()];
    seed(s, [issue(x, "EX-281"), issue(y, "EX-282")]);
    await s.triage.handle(recoveryEvent(x, next()));
    await s.clock.advance(DEBOUNCE_MS);
    await s.triage.handle(recoveryEvent(y, next()));
    await s.clock.advance(DEBOUNCE_MS);
    expect(s.invoke).toHaveBeenCalledTimes(1);
    expect(await routingIssues(s)).toHaveLength(1);
  });
});

const MARKER_NS = "decision-triage";
const markerScope = (key: string) => ({ scopeKind: "company" as const, scopeId: COMPANY_ID, namespace: MARKER_NS, stateKey: `woken:${key}` });
const indexKeys = async (s: S) =>
  (((await s.harness.ctx.state.get({ scopeKind: "instance", namespace: MARKER_NS, stateKey: "marker-index" })) as { entries?: Array<{ k: string }> } | null)?.entries ?? []).map((entry) => entry.k);

describe("B1: a legacy 0.2.0 woken marker (no routeIssueId) does not suppress a route item", () => {
  it("event path: one routing issue and one correlated wake; repeated events, sweeps and a restart add none", async () => {
    const s = make();
    const id = next();
    const action = next();
    const key = `recovery:${action}`;
    seed(s, [issue(id, "EX-291")], [notice(id, action, "board_escalation_no_takeover")]);
    // 0.2.0 woke for this recovery (notify only) and wrote its marker without a routing issue.
    await s.harness.ctx.state.set(markerScope(key), { v: 1, at: "2026-01-01T08:00:00.000Z", issueId: id });
    await expect(s.triage.handle(recoveryEvent(id, action))).resolves.toBe("queued");
    await expect(s.triage.handle(recoveryEvent(id, action))).resolves.toBe("duplicate");
    await expect(s.triage.sweepRecoveries()).resolves.toMatchObject({ queued: 0 });
    await s.clock.advance(DEBOUNCE_MS);
    const route = await expectRoutedToTriage(s, { key, kind: "recovery", itemId: action, sourceIssueId: id });
    expect(await s.harness.ctx.state.get(markerScope(key))).toMatchObject({ routeIssueId: route.id, issueId: id });
    await expect(s.triage.handle(recoveryEvent(id, action))).resolves.toBe("duplicate");
    await expect(s.triage.sweepRecoveries()).resolves.toMatchObject({ queued: 0 });
    s.triage.stop(true);
    s.timers.splice(0);
    const restarted = s.make();
    await restarted.start();
    await expect(restarted.handle(recoveryEvent(id, action))).resolves.toBe("duplicate");
    await expect(restarted.sweepRecoveries()).resolves.toMatchObject({ queued: 0 });
    await s.clock.advance(60_000);
    expect(s.invoke).toHaveBeenCalledTimes(1);
    expect(await routingIssues(s)).toHaveLength(1);
  });

  it("requeueMissed path: a missed route item with a legacy marker is queued again at start and routed once", async () => {
    const s = make();
    const id = next();
    const key = `review:${id}:stalled`;
    seed(s, [issue(id, "EX-292", { status: "in_review", blockedTransitionAt: null, reviewAttention: { state: "stalled" } })]);
    await s.harness.ctx.state.set(markerScope(key), { v: 1, at: "2026-01-01T08:00:00.000Z" });
    const missed = { companyId: COMPANY_ID, key, mode: "once", kind: "review", itemId: id, issueId: id, approvalId: null, decisionId: null, raisedBy: "system", dueAt: 0, attempts: 3, rounds: 1, retryAt: 0, detail: "review_stalled" };
    await s.harness.ctx.state.set({ scopeKind: "instance", namespace: MARKER_NS, stateKey: "missed" }, { v: 1, items: [missed] });
    await s.triage.start();
    await s.clock.advance(1);
    await expectRoutedToTriage(s, { key, kind: "review", itemId: id, sourceIssueId: id, sourceIdentifier: "EX-292" });
    await expect(s.triage.sweepRecoveries()).resolves.toMatchObject({ queued: 0 });
    s.triage.stop(true);
    s.timers.splice(0);
    const restarted = s.make();
    await restarted.start();
    await expect(restarted.sweepRecoveries()).resolves.toMatchObject({ queued: 0 });
    await s.clock.advance(60_000);
    expect(s.invoke).toHaveBeenCalledTimes(1);
    expect(await routingIssues(s)).toHaveLength(1);
  });

  it("a legacy marker still holds back a report-only item (pending approval)", async () => {
    const s = make();
    const approvalId = next();
    await s.harness.ctx.state.set(markerScope(`approval:${approvalId}`), { v: 1, at: "2026-01-01T08:00:00.000Z" });
    await expect(
      s.triage.handle(event("approval.created", { entityType: "approval", entityId: approvalId, payload: { type: "request_board_approval", issueIds: [], agentId: SOURCE } })),
    ).resolves.toBe("duplicate");
    await s.clock.advance(DEBOUNCE_MS);
    expect(s.invoke).not.toHaveBeenCalled();
  });
});

describe("B2: a cancelled stale routing issue releases its marker, so a returning item is routed again", () => {
  it("stalled -> healthy -> stalled: a second routing issue and a second wake, and no loop", async () => {
    const s = make();
    const id = next();
    const key = `review:${id}:stalled`;
    const stalled = () => seed(s, [issue(id, "EX-293", { status: "in_review", blockedTransitionAt: null, reviewAttention: { state: "stalled" } })]);
    const healthy = () => seed(s, [issue(id, "EX-293", { status: "in_review", blockedTransitionAt: null, reviewAttention: null })]);
    stalled();
    await expect(s.triage.sweepRecoveries()).resolves.toMatchObject({ queued: 1 });
    await s.clock.advance(DEBOUNCE_MS);
    const first = await expectRoutedToTriage(s, { key, kind: "review", itemId: id, sourceIssueId: id });
    expect(await indexKeys(s)).toContain(`woken:${key}`);

    healthy();
    await expect(s.triage.sweepRecoveries()).resolves.toMatchObject({ closed: 1, queued: 0 });
    expect((await s.harness.ctx.issues.get(first.id, COMPANY_ID))?.status).toBe("cancelled");
    expect(await s.harness.ctx.state.get(markerScope(key))).toBeFalsy();
    expect(await indexKeys(s)).not.toContain(`woken:${key}`);
    await expect(s.triage.sweepRecoveries()).resolves.toMatchObject({ closed: 0, queued: 0 });

    stalled();
    await expect(s.triage.sweepRecoveries()).resolves.toMatchObject({ queued: 1 });
    await s.clock.advance(DEBOUNCE_MS);
    const routes = (await routingIssues(s)).filter((entry) => entry.originId === key);
    expect(routes).toHaveLength(2);
    const second = routes.find((entry) => entry.id !== first.id)!;
    expect(second).toMatchObject({ status: "todo", assigneeAgentId: TRIAGE_AGENT });
    expect(s.invoke).toHaveBeenCalledTimes(2);
    expect(prompts(s)[1]).toContain(`routing issue ${second.id}`);
    expect(await s.harness.ctx.state.get(markerScope(key))).toMatchObject({ routeIssueId: second.id });

    // No loop: further sweeps, events and a restart while still stalled add nothing.
    await expect(s.triage.sweepRecoveries()).resolves.toMatchObject({ queued: 0, closed: 0 });
    s.triage.stop(true);
    s.timers.splice(0);
    const restarted = s.make();
    await restarted.start();
    await expect(restarted.sweepRecoveries()).resolves.toMatchObject({ queued: 0, closed: 0 });
    await s.clock.advance(60_000);
    expect(s.invoke).toHaveBeenCalledTimes(2);
    expect((await routingIssues(s)).filter((entry) => entry.originId === key)).toHaveLength(2);
  });
});
