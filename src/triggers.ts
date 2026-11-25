/**
 * Pure classification of Paperclip plugin events into "a decision is waiting
 * for a person" candidates. No I/O happens here so every rule is unit-tested.
 *
 * Event payloads are produced by the host activity log: the activity
 * `details` object is spread at the top level of `payload`, next to
 * `agentId`, `runId` and `responsibleUserId`.
 */

import type { TriageTriggers as NotifierTriggers } from "./config.js";

/** Activity action the host logs when an issue thread interaction is created. */
export const INTERACTION_CREATED = "issue.thread_interaction_created";
/**
 * Host event for an issue entering or leaving computed blocker attention. Not
 * yet emitted to plugins by stock hosts; handled once a host emits it.
 */
export const BLOCKER_ATTENTION_CHANGED = "issue.blocker_attention_changed";
/** Activity action the host logs when an agent opens a board decision. */
export const DECISION_CREATED = "decision.created";

/**
 * Who an interaction card is for, judged from the event payload alone.
 * - `human`: the payload carries an explicit `addresseeAgentId` key and it is empty.
 * - `agent`: the payload names an agent addressee.
 * - `unknown`: the payload has no `addresseeAgentId` key at all. A missing key
 *   is never read as "human"; the plugin resolves it from the host.
 * - `not_pending`: the card is already resolved.
 */
export type InteractionRouting = "human" | "agent" | "unknown" | "not_pending";

export type DecisionCandidate =
  | { kind: "approval"; companyId: string; approvalId: string; issueId: string | null; toolActionRequestId: string | null }
  | {
      kind: "interaction";
      companyId: string;
      interactionId: string;
      issueId: string;
      routing: "human" | "unknown";
      toolActionRequestId: string | null;
    }
  /** Needs a host read to confirm the human-owned unblock descriptor. */
  | { kind: "blocker"; companyId: string; issueId: string }
  /** A blocked tree whose terminal blocker has no live path (host-computed). */
  | {
      kind: "blocker_tree";
      companyId: string;
      issueId: string;
      /** Feed dedupKey, `blocker:<terminal blocker id>`. */
      dedupKey: string;
      /** The blocked issue the feed groups under this terminal blocker, when known. */
      blockedIssueId: string | null;
      /** `enter`: the item entered the feed (or is open at a host-boot baseline); `exit`: it left. */
      phase: "enter" | "exit";
      baseline: boolean;
    }
  | { kind: "decision"; companyId: string; decisionId: string; issueId: string | null }
  /**
   * A board- or user-owned recovery action (`board_escalation_no_takeover_v1`):
   * Paperclip blocked the issue and left the next step to a person. Needs a
   * host read to confirm the issue is still blocked and not taken.
   */
  | { kind: "recovery"; companyId: string; issueId: string; recoveryActionId: string; ownerType: RecoveryOwnerType; recoveryKind: string | null }
  /**
   * An issue in review whose next step belongs to a person (user assignee or
   * user stage participant) or whose review path stalled. Needs a host read.
   */
  | { kind: "review"; companyId: string; issueId: string };

export type RecoveryOwnerType = "board" | "user";

/**
 * Host routing policy of a stranded or disposition board escalation. Since
 * 0.3.0 this is informational only: every board- or user-owned recovery is
 * routed, whatever its policy, kind or cause.
 */
export const RECOVERY_ROUTING_POLICY = "board_escalation_no_takeover_v1";

/** Bounded token for a host-supplied kind/cause/policy name shown in the wake. */
const TOKEN_PATTERN = /^[A-Za-z0-9_.:-]{1,80}$/;

export function safeToken(value: unknown): string | null {
  return typeof value === "string" && TOKEN_PATTERN.test(value) ? value : null;
}

export interface EventLike {
  eventType: string;
  companyId: string;
  entityId?: string;
  entityType?: string;
  actorType?: string;
  payload: unknown;
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

function nonEmptyString(value: unknown): string | null {
  return typeof value === "string" && value.trim() !== "" ? value : null;
}

function classifyApproval(event: EventLike, payload: Record<string, unknown>): DecisionCandidate | null {
  if (event.entityType !== undefined && event.entityType !== "approval") return null;
  const approvalId = nonEmptyString(event.entityId);
  if (!approvalId) return null;
  const issueIds = Array.isArray(payload.issueIds) ? payload.issueIds : [];
  const issueId = issueIds.map(nonEmptyString).find((id): id is string => id !== null) ?? null;
  // A tool-gateway approval and its approval card are one decision; both
  // events carry the tool action request id, which becomes the dedupe key.
  const toolActionRequestId = payload.source === "tool_gateway" ? nonEmptyString(payload.actionRequestId) : null;
  return { kind: "approval", companyId: event.companyId, approvalId, issueId, toolActionRequestId };
}

/**
 * Routing for an interaction card. This matches the board inbox, which lists
 * pending interactions whose `addresseeAgentId` is null (optionally narrowed
 * to one `addresseeUserId`). An agent addressee is agent-to-agent traffic.
 *
 * The board inbox also lists cards whose agent addressee is no longer
 * invokable. The host only accepts an invokable agent addressee when a card is
 * created, so at creation time an agent-addressed card is never in the inbox.
 */
export function interactionRouting(details: Record<string, unknown>): InteractionRouting {
  const status = details.interactionStatus;
  if (status !== undefined && status !== null && status !== "pending") return "not_pending";
  if (!Object.prototype.hasOwnProperty.call(details, "addresseeAgentId")) return "unknown";
  return nonEmptyString(details.addresseeAgentId) ? "agent" : "human";
}

/** True only for a card the payload itself proves is for a person. */
export function isHumanAddressedInteraction(details: Record<string, unknown>): boolean {
  return interactionRouting(details) === "human";
}

function classifyInteraction(event: EventLike, details: Record<string, unknown>): DecisionCandidate | null {
  if (event.entityType !== undefined && event.entityType !== "issue") return null;
  const issueId = nonEmptyString(event.entityId) ?? nonEmptyString(details.issueId);
  const interactionId = nonEmptyString(details.interactionId);
  if (!issueId || !interactionId) return null;
  const routing = interactionRouting(details);
  if (routing !== "human" && routing !== "unknown") return null;
  return {
    kind: "interaction",
    companyId: event.companyId,
    interactionId,
    issueId,
    routing,
    toolActionRequestId: nonEmptyString(details.toolActionRequestId),
  };
}

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * Host-computed blocker attention: a blocked issue whose blocker tree has no
 * live path, grouped by its terminal blocker like the board attention feed.
 * The host emits `entered: true` when an item enters the feed (or, with
 * `baseline: true`, for the items still open at the first evaluation after a
 * host boot) and `entered: false` when it leaves. One feed episode is one
 * decision: the notifier keeps a durable open/closed record per terminal
 * blocker, keyed by the feed's own `dedupKey` (`blocker:<terminal>`).
 */
function classifyBlockerAttention(event: EventLike, payload: Record<string, unknown>): DecisionCandidate | null {
  if (event.entityType !== undefined && event.entityType !== "issue") return null;
  const terminalId = nonEmptyString(payload.terminalBlockerIssueId) ?? nonEmptyString(event.entityId);
  if (!terminalId || !UUID_PATTERN.test(terminalId)) return null;
  const dedupKey = nonEmptyString(payload.dedupKey);
  if (dedupKey !== `blocker:${terminalId}`) return null;
  const base = {
    kind: "blocker_tree" as const,
    companyId: event.companyId,
    issueId: terminalId,
    dedupKey,
    blockedIssueId: nonEmptyString(payload.blockedIssueId),
  };
  if (payload.entered === false) return { ...base, phase: "exit", baseline: false };
  if (payload.state !== "stalled" && payload.state !== "needs_attention") return null;
  if (payload.blockingTreeLive !== false) return null;
  const activityAt = nonEmptyString(payload.activityAt);
  if (!activityAt || Number.isNaN(Date.parse(activityAt))) return null;
  return { ...base, phase: "enter", baseline: payload.baseline === true };
}

function classifyDecision(event: EventLike, payload: Record<string, unknown>): DecisionCandidate | null {
  if (event.entityType !== undefined && event.entityType !== "decision") return null;
  const decisionId = nonEmptyString(event.entityId);
  if (!decisionId) return null;
  return { kind: "decision", companyId: event.companyId, decisionId, issueId: nonEmptyString(payload.originIssueId) };
}

/** True when an `issue.updated` payload moved the issue into `blocked`. */
function enteredBlocked(payload: Record<string, unknown>): boolean {
  const changes = asRecord(payload.changes) ?? {};
  const statusChange = asRecord(changes.status);
  const previous = asRecord(payload._previous);
  return statusChange
    ? statusChange.to === "blocked" && statusChange.from !== "blocked"
    : payload.status === "blocked" && previous !== null && "status" in previous && previous.status !== "blocked";
}

/**
 * Recovery fields of a host recovery `issue.updated` (activity details):
 * `recoveryActionId` and `recoveryOwnerType`, plus optional `routingPolicy`
 * and cause fields. The owner decides, never the kind: every board- or
 * user-owned action counts, whatever its kind, cause or policy (including a
 * kind this plugin does not know). A system-owned action (provider quota
 * wait) or an agent-owned one is not a board decision.
 */
export function recoveryFromPayload(
  payload: Record<string, unknown>,
): { recoveryActionId: string; ownerType: RecoveryOwnerType; recoveryKind: string | null } | null {
  const recoveryActionId = nonEmptyString(payload.recoveryActionId);
  if (!recoveryActionId || !UUID_PATTERN.test(recoveryActionId)) return null;
  const ownerType = payload.recoveryOwnerType;
  if (ownerType !== "board" && ownerType !== "user") return null;
  if (nonEmptyString(payload.recoveryOwnerAgentId)) return null;
  const recoveryKind = safeToken(payload.recoveryCause) ?? safeToken(payload.cause) ?? safeToken(payload.recoveryKind) ?? safeToken(payload.routingPolicy);
  return { recoveryActionId: recoveryActionId.toLowerCase(), ownerType, recoveryKind };
}

/**
 * A recovery escalation: a system `issue.updated` that moved the issue into
 * `blocked` and names a board- or user-owned recovery action. Recovery
 * activity is written by the host with `actorType: "system"`; the same fields
 * on an event from any other actor are not trusted.
 */
function classifyRecovery(event: EventLike, payload: Record<string, unknown>): DecisionCandidate | null {
  const issueId = nonEmptyString(event.entityId);
  if (!issueId || !UUID_PATTERN.test(issueId)) return null;
  if (event.entityType !== undefined && event.entityType !== "issue") return null;
  if (event.actorType !== "system") return null;
  // A recovery that blocks its source issue; the host read confirms it is still open.
  if (!enteredBlocked(payload) && payload.status !== "blocked") return null;
  const recovery = recoveryFromPayload(payload);
  if (!recovery) return null;
  return { kind: "recovery", companyId: event.companyId, issueId, ...recovery };
}

/**
 * `issue.updated` is a candidate only when the issue is now blocked and the
 * update moved it into `blocked` or changed its unblock descriptor. Whether a
 * person owns the unblock step is confirmed against the current issue.
 */
function classifyIssueUpdated(event: EventLike, payload: Record<string, unknown>): DecisionCandidate | null {
  const issueId = nonEmptyString(event.entityId);
  if (!issueId) return null;
  const changes = asRecord(payload.changes) ?? {};
  const entered = enteredBlocked(payload);
  const descriptorChanged = "unblockDescriptor" in changes;
  if (!entered && !descriptorChanged) return null;
  if (!entered && payload.status !== undefined && payload.status !== "blocked") return null;
  return { kind: "blocker", companyId: event.companyId, issueId };
}

/** True when an `issue.updated` payload moved the issue into `in_review` or changed who holds it there. */
function reviewChanged(payload: Record<string, unknown>): boolean {
  const changes = asRecord(payload.changes) ?? {};
  const statusChange = asRecord(changes.status);
  const previous = asRecord(payload._previous);
  if (statusChange) return statusChange.to === "in_review" && statusChange.from !== "in_review";
  if (payload.status === "in_review" && previous !== null && "status" in previous && previous.status !== "in_review") return true;
  const patch = asRecord(payload.patch) ?? {};
  const assigneeChanged = "assigneeUserId" in changes || "assigneeUserId" in patch || "executionState" in changes;
  return assigneeChanged && (payload.status === undefined || payload.status === "in_review");
}

function classifyReview(event: EventLike, payload: Record<string, unknown>): DecisionCandidate | null {
  const issueId = nonEmptyString(event.entityId);
  if (!issueId || !UUID_PATTERN.test(issueId)) return null;
  if (event.entityType !== undefined && event.entityType !== "issue") return null;
  if (!reviewChanged(payload)) return null;
  return { kind: "review", companyId: event.companyId, issueId };
}

export function classifyEvent(event: EventLike, triggers: NotifierTriggers): DecisionCandidate | null {
  const payload = asRecord(event.payload);
  if (!payload || !nonEmptyString(event.companyId)) return null;

  switch (event.eventType) {
    case "approval.created":
      return triggers.approvals ? classifyApproval(event, payload) : null;
    case INTERACTION_CREATED:
      return triggers.interactions ? classifyInteraction(event, payload) : null;
    case "activity.logged": {
      // Not emitted to plugins by current hosts; accepted defensively in case a
      // host forwards raw activity rows (`{ action, details, entityId }`).
      if (!triggers.interactions || payload.action !== INTERACTION_CREATED) return null;
      const details = asRecord(payload.details) ?? payload;
      return classifyInteraction(
        { ...event, entityId: nonEmptyString(payload.entityId) ?? event.entityId, entityType: nonEmptyString(payload.entityType) ?? event.entityType },
        details,
      );
    }
    case "issue.updated": {
      // A recovery escalation is its own item (one per recovery action); any
      // other blocked transition goes through the human-owned blocker rule.
      const recovery = triggers.recoveries ? classifyRecovery(event, payload) : null;
      if (recovery) return recovery;
      const blocker = triggers.blockerAttention ? classifyIssueUpdated(event, payload) : null;
      if (blocker) return blocker;
      return triggers.reviews ? classifyReview(event, payload) : null;
    }
    case BLOCKER_ATTENTION_CHANGED:
      return triggers.blockerAttention ? classifyBlockerAttention(event, payload) : null;
    case DECISION_CREATED:
      return triggers.decisions ? classifyDecision(event, payload) : null;
    default:
      return null;
  }
}

export interface IssueBlockerView {
  status?: string | null;
  unblockDescriptor?: { owner?: unknown } | null;
  blockedTransitionAt?: string | Date | null;
}

/** Mirrors the board attention rule for a human-owned unblock descriptor. */
export function isHumanOwnedBlocker(issue: IssueBlockerView): boolean {
  if (issue.status !== "blocked") return false;
  const owner = issue.unblockDescriptor?.owner;
  if (owner === "board") return true;
  const ownerRecord = asRecord(owner);
  return ownerRecord !== null && nonEmptyString(ownerRecord.userId) !== null;
}

/**
 * Dedupe identity for one blocked episode of an issue. A new episode (the
 * issue leaves and re-enters `blocked`) gets a new transition timestamp.
 */
export function blockerDecisionKey(issueId: string, issue: IssueBlockerView): string {
  const at = issue.blockedTransitionAt;
  const stamp = at instanceof Date ? at.toISOString() : nonEmptyString(at) ?? "unknown";
  return `blocker:${issueId}:${stamp}`;
}

/**
 * Episode record for a computed blocker-attention item: the board feed's own
 * `dedupKey` (`blocker:<terminal issue id>`). It is open while the item is in
 * the feed and closed when the host reports that it left.
 */
export function blockerTreeEpisodeKey(dedupKey: string): string {
  return `episode:${dedupKey}`;
}

/**
 * A blocked recovery is open for routing while the issue is still `blocked`
 * and nobody has taken the next step: no unblock descriptor, or one that
 * still names the board or a user. A descriptor naming an agent means an
 * agent (for example the triage agent) has taken it.
 */
export function isOpenRecovery(issue: IssueBlockerView | null | undefined): boolean {
  if (!issue || issue.status !== "blocked") return false;
  const descriptor = issue.unblockDescriptor;
  if (descriptor === null || descriptor === undefined) return true;
  const owner = descriptor.owner;
  if (owner === undefined || owner === null || owner === "board") return true;
  const ownerRecord = asRecord(owner);
  if (!ownerRecord) return false;
  if (nonEmptyString(ownerRecord.agentId)) return false;
  return nonEmptyString(ownerRecord.userId) !== null;
}

export interface CommentLike {
  authorType?: unknown;
  deletedAt?: unknown;
  createdAt?: unknown;
  metadata?: unknown;
}

/**
 * The host's own recovery escalation notice on an issue: a system comment
 * whose metadata has a `Recovery action` key-value row (the raw action id;
 * the host relies on this row for its own dedupe) and a `Recovery owner` row.
 * A key-value owner row (`board`, `Board decision required`) is a board-owned
 * action; an agent-link owner row is agent-owned and ignored. Only
 * `authorType: "system"` comments count: agents and users cannot write
 * system comments.
 */
export function recoveryNoticeFromComment(comment: CommentLike): { recoveryActionId: string; at: number; recoveryKind: string | null } | null {
  if (comment.authorType !== "system" || comment.deletedAt) return null;
  const metadata = asRecord(comment.metadata);
  if (!metadata || metadata.version !== 1 || !Array.isArray(metadata.sections)) return null;
  let actionId: string | null = null;
  let boardOwner = false;
  let cause: string | null = null;
  for (const section of metadata.sections) {
    const rows = asRecord(section)?.rows;
    if (!Array.isArray(rows)) continue;
    for (const raw of rows) {
      const row = asRecord(raw);
      if (!row) continue;
      if (row.label === "Recovery action" && row.type === "key_value") {
        const value = nonEmptyString(row.value);
        if (value && UUID_PATTERN.test(value)) actionId = value.toLowerCase();
      } else if (row.label === "Cause" && row.type === "key_value") {
        cause = safeToken(row.value);
      } else if (row.label === "Recovery owner") {
        boardOwner = row.type === "key_value" && nonEmptyString(row.value) !== null;
      }
    }
  }
  if (!actionId || !boardOwner) return null;
  const at = comment.createdAt instanceof Date ? comment.createdAt.getTime() : Date.parse(String(comment.createdAt ?? ""));
  return { recoveryActionId: actionId, at: Number.isNaN(at) ? 0 : at, recoveryKind: cause };
}

export interface IssueReviewView {
  status?: string | null;
  assigneeAgentId?: string | null;
  assigneeUserId?: string | null;
  executionState?: unknown;
  reviewAttention?: { state?: unknown } | null;
}

function boundedId(value: unknown): string | null {
  const text = nonEmptyString(value);
  return text && TOKEN_PATTERN.test(text) ? text : null;
}

/**
 * Why an in-review issue is on the board feed, mirroring the host attention
 * rule for `review` items (a pending approval is its own approval item):
 * - `participant:<stage>:<user>`: the current native stage participant is a user;
 * - `assignee:<user>`: the issue is assigned to a user;
 * - `stalled`: `reviewAttention.state = stalled` (no maintained review path).
 * The reason is part of the dedupe key: one routing per issue and reason.
 */
export function reviewReason(issue: IssueReviewView | null | undefined): string | null {
  if (!issue || issue.status !== "in_review") return null;
  const state = asRecord(issue.executionState);
  const participant = state && state.status === "pending" ? asRecord(state.currentParticipant) : null;
  if (participant && participant.type === "user") {
    const stage = boundedId(state?.currentStageId) ?? "stage";
    return `participant:${stage}:${boundedId(participant.userId) ?? "user"}`;
  }
  const assigneeUserId = nonEmptyString(issue.assigneeUserId);
  if (assigneeUserId) return `assignee:${boundedId(assigneeUserId) ?? "user"}`;
  if (asRecord(issue.reviewAttention)?.state === "stalled") return "stalled";
  return null;
}

export interface InteractionView {
  kind?: unknown;
  status?: unknown;
  addresseeAgentId?: unknown;
  addresseeUserId?: unknown;
  requestedResolverPolicy?: unknown;
  effectiveResolverPolicy?: unknown;
  resolverPolicy?: unknown;
  payload?: unknown;
  createdByUserId?: unknown;
  toolActionRequestId?: unknown;
}

/** Card kinds that are a choice on the reserved list by their kind alone (accounts, access, credentials). */
export const RESERVED_INTERACTION_KINDS = new Set(["connection_intent"]);
/** Interaction kinds this plugin knows. Any other kind is routed like a known one. */
export const KNOWN_INTERACTION_KINDS = new Set([
  "suggest_tasks",
  "ask_user_questions",
  "request_confirmation",
  "request_checkbox_confirmation",
  "request_item_verdicts",
  "connection_intent",
]);

/**
 * `reserved` when the structured fields of a human-addressed card show a
 * choice that stays with a person: a connection intent (accounts, access,
 * credentials), a tool-gateway action (an approval for an external action),
 * a secret proposal (credentials), a human-only resolver policy, or a card a
 * person raised. Titles, prompts and bodies are never read. A card whose
 * fields cannot be read is `ambiguous`: it is reported, never routed.
 */
export function cardDisposition(card: InteractionView | null, eventDetails: Record<string, unknown> = {}): "route" | "reserved" | "ambiguous" {
  if (!card) return "ambiguous";
  const kind = nonEmptyString(card.kind) ?? nonEmptyString(eventDetails.interactionKind);
  if (!kind) return "ambiguous";
  if (RESERVED_INTERACTION_KINDS.has(kind)) return "reserved";
  if (nonEmptyString(card.toolActionRequestId) || nonEmptyString(eventDetails.toolActionRequestId)) return "reserved";
  const payload = asRecord(card.payload);
  if (payload && (payload.toolAction !== undefined && payload.toolAction !== null)) return "reserved";
  if (payload && (payload.secretProposal !== undefined && payload.secretProposal !== null)) return "reserved";
  for (const policy of [card.effectiveResolverPolicy, card.requestedResolverPolicy, card.resolverPolicy, eventDetails.effectiveResolverPolicy, eventDetails.requestedResolverPolicy]) {
    if (policy === "human_only" || policy === "board_only") return "reserved";
  }
  if (nonEmptyString(card.createdByUserId)) return "reserved";
  return "route";
}
