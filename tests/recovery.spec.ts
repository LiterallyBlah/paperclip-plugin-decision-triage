import { describe, expect, it, vi } from "vitest";
import type { PluginEvent } from "@paperclipai/plugin-sdk";
import { MARKER_TTL_MS } from "../src/marker-index.js";
import { RECOVERY_NOTE } from "../src/text.js";
import { NONE_RECHECK_MS } from "../src/triage.js";
import { BASE_CONFIG, COMPANY_ID, event, ISSUE_ID, OTHER_AGENT_ID, setup, START, TRIAGE_AGENT_ID, uuidN } from "./fixtures.js";

// Synthetic identifiers only.
const DEBOUNCE_MS = 10_000;
const REC_ISSUE = uuidN(0x101);
const REC_ISSUE_2 = uuidN(0x102);
const TAKEN_ISSUE = uuidN(0x103);
const ACTION = uuidN(0x201);
const ACTION_2 = uuidN(0x202);
const ACTION_3 = uuidN(0x203);
const SOURCE_AGENT = OTHER_AGENT_ID;
const BLOCKED_AT = "2026-01-02T09:59:00.000Z";
const POLICY = "board_escalation_no_takeover_v1";
const REVIEW_POLICY = {
  mode: "normal",
  stages: [{ id: uuidN(0x301), type: "review", participants: [{ id: uuidN(0x302), type: "agent", agentId: uuidN(0x303) }] }],
};
const REVIEW_STATE = { status: "in_review", currentStageId: uuidN(0x301), returnAssignee: { type: "agent", agentId: SOURCE_AGENT } };

/** A blocked source issue as a board recovery leaves it: assignee kept, no unblock descriptor. */
function recoveryIssue(id: string, identifier: string, extra: Record<string, unknown> = {}) {
  return {
    id,
    companyId: COMPANY_ID,
    identifier,
    title: `Recovered ${identifier}`,
    status: "blocked",
    assigneeAgentId: SOURCE_AGENT,
    assigneeUserId: null,
    unblockDescriptor: null,
    blockedTransitionAt: BLOCKED_AT,
    executionPolicy: REVIEW_POLICY,
    executionState: REVIEW_STATE,
    ...extra,
  } as never;
}

/** Host `issue.updated` for a stranded-work board escalation (activity details at the top level). */
function recoveryBlocked(issueId: string, actionId: string, overrides: Record<string, unknown> = {}, base: Partial<PluginEvent> = {}): PluginEvent {
  return event("issue.updated", {
    entityType: "issue",
    entityId: issueId,
    actorType: "system",
    actorId: "system",
    ...base,
    payload: {
      identifier: "EX-101",
      status: "blocked",
      previousStatus: "in_progress",
      _previous: { status: "in_progress" },
      source: "recovery.reconcile_stranded_assigned_issue",
      recoveryCause: "stranded_assigned_issue",
      recoveryActionId: actionId,
      recoveryOwnerType: "board",
      recoveryOwnerAgentId: null,
      previousOwnerAgentId: SOURCE_AGENT,
      returnOwnerAgentId: SOURCE_AGENT,
      routingPolicy: POLICY,
      sourceAssigneePreserved: true,
      ...overrides,
    },
  });
}

/** The host's stranded escalation notice (system comment) for a board-owned action. */
function strandedNotice(issueId: string, actionId: string, at = "2026-01-02T09:59:00.010Z", extra: Record<string, unknown> = {}) {
  return {
    id: uuidN(0x400 + Math.floor(Math.random() * 0xfff)),
    companyId: COMPANY_ID,
    issueId,
    authorType: "system",
    authorAgentId: null,
    authorUserId: null,
    body: "Paperclip cannot safely continue automatic recovery because the original assignee is not invokable. The source assignment is unchanged and the board must choose the next action.",
    createdAt: at,
    updatedAt: at,
    deletedAt: null,
    metadata: {
      version: 1,
      recoveryResponsibility: "system",
      sourceRunId: uuidN(0x501),
      sections: [
        {
          title: "Recovery",
          rows: [
            { type: "key_value", label: "Recovery action", value: actionId },
            { type: "key_value", label: "Recovery owner", value: "Board decision required" },
            { type: "key_value", label: "Next action", value: "Inspect the evidence, then retry the original owner" },
          ],
        },
      ],
    },
    ...extra,
  } as never;
}

function promptsOf(invoke: { mock: { calls: unknown[][] } }): string[] {
  return invoke.mock.calls.map((call) => (call[2] as { prompt: string }).prompt);
}

function seeded(s: ReturnType<typeof setup>, issues: unknown[], comments: unknown[] = [], interactions: unknown[] = []) {
  // The shared fixture's board-blocked issue is its own board item since 0.3.0 (sweep catch-up);
  // these recovery tests keep it out of the sweep so their counts are about recoveries only.
  s.harness.seed({
    issues: [{ id: ISSUE_ID, companyId: COMPANY_ID, identifier: "EX-42", title: "Shared fixture", status: "in_progress" }, ...issues] as never,
    issueComments: comments as never,
    issueInteractions: interactions as never,
  });
}

describe("initial routing: recovery events reach the triage agent", () => {
  it("a board-owned stranded recovery (no unblock descriptor) wakes the triage agent once", async () => {
    const s = setup();
    seeded(s, [recoveryIssue(REC_ISSUE, "EX-101")]);
    await expect(s.triage.handle(recoveryBlocked(REC_ISSUE, ACTION))).resolves.toBe("queued");
    expect(s.invoke).not.toHaveBeenCalled();
    await s.clock.advance(DEBOUNCE_MS);
    expect(s.invoke).toHaveBeenCalledTimes(1);
    const [agentId, companyId, opts] = s.invoke.mock.calls[0];
    expect(agentId).toBe(TRIAGE_AGENT_ID);
    expect(companyId).toBe(COMPANY_ID);
    expect(opts.reason).toBe("decision_triage");
    expect(opts.prompt).toContain(`kind: recovery | id: ${ACTION} | issue: EX-101`);
    expect(opts.prompt).toContain("raised by: the platform");
    expect(opts.prompt).toContain(RECOVERY_NOTE);
    expect(opts.prompt).not.toContain("| gate: human");
  });

  it("board-owned paths without a routing policy field (native finalization, review path) are routed", async () => {
    const s = setup();
    seeded(s, [recoveryIssue(REC_ISSUE, "EX-101"), recoveryIssue(REC_ISSUE_2, "EX-102")]);
    await expect(
      s.triage.handle(recoveryBlocked(REC_ISSUE, ACTION, { routingPolicy: undefined, source: "native_finalization.ambiguous_session_state" })),
    ).resolves.toBe("queued");
    await expect(
      s.triage.handle(recoveryBlocked(REC_ISSUE_2, ACTION_2, { routingPolicy: undefined, previousStatus: "in_review", _previous: { status: "in_review" } })),
    ).resolves.toBe("queued");
    await s.clock.advance(DEBOUNCE_MS);
    expect(s.invoke).toHaveBeenCalledTimes(1);
    expect(promptsOf(s.invoke)[0]).toContain(ACTION);
    expect(promptsOf(s.invoke)[0]).toContain(ACTION_2);
  });

  it("a user-owned recovery is routed", async () => {
    const s = setup();
    seeded(s, [recoveryIssue(REC_ISSUE, "EX-101")]);
    await expect(s.triage.handle(recoveryBlocked(REC_ISSUE, ACTION, { recoveryOwnerType: "user" }))).resolves.toBe("queued");
  });

  it("one wake per recovery action: repeated events are deduplicated and debounced", async () => {
    const s = setup();
    seeded(s, [recoveryIssue(REC_ISSUE, "EX-101")]);
    await s.triage.handle(recoveryBlocked(REC_ISSUE, ACTION));
    await expect(s.triage.handle(recoveryBlocked(REC_ISSUE, ACTION))).resolves.toBe("duplicate");
    await s.clock.advance(DEBOUNCE_MS);
    await expect(s.triage.handle(recoveryBlocked(REC_ISSUE, ACTION))).resolves.toBe("duplicate");
    await s.clock.advance(DEBOUNCE_MS);
    expect(s.invoke).toHaveBeenCalledTimes(1);
  });

  it("the kill switch for recoveries turns the event path off", async () => {
    const s = setup({ config: { ...BASE_CONFIG, triggers: { recoveries: false, blockerAttention: false } } });
    seeded(s, [recoveryIssue(REC_ISSUE, "EX-101")]);
    await expect(s.triage.handle(recoveryBlocked(REC_ISSUE, ACTION))).resolves.toBe("ignored");
  });
});

describe("non-board-owned or no-longer-open recoveries are ignored", () => {
  it.each([
    ["agent-owned action", { recoveryOwnerType: "agent", recoveryOwnerAgentId: OTHER_AGENT_ID }],
    ["system-owned provider quota wait", { recoveryOwnerType: undefined, source: "recovery.reconcile_provider_quota_wait" }],
    ["system owner type", { recoveryOwnerType: "system" }],
    ["no recovery action id", { recoveryActionId: undefined }],
    ["a malformed recovery action id", { recoveryActionId: "not-a-uuid" }],
    ["not blocked", { status: "in_progress", _previous: { status: "in_progress" } }],
  ])("%s", async (_label, overrides) => {
    const s = setup();
    // An open recovery issue, so only the event filter can stop the route.
    seeded(s, [recoveryIssue(REC_ISSUE, "EX-101")]);
    const outcome = await s.triage.handle(recoveryBlocked(REC_ISSUE, ACTION, overrides));
    expect(["ignored", "not_eligible"]).toContain(outcome);
    await s.clock.advance(DEBOUNCE_MS);
    expect(s.invoke).not.toHaveBeenCalled();
  });

  it("recovery fields on an event from an agent or a user are not trusted", async () => {
    const s = setup();
    // An open recovery issue, so only the event filter can stop the route.
    seeded(s, [recoveryIssue(REC_ISSUE, "EX-101")]);
    const agent = await s.triage.handle(recoveryBlocked(REC_ISSUE, ACTION, {}, { actorType: "agent", actorId: OTHER_AGENT_ID }));
    const user = await s.triage.handle(recoveryBlocked(REC_ISSUE, ACTION_2, {}, { actorType: "user", actorId: "user-example-1" }));
    expect(["ignored", "not_eligible"]).toContain(agent);
    expect(["ignored", "not_eligible"]).toContain(user);
    await s.clock.advance(DEBOUNCE_MS);
    expect(s.invoke).not.toHaveBeenCalled();
  });

  it("a recovery already resolved (issue no longer blocked) is not routed", async () => {
    const s = setup();
    seeded(s, [recoveryIssue(REC_ISSUE, "EX-101", { status: "in_progress" })]);
    await expect(s.triage.handle(recoveryBlocked(REC_ISSUE, ACTION))).resolves.toBe("not_eligible");
  });

  it("a recovery taken by an agent (unblock descriptor names the agent) is not routed by either path", async () => {
    const s = setup({ sweepIntervalMs: 60_000 });
    seeded(
      s,
      [recoveryIssue(TAKEN_ISSUE, "EX-103", { unblockDescriptor: { owner: { agentId: TRIAGE_AGENT_ID }, action: "Triage reconciles the hold" } })],
      [strandedNotice(TAKEN_ISSUE, ACTION_3)],
    );
    await expect(s.triage.handle(recoveryBlocked(TAKEN_ISSUE, ACTION_3))).resolves.toBe("not_eligible");
    const sweep = await s.triage.sweepRecoveries();
    expect(sweep.queued).toBe(0);
    await s.triage.start();
    await s.clock.advance(30_000 + DEBOUNCE_MS);
    await s.clock.advance(60_000 + DEBOUNCE_MS);
    expect(s.invoke).not.toHaveBeenCalled();
  });
});

describe("fallback routing: the catch-up sweep finds missed recoveries", () => {
  it("routes a board-owned recovery whose event was never received", async () => {
    const s = setup();
    seeded(s, [recoveryIssue(REC_ISSUE, "EX-101")], [strandedNotice(REC_ISSUE, ACTION)]);
    const outcome = await s.triage.sweepRecoveries();
    expect(outcome).toMatchObject({ companies: 1, queued: 1, errors: 0 });
    await s.clock.advance(DEBOUNCE_MS);
    expect(s.invoke).toHaveBeenCalledTimes(1);
    expect(promptsOf(s.invoke)[0]).toContain(`kind: recovery | id: ${ACTION} | issue: EX-101`);
  });

  it("reads the disposition-repair notice shape (owner row `board`)", async () => {
    const s = setup();
    const notice = strandedNotice(REC_ISSUE, ACTION) as unknown as { metadata: { sections: Array<{ rows: Array<Record<string, unknown>> }> } };
    notice.metadata.sections[0].rows = [
      { type: "key_value", label: "Recovery action", value: ACTION },
      { type: "key_value", label: "Cause", value: "deliberate_wait_without_target" },
      { type: "key_value", label: "Previous status", value: "in_progress" },
      { type: "key_value", label: "Recovery owner", value: "board" },
    ];
    seeded(s, [recoveryIssue(REC_ISSUE, "EX-101")], [notice]);
    await expect(s.triage.sweepRecoveries()).resolves.toMatchObject({ queued: 1 });
  });

  it("runs on its own timer: shortly after start, then every interval", async () => {
    const s = setup({ sweepIntervalMs: 5 * 60_000 });
    seeded(s, [recoveryIssue(REC_ISSUE, "EX-101")], [strandedNotice(REC_ISSUE, ACTION)]);
    await s.triage.start();
    await s.clock.advance(30_000);
    await s.clock.advance(DEBOUNCE_MS);
    expect(s.invoke).toHaveBeenCalledTimes(1);
    // A recovery that appears later is found by the next interval sweep.
    seeded(s, [recoveryIssue(REC_ISSUE_2, "EX-102", { blockedTransitionAt: new Date(s.clock.now).toISOString() })], [
      strandedNotice(REC_ISSUE_2, ACTION_2, new Date(s.clock.now + 5).toISOString()),
    ]);
    await s.clock.advance(5 * 60_000);
    await s.clock.advance(DEBOUNCE_MS);
    expect(s.invoke).toHaveBeenCalledTimes(2);
    expect(promptsOf(s.invoke)[1]).toContain(ACTION_2);
    s.triage.stop(true);
    expect(s.timers).toHaveLength(0);
  });

  it("an event and a sweep for the same action make one wake", async () => {
    const s = setup();
    seeded(s, [recoveryIssue(REC_ISSUE, "EX-101")], [strandedNotice(REC_ISSUE, ACTION)]);
    await s.triage.handle(recoveryBlocked(REC_ISSUE, ACTION));
    await expect(s.triage.sweepRecoveries()).resolves.toMatchObject({ queued: 0, duplicate: 1 });
    await s.clock.advance(DEBOUNCE_MS);
    await expect(s.triage.sweepRecoveries()).resolves.toMatchObject({ queued: 0 });
    await s.clock.advance(DEBOUNCE_MS);
    expect(s.invoke).toHaveBeenCalledTimes(1);
  });

  it("ignores agent-owned notices, non-system comments, old episodes and issues that are not blocked", async () => {
    const s = setup();
    const agentOwned = strandedNotice(REC_ISSUE, ACTION) as unknown as { metadata: { sections: Array<{ rows: Array<Record<string, unknown>> }> } };
    agentOwned.metadata.sections[0].rows[1] = { type: "agent_link", label: "Recovery owner", agentId: OTHER_AGENT_ID, name: "Worker" };
    seeded(
      s,
      [
        recoveryIssue(REC_ISSUE, "EX-101"),
        recoveryIssue(REC_ISSUE_2, "EX-102"),
        recoveryIssue(TAKEN_ISSUE, "EX-103", { blockedTransitionAt: "2026-01-02T09:59:00.000Z" }),
        recoveryIssue(uuidN(0x104), "EX-104", { status: "in_progress" }),
      ],
      [
        agentOwned,
        // Same metadata, but written by an agent: not the host's notice.
        strandedNotice(REC_ISSUE_2, ACTION_2, undefined, { authorType: "agent", authorAgentId: OTHER_AGENT_ID }),
        // A notice from an earlier blocked episode.
        strandedNotice(TAKEN_ISSUE, ACTION_3, "2026-01-01T08:00:00.000Z"),
        strandedNotice(uuidN(0x104), uuidN(0x204)),
      ],
    );
    await expect(s.triage.sweepRecoveries()).resolves.toMatchObject({ queued: 0, errors: 0 });
    await s.clock.advance(DEBOUNCE_MS);
    expect(s.invoke).not.toHaveBeenCalled();
  });

  it("does not read comments again for an unchanged blocked issue, but re-checks one with no notice later", async () => {
    const s = setup();
    seeded(s, [recoveryIssue(REC_ISSUE, "EX-101"), recoveryIssue(REC_ISSUE_2, "EX-102")], [strandedNotice(REC_ISSUE, ACTION)]);
    const list = vi.spyOn(s.harness.ctx.issues, "listComments");
    const reads = (issueId: string) => list.mock.calls.filter((call) => call[0] === issueId).length;
    await s.triage.sweepRecoveries();
    expect([reads(REC_ISSUE), reads(REC_ISSUE_2)]).toEqual([1, 1]);
    await s.triage.sweepRecoveries();
    expect([reads(REC_ISSUE), reads(REC_ISSUE_2)]).toEqual([1, 1]);
    await s.clock.advance(NONE_RECHECK_MS);
    await s.triage.sweepRecoveries();
    // The routed episode is not read again; the one with no notice is.
    expect([reads(REC_ISSUE), reads(REC_ISSUE_2)]).toEqual([1, 2]);
  });

  it("a missing comment-read capability does not break the sweep or the event path", async () => {
    const s = setup();
    seeded(s, [recoveryIssue(REC_ISSUE, "EX-101")], [strandedNotice(REC_ISSUE, ACTION)]);
    s.harness.ctx.issues.listComments = (async () => {
      throw new Error("Missing capability issue.comments.read");
    }) as never;
    // Every blocked issue's read fails (the fixture's human-owned EX-42 as well); nothing is queued.
    const outcome = await s.triage.sweepRecoveries();
    expect(outcome.queued).toBe(0);
    expect(outcome.errors).toBe(outcome.issues);
    expect(outcome.errors).toBeGreaterThan(0);
    await expect(s.triage.handle(recoveryBlocked(REC_ISSUE, ACTION))).resolves.toBe("queued");
  });

  it("the kill switch for recoveries turns the sweep off", async () => {
    const s = setup({ config: { ...BASE_CONFIG, triggers: { recoveries: false } } });
    seeded(s, [recoveryIssue(REC_ISSUE, "EX-101")], [strandedNotice(REC_ISSUE, ACTION)]);
    // The sweep still runs for the other classes (0.3.0); it routes no recovery.
    await expect(s.triage.sweepRecoveries()).resolves.toMatchObject({ queued: 0 });
    await s.clock.advance(DEBOUNCE_MS);
    expect(s.invoke).not.toHaveBeenCalled();
  });

  it("with every sweep class switched off the sweep reads no company", async () => {
    const s = setup({ config: { ...BASE_CONFIG, triggers: { recoveries: false, blockerAttention: false, reviews: false } } });
    seeded(s, [recoveryIssue(REC_ISSUE, "EX-101")], [strandedNotice(REC_ISSUE, ACTION)]);
    await expect(s.triage.sweepRecoveries()).resolves.toMatchObject({ companies: 0, queued: 0 });
  });
});

describe("no replay across a restart", () => {
  it("a routed recovery is never routed again by a restarted worker (event or sweep)", async () => {
    const s = setup();
    seeded(s, [recoveryIssue(REC_ISSUE, "EX-101")], [strandedNotice(REC_ISSUE, ACTION)]);
    await s.triage.handle(recoveryBlocked(REC_ISSUE, ACTION));
    await s.clock.advance(DEBOUNCE_MS);
    expect(s.invoke).toHaveBeenCalledTimes(1);

    s.triage.stop(true);
    const restarted = s.make();
    await restarted.start();
    await expect(restarted.sweepRecoveries()).resolves.toMatchObject({ queued: 0, duplicate: 1 });
    await expect(restarted.handle(recoveryBlocked(REC_ISSUE, ACTION))).resolves.toBe("duplicate");
    await s.clock.advance(DEBOUNCE_MS);
    expect(s.invoke).toHaveBeenCalledTimes(1);
  });

  it("a recovery queued but not yet woken before a restart is woken exactly once after it", async () => {
    const s = setup();
    seeded(s, [recoveryIssue(REC_ISSUE, "EX-101")], [strandedNotice(REC_ISSUE, ACTION)]);
    await s.triage.handle(recoveryBlocked(REC_ISSUE, ACTION));
    s.triage.stop(true);
    s.timers.length = 0;
    const restarted = s.make();
    await restarted.start();
    await expect(restarted.sweepRecoveries()).resolves.toMatchObject({ queued: 0, duplicate: 1 });
    await s.clock.advance(DEBOUNCE_MS);
    expect(s.invoke).toHaveBeenCalledTimes(1);
  });

  it("the dedupe marker of a still-open recovery outlives marker pruning; a closed one is pruned", async () => {
    const s = setup();
    seeded(s, [recoveryIssue(REC_ISSUE, "EX-101"), recoveryIssue(REC_ISSUE_2, "EX-102")], [
      strandedNotice(REC_ISSUE, ACTION),
      strandedNotice(REC_ISSUE_2, ACTION_2),
    ]);
    await s.triage.sweepRecoveries();
    await s.clock.advance(DEBOUNCE_MS);
    expect(s.invoke).toHaveBeenCalledTimes(1);
    // EX-102 is resolved; EX-101 stays blocked.
    seeded(s, [recoveryIssue(REC_ISSUE_2, "EX-102", { status: "in_progress" })]);
    s.clock.now += MARKER_TTL_MS + 1;
    await s.triage.markers.prune();
    const marker = (key: string) =>
      s.harness.ctx.state.get({ scopeKind: "company", scopeId: COMPANY_ID, namespace: "decision-triage", stateKey: `woken:recovery:${key}` });
    expect(await marker(ACTION)).not.toBeNull();
    expect(await marker(ACTION_2)).toBeNull();
    const restarted = s.make();
    await expect(restarted.sweepRecoveries()).resolves.toMatchObject({ queued: 0 });
    await s.clock.advance(DEBOUNCE_MS);
    expect(s.invoke).toHaveBeenCalledTimes(1);
  });
});

describe("human gates and source state", () => {
  it("a recovery with a card waiting for a person is reported as a human gate; the card stays with that person", async () => {
    const s = setup();
    const card = {
      id: uuidN(0x601),
      companyId: COMPANY_ID,
      issueId: REC_ISSUE,
      kind: "request_confirmation",
      status: "pending",
      addresseeAgentId: null,
      addresseeUserId: "user-example-1",
    };
    seeded(s, [recoveryIssue(REC_ISSUE, "EX-101")], [], [card]);
    const respond = vi.spyOn(s.harness.ctx.issues, "respondInteraction");
    await s.triage.handle(recoveryBlocked(REC_ISSUE, ACTION));
    await s.clock.advance(DEBOUNCE_MS);
    expect(s.invoke).toHaveBeenCalledTimes(1);
    expect(promptsOf(s.invoke)[0]).toContain(`id: ${ACTION}`);
    expect(promptsOf(s.invoke)[0]).toContain("| gate: human");
    expect(respond).not.toHaveBeenCalled();
    const cards = await s.harness.ctx.issues.listInteractions(REC_ISSUE, COMPANY_ID);
    expect(cards).toEqual([card]);
  });

  it("an agent-addressed card is not a human gate", async () => {
    const s = setup();
    seeded(s, [recoveryIssue(REC_ISSUE, "EX-101")], [], [
      { id: uuidN(0x602), companyId: COMPANY_ID, issueId: REC_ISSUE, kind: "ask_user_questions", status: "pending", addresseeAgentId: OTHER_AGENT_ID },
    ]);
    await s.triage.handle(recoveryBlocked(REC_ISSUE, ACTION));
    await s.clock.advance(DEBOUNCE_MS);
    expect(promptsOf(s.invoke)[0]).not.toContain("| gate: human");
  });

  it("routing leaves the source issue's owner, assignee, status and review state unchanged and writes nothing to it", async () => {
    const s = setup();
    seeded(s, [recoveryIssue(REC_ISSUE, "EX-101")], [strandedNotice(REC_ISSUE, ACTION)]);
    const before = structuredClone(await s.harness.ctx.issues.get(REC_ISSUE, COMPANY_ID));
    const commentsBefore = structuredClone(await s.harness.ctx.issues.listComments(REC_ISSUE, COMPANY_ID));
    const update = vi.spyOn(s.harness.ctx.issues, "update");
    const comment = vi.spyOn(s.harness.ctx.issues, "createComment");
    const wake = vi.spyOn(s.harness.ctx.issues, "requestWakeup");
    await s.triage.handle(recoveryBlocked(REC_ISSUE, ACTION));
    await s.triage.sweepRecoveries();
    await s.clock.advance(DEBOUNCE_MS);
    expect(s.invoke).toHaveBeenCalledTimes(1);
    const after = await s.harness.ctx.issues.get(REC_ISSUE, COMPANY_ID);
    expect(after).toEqual(before);
    expect(after).toMatchObject({ assigneeAgentId: SOURCE_AGENT, status: "blocked", executionPolicy: REVIEW_POLICY, executionState: REVIEW_STATE });
    expect(await s.harness.ctx.issues.listComments(REC_ISSUE, COMPANY_ID)).toEqual(commentsBefore);
    expect(update).not.toHaveBeenCalled();
    expect(comment.mock.calls.every((call) => call[0] !== REC_ISSUE)).toBe(true);
    expect(wake.mock.calls.every((call) => call[0] !== REC_ISSUE)).toBe(true);
  });
});

void START;
