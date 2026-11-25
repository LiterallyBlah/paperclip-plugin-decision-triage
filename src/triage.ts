import { AsyncLocalStorage } from "node:async_hooks";
import type { PluginContext, PluginEvent } from "@paperclipai/plugin-sdk";
import { parseConfig, UUID_PATTERN, type TriageConfig } from "./config.js";
import { isRaisedByTriage, raisedBy, raisedByLabel } from "./creator.js";
import { buildBoardLink, buildRoutingDescription, buildWakeText, isSafeIdentifier, MAX_ITEMS_PER_WAKE, safeTitle, type WakeLine } from "./text.js";
import {
  BLOCKER_ATTENTION_CHANGED,
  blockerDecisionKey,
  blockerTreeEpisodeKey,
  cardDisposition,
  classifyEvent,
  interactionRouting,
  isHumanOwnedBlocker,
  isOpenRecovery,
  recoveryNoticeFromComment,
  reviewReason,
  safeToken,
  type CommentLike,
  type DecisionCandidate,
  type InteractionView,
  type IssueBlockerView,
  type IssueReviewView,
} from "./triggers.js";
import { blockerIssueId, MarkerIndex, type MarkerRef } from "./marker-index.js";

export const STATE_NAMESPACE = "decision-triage";
export const PLUGIN_KEY = "paperclip.decision-triage";
/** Origin of the daily-cap investigation issue; `originId` is `daily-cap:<YYYY-MM-DD>`. */
export const CAP_ORIGIN_KIND = `plugin:${PLUGIN_KEY}:daily-cap` as const;
/**
 * Origin of a routing issue: one issue per routed item (and item state),
 * assigned to the triage agent, `originId` = the item's routing key. Found
 * again by origin before a new one is created, so a restart never makes a
 * second one.
 */
export const ROUTE_ORIGIN_KIND = `plugin:${PLUGIN_KEY}:route` as const;
/** Issues this plugin created (routing, daily cap). They are never routed themselves. */
export const OWN_ORIGIN_PREFIX = `plugin:${PLUGIN_KEY}`;
/** First retry of an item whose routing failed on every attempt; doubles per failed round. */
export const MISSED_RETRY_BASE_MS = 5 * 60 * 1000;
/** Longest wait between two retry rounds of an item that keeps failing. */
export const MISSED_RETRY_MAX_MS = 6 * 60 * 60 * 1000;
/** New items one sweep may queue per company; the rest wait for the next sweep. */
export const MAX_SWEEP_QUEUED = 100;
export const MAX_PENDING_ITEMS = 500;
export const MAX_WAKE_ATTEMPTS = 3;
/** Upper bound on items kept after their last failed wake; the oldest go first. */
export const MAX_MISSED_ITEMS = 500;
/** Catch-up sweep for board/user items the event path missed (recoveries, blockers, reviews). */
export const RECOVERY_SWEEP_INTERVAL_MS = 5 * 60 * 1000;
/** First sweep after a start (events emitted while the plugin was down or before install). */
export const RECOVERY_SWEEP_START_DELAY_MS = 30 * 1000;
/** Blocked issues read per company per sweep. */
export const MAX_SWEEP_ISSUES = 200;
/** A recovery notice belongs to the current blocked episode when written no earlier than this before it. */
export const NOTICE_EPISODE_SLACK_MS = 60 * 1000;
/** A blocked episode with no recovery notice is read again after this long. */
export const NONE_RECHECK_MS = 30 * 60 * 1000;
/**
 * An episode that enters the feed again this soon after its last wake is the
 * same episode coming back (often because the triage agent's own run made the
 * tree live for a moment): its marker is reopened, with no new routing issue
 * and no new wake.
 */
export const EPISODE_REENTRY_COOLDOWN_MS = 2 * 60 * 60 * 1000;
/**
 * A batch held because the triage agent cannot be invoked (paused, terminated,
 * pending approval, or not found) is checked again after this long. No routing
 * issue, wake, comment or cap count is spent while it waits.
 */
export const AGENT_UNAVAILABLE_RECHECK_MS = 5 * 60 * 1000;
/** Agent statuses the host refuses to invoke (host `NON_INVOKABLE_AGENT_STATUSES`). */
const NON_INVOKABLE_AGENT_STATUSES: ReadonlySet<string> = new Set(["paused", "terminated", "pending_approval"]);

/**
 * Timer callbacks (recovery sweep, debounced flush) must not inherit the host
 * invocation that armed them. The SDK stamps every host call with the
 * AsyncLocalStorage invocation in scope; once that invocation (an event, or
 * the `onConfigChanged` call) ends, the host refuses calls stamped with it
 * ("missing, expired, or unknown invocation scope"). Work that carries no
 * invocation is proactive work for the plugin's configured companies. This
 * snapshot is taken at module load, outside every invocation.
 */
const runDetached = AsyncLocalStorage.snapshot();
export function detached<T>(fn: () => T): T {
  return runDetached(fn);
}

export interface TriageOptions {
  now: () => number;
  setTimer: (fn: () => void, ms: number) => unknown;
  clearTimer: (handle: unknown) => void;
  retryDelayMs: number;
  /** Recovery catch-up sweep interval; 0 turns the timer off (tests call `sweepRecoveries`). */
  sweepIntervalMs?: number;
  sweepStartDelayMs?: number;
}

export const DEFAULT_TRIAGE_OPTIONS: TriageOptions = {
  now: () => Date.now(),
  setTimer: (fn, ms) => {
    const handle = setTimeout(fn, ms);
    handle.unref?.();
    return handle;
  },
  clearTimer: (handle) => clearTimeout(handle as ReturnType<typeof setTimeout>),
  retryDelayMs: 30_000,
  sweepIntervalMs: RECOVERY_SWEEP_INTERVAL_MS,
  sweepStartDelayMs: RECOVERY_SWEEP_START_DELAY_MS,
};

/** One decision item waiting for its debounced wake. Persisted, so it survives a restart. */
export interface PendingItem {
  companyId: string;
  key: string;
  mode: "once" | "episode";
  kind: DecisionCandidate["kind"];
  itemId: string;
  issueId: string | null;
  approvalId: string | null;
  decisionId: string | null;
  raisedBy: string;
  dueAt: number;
  attempts: number;
  /**
   * `route`: the triage agent becomes the item's responder of record (a
   * routing issue assigned to it) and is woken for it. `report`: a choice
   * that stays with a person (pending approval, reserved card, or a card
   * whose fields cannot be read); the wake reports it and nothing is routed.
   * Missing on items queued by 0.2.0: read as `route`, except approvals.
   */
  disposition?: "route" | "report";
  /** Bounded host token: recovery kind/cause, review reason or card class. */
  detail?: string | null;
  /** Episode items: when this episode was first queued; part of the routing issue origin. */
  episodeAt?: string | null;
  /** Missed items only: earliest time a retry round may queue the item again. */
  retryAt?: number;
  /** Missed items only: number of failed rounds so far. */
  rounds?: number;
}

interface PendingState {
  v: 1;
  items: PendingItem[];
}

interface WokenMarker {
  v: 1;
  at: string;
  /** Episode items only: false once the item left the board feed. */
  open?: boolean;
  /** Recovery items only: the source issue, so a live recovery's marker is never pruned. */
  issueId?: string;
  /** Routed items: the routing issue assigned to the triage agent. */
  routeIssueId?: string;
}

export interface CapState {
  v: 1;
  wakes: number;
  suppressed: number;
  investigationIssueId: string | null;
}

export type TriageOutcome =
  | "ignored"
  | "not_configured"
  | "disabled"
  | "triage_raised"
  | "not_eligible"
  | "duplicate"
  | "queued"
  | "episode_closed"
  | "error";

export interface SweepOutcome {
  companies: number;
  issues: number;
  queued: number;
  duplicate: number;
  skipped: boolean;
  errors: number;
  /** Routing issues closed because their source item left the board or changed state. */
  closed?: number;
  /** New items held for the next sweep by `MAX_SWEEP_QUEUED`. */
  deferred?: number;
  /** Where the company ids came from: the configured set, the fallback list, or a failed list. */
  source?: CompanySource;
  /** Company ids considered (configured set or fallback list). */
  candidates?: number;
  /** Companies with a config whose kill switch is off (`enabled: false`). */
  disabled?: number;
  /** Companies with no usable config (none stored, invalid, or unreadable). */
  noConfig?: number;
}

export type CompanySource = "configured" | "list" | "list_failed";

export type FlushOutcome = { companyId: string; items: number; result: "woken" | "fallback" | "capped" | "dropped" | "retry" | "failed"; runId?: string | null };

interface Resolved {
  key: string;
  mode: "once" | "episode" | "close";
  disposition?: "route" | "report";
  detail?: string | null;
}

/**
 * Wakes the configured triage agent for every new board decision item that the
 * triage agent did not raise itself. Never throws from an event handler. Log
 * lines carry coarse outcome codes only, never ids, titles or text.
 */
export class DecisionTriage {
  private readonly feedQueue = new Map<string, Promise<unknown>>();
  private lock: Promise<unknown> = Promise.resolve();
  private timer: unknown = null;
  private timerDueAt: number | null = null;
  private sweepTimer: unknown = null;
  private sweeping = false;
  private stopped = false;
  /**
   * Blocked episodes already evaluated by the sweep, so an unchanged blocked
   * issue costs no comment read. A routed episode is not read again; one with
   * no recovery notice is read again after `NONE_RECHECK_MS`. Memory only:
   * after a restart the durable markers still prevent any replay.
   */
  private readonly swept = new Map<string, { stamp: string; until: number }>();
  /** Age-based pruning of the per-item `woken:` and daily `cap:` markers. Exposed for tests. */
  readonly markers: MarkerIndex;
  /**
   * Company ids with a stored config, learned from the host's config-change
   * hook (replayed for every stored config at worker start, and sent on every save). The sweep runs from a worker timer, outside any host
   * invocation: the host admits such a call only when it names a configured
   * company, and denies an unscoped `companies.list` while any event invocation
   * of this worker is still open. So the sweep works from this set.
   */
  private readonly configuredCompanies = new Set<string>();

  constructor(
    private readonly ctx: PluginContext,
    private readonly options: TriageOptions = DEFAULT_TRIAGE_OPTIONS,
  ) {
    this.markers = new MarkerIndex(ctx.state, STATE_NAMESPACE, {
      now: () => this.options.now(),
      keep: (ref, value) => this.markerStillLive(ref, value),
    });
  }

  /**
   * A marker past its age is kept while its item is still live: an open feed
   * episode, or a human-owned block that has not changed since the wake.
   */
  private async markerStillLive(ref: MarkerRef, value: unknown): Promise<boolean> {
    if (!ref.stateKey.startsWith("woken:")) return false;
    if ((value as WokenMarker | null)?.open === true) return true;
    if (ref.stateKey.startsWith("woken:recovery:")) {
      // Keep the marker while its recovery is still open, so it is never routed twice.
      const recoveryIssueId = (value as WokenMarker | null)?.issueId;
      if (!recoveryIssueId) return false;
      return isOpenRecovery((await this.ctx.issues.get(recoveryIssueId, ref.companyId)) as IssueBlockerView | null);
    }
    const key = ref.stateKey.slice("woken:".length);
    const issueId = blockerIssueId(key);
    if (!issueId) return false;
    const issue = (await this.ctx.issues.get(issueId, ref.companyId)) as IssueBlockerView | null;
    return !!issue && isHumanOwnedBlocker(issue) && blockerDecisionKey(issueId, issue) === key;
  }

  /**
   * Re-arm the debounce timer from persisted pending items (after a restart).
   * Items whose wake failed earlier are queued again, so this start's first
   * wake carries them.
   */
  async start(): Promise<void> {
    await this.exclusive(async () => {
      let pending = await this.loadPending();
      const missed = await this.loadMissed();
      if (missed.length > 0) {
        pending = await this.requeueMissed(pending, missed, null);
        await this.savePending(pending);
      }
      this.scheduleFrom(pending);
    });
    this.stopped = false;
    this.scheduleSweep(this.options.sweepStartDelayMs ?? RECOVERY_SWEEP_START_DELAY_MS);
    await this.markers.maybePrune();
  }

  /**
   * Called from the SDK `onConfigChanged` hook, which the host sends on every
   * config save and replays for every stored company config right after the
   * worker starts (before the first sweep, which runs 30 s later). That replay
   * is how the set is learned at start: probing the company list in `start()`
   * would read the config of every company, and the host denies (and logs) a
   * read of a company the plugin is not configured for.
   * An empty config forgets the company; anything else (even an invalid or
   * disabled config) keeps it, so the sweep still loads it and applies the
   * kill switch itself. A company id that is not a UUID is ignored.
   */
  noteConfigChanged(companyId: string | null | undefined, config: Record<string, unknown> | null | undefined): void {
    if (typeof companyId !== "string" || !UUID_PATTERN.test(companyId)) return;
    const id = companyId.toLowerCase();
    if (!config || Object.keys(config).length === 0) this.configuredCompanies.delete(id);
    else this.configuredCompanies.add(id);
  }

  /**
   * Companies to sweep: the configured set when it is not empty; otherwise the
   * unscoped company list as a fallback. Every later host call names its
   * company. A failed or empty list is logged with an outcome code, no ids.
   */
  private async companyIds(): Promise<{ ids: string[]; source: CompanySource }> {
    if (this.configuredCompanies.size > 0) return { ids: [...this.configuredCompanies], source: "configured" };
    try {
      const companies = await this.ctx.companies.list({ limit: 100 });
      const ids = companies.map((company) => company.id).filter((id): id is string => typeof id === "string" && UUID_PATTERN.test(id));
      if (ids.length === 0) this.ctx.logger.warn("decision triage: no companies to sweep", { outcome: "no_companies" });
      return { ids, source: "list" };
    } catch (error) {
      this.ctx.logger.warn("decision triage: company enumeration failed; nothing swept", {
        outcome: "company_list_failed",
        errorName: error instanceof Error ? error.name : typeof error,
      });
      return { ids: [], source: "list_failed" };
    }
  }

  /** Stop the flush timer. Pass `shutdown` to stop the recovery sweep as well. */
  stop(shutdown = false): void {
    if (this.timer !== null) this.options.clearTimer(this.timer);
    this.timer = null;
    this.timerDueAt = null;
    if (shutdown) {
      this.stopped = true;
      if (this.sweepTimer !== null) this.options.clearTimer(this.sweepTimer);
      this.sweepTimer = null;
    }
  }

  handle(event: PluginEvent): Promise<TriageOutcome> {
    const orderKey = feedOrderKey(event);
    if (orderKey === null) return this.process(event);
    const previous = this.feedQueue.get(orderKey) ?? Promise.resolve();
    const run = () => this.process(event);
    const result = previous.then(run, run);
    const tail = result.then(
      () => undefined,
      () => undefined,
    );
    this.feedQueue.set(orderKey, tail);
    void tail.then(() => {
      if (this.feedQueue.get(orderKey) === tail) this.feedQueue.delete(orderKey);
    });
    return result;
  }

  private async process(event: PluginEvent): Promise<TriageOutcome> {
    let kind = "unknown";
    try {
      const config = await this.loadConfig(event.companyId);
      if (!config) return "not_configured";
      if (!config.enabled) return "disabled";
      const candidate = classifyEvent(event, config.triggers);
      if (!candidate) return "ignored";
      kind = candidate.kind;
      if (isRaisedByTriage(event, config.triageAgentId)) return this.log(kind, "triage_raised");
      const resolved = await this.resolve(candidate, config, event);
      if (!resolved) return this.log(kind, "not_eligible");
      if (resolved.mode === "close") return this.log(kind, await this.closeEpisode(candidate.companyId, resolved.key));
      const item: PendingItem = {
        companyId: candidate.companyId,
        key: resolved.key,
        mode: resolved.mode,
        kind: candidate.kind,
        itemId: itemIdOf(candidate),
        issueId: candidate.issueId,
        approvalId: candidate.kind === "approval" ? candidate.approvalId : null,
        decisionId: candidate.kind === "decision" ? candidate.decisionId : null,
        raisedBy: raisedByLabel(raisedBy(event)),
        dueAt: 0,
        attempts: 0,
        disposition: resolved.disposition ?? "route",
        detail: resolved.detail ?? null,
        episodeAt: resolved.mode === "episode" ? new Date(this.options.now()).toISOString() : null,
      };
      return this.log(kind, await this.enqueue(item, config));
    } catch (error) {
      this.ctx.logger.warn("decision triage: event handling failed", {
        kind,
        outcome: "error",
        errorName: error instanceof Error ? error.name : typeof error,
      });
      return "error";
    }
  }

  private log(kind: string, outcome: TriageOutcome): TriageOutcome {
    this.ctx.logger.debug("decision triage: event handled", { kind, outcome });
    return outcome;
  }

  private async loadConfig(companyId: string): Promise<TriageConfig | null> {
    const raw = await this.ctx.config.get(companyId);
    if (!raw || Object.keys(raw).length === 0) return null;
    const parsed = parseConfig(raw);
    if (!parsed.ok) {
      this.ctx.logger.warn("decision triage: config is invalid; triage is off", { errorCount: parsed.errors.length });
      return null;
    }
    return parsed.config;
  }

  private async resolve(candidate: DecisionCandidate, config: TriageConfig, event: PluginEvent | null): Promise<Resolved | null> {
    switch (candidate.kind) {
      case "approval":
        // A pending approval is a board decision with its own authority: reported, never routed.
        return {
          key: candidate.toolActionRequestId ? `tool-action:${candidate.toolActionRequestId}` : `approval:${candidate.approvalId}`,
          mode: "once",
          disposition: "report",
          detail: "approval",
        };
      case "interaction": {
        // The card's structured fields decide; its title, prompt and body are never read.
        const cards = await this.ctx.issues.listInteractions(candidate.issueId, candidate.companyId).catch(() => null);
        const card = (cards?.find((entry) => entry.id === candidate.interactionId) ?? null) as InteractionView | null;
        if (card) {
          const routing = interactionRouting({ interactionStatus: card.status, addresseeAgentId: card.addresseeAgentId ?? null });
          // An agent-addressed card is agent traffic, not a board item; a resolved one is gone.
          if (routing === "agent" || routing === "not_pending") return null;
        }
        const details = (event?.payload && typeof event.payload === "object" ? event.payload : {}) as Record<string, unknown>;
        let disposition = cardDisposition(card, details);
        // A card a person raised for a person stays between them.
        if (disposition === "route" && raisedBy(event ?? { eventType: "", payload: {} }).type === "user") disposition = "reserved";
        return {
          key: candidate.toolActionRequestId ? `tool-action:${candidate.toolActionRequestId}` : `interaction:${candidate.interactionId}`,
          mode: "once",
          disposition: disposition === "route" ? "route" : "report",
          detail: `card:${safeToken(card?.kind ?? details.interactionKind) ?? "unknown"}:${disposition}`,
        };
      }
      case "blocker": {
        const issue = (await this.ctx.issues.get(candidate.issueId, candidate.companyId)) as (IssueBlockerView & OwnView) | null;
        if (!issue || !isHumanOwnedBlocker(issue)) return null;
        // The triage agent's own escalation to a person, or a plugin issue: not routed back to it.
        if (ownedByTriage(issue, config)) return null;
        return { key: blockerDecisionKey(candidate.issueId, issue), mode: "once", detail: "unblock_owner" };
      }
      case "review": {
        const issue = (await this.ctx.issues.get(candidate.issueId, candidate.companyId)) as (IssueReviewView & OwnView) | null;
        const reason = reviewReason(issue);
        if (!issue || !reason) return null;
        if (ownedByTriage(issue, config)) return null;
        return { key: reviewKey(candidate.issueId, reason), mode: "once", detail: `review_${reason.split(":")[0]}` };
      }
      case "blocker_tree": {
        const episode = blockerTreeEpisodeKey(candidate.dedupKey);
        if (candidate.phase === "exit") return { key: episode, mode: "close" };
        const terminal = (await this.ctx.issues.get(candidate.issueId, candidate.companyId).catch(() => null)) as (IssueBlockerView & OwnView) | null;
        // A terminal the triage agent already holds (a plugin routing issue, or one assigned to it): not routed back to it.
        if (terminal && ownedByTriage(terminal, config)) return null;
        if (terminal && isHumanOwnedBlocker(terminal)) {
          return { key: blockerDecisionKey(candidate.issueId, terminal), mode: "once", detail: "unblock_owner" };
        }
        return { key: episode, mode: "episode", detail: "blocker_tree" };
      }
      case "decision":
        return { key: `decision:${candidate.decisionId}`, mode: "once", detail: "decision" };
      case "recovery": {
        // Routed only while still open: a recovery already resolved, or taken by an agent, is not replayed.
        const issue = (await this.ctx.issues.get(candidate.issueId, candidate.companyId)) as (IssueBlockerView & OwnView) | null;
        if (!isOpenRecovery(issue) || isOwnIssue(issue)) return null;
        return { key: recoveryKey(candidate.recoveryActionId), mode: "once", detail: candidate.recoveryKind ?? `recovery_${candidate.ownerType}` };
      }
    }
  }

  // ---- recovery catch-up sweep --------------------------------------------

  private scheduleSweep(delayMs: number): void {
    const interval = this.options.sweepIntervalMs ?? 0;
    if (this.stopped || interval <= 0) return;
    if (this.sweepTimer !== null) this.options.clearTimer(this.sweepTimer);
    this.sweepTimer = this.options.setTimer(() => {
      this.sweepTimer = null;
      detached(() => {
        void this.sweepRecoveries()
          .catch((error) => {
            this.ctx.logger.warn("decision triage: recovery sweep failed", { errorName: error instanceof Error ? error.name : typeof error });
          })
          .finally(() => this.scheduleSweep(interval));
      });
    }, Math.max(0, delayMs));
  }

  /**
   * Bounded catch-up for board/user items whose event was missed (lost,
   * emitted before install, or while the plugin was down), and the first-sweep
   * catch-up of items that already exist. Per company it reads the blocked
   * issues (recovery notices of any kind, human-owned unblock descriptors,
   * non-live blocker trees) and the in-review issues (user assignee, user stage
   * participant, stalled review path). Items go through the same dedupe,
   * debounce and cap as events. It also queues again missed items whose retry
   * time has come. Reads only; never writes to a source issue. Exposed for tests.
   */
  async sweepRecoveries(): Promise<SweepOutcome> {
    return this.sweep();
  }

  async sweep(): Promise<SweepOutcome> {
    const outcome: SweepOutcome = {
      companies: 0,
      issues: 0,
      queued: 0,
      duplicate: 0,
      skipped: false,
      errors: 0,
      closed: 0,
      deferred: 0,
      candidates: 0,
      disabled: 0,
      noConfig: 0,
    };
    if (this.sweeping) return { ...outcome, skipped: true };
    this.sweeping = true;
    const seenIds: string[] = [];
    let companyQueued = 0;
    const count = (result: "skip" | "none" | "queued" | "duplicate" | "error") => {
      if (result === "skip") return;
      if (result === "queued") companyQueued += 1;
      outcome.issues += 1;
      if (result === "queued") outcome.queued += 1;
      else if (result === "duplicate") outcome.duplicate += 1;
      else if (result === "error") outcome.errors += 1;
    };
    try {
      const { ids, source } = await this.companyIds();
      outcome.source = source;
      outcome.candidates = ids.length;
      for (const companyId of ids) {
        const config = await this.loadConfig(companyId).catch(() => null);
        if (!config) {
          outcome.noConfig = (outcome.noConfig ?? 0) + 1;
          continue;
        }
        if (!config.enabled) {
          outcome.disabled = (outcome.disabled ?? 0) + 1;
          continue;
        }
        const { recoveries, blockerAttention, reviews } = config.triggers;
        if (!recoveries && !blockerAttention && !reviews) continue;
        outcome.companies += 1;
        companyQueued = 0;
        const full = () => companyQueued >= MAX_SWEEP_QUEUED;
        if (recoveries || blockerAttention) {
          const blocked = await this.ctx.issues.list({ companyId, status: "blocked", limit: MAX_SWEEP_ISSUES });
          seenIds.push(...blocked.map((issue) => issue.id));
          for (const raw of blocked) {
            const issue = raw as unknown as BlockedSweepView;
            if (!issue.id || isOwnIssue(issue)) continue;
            if (full()) {
              outcome.deferred = (outcome.deferred ?? 0) + 1;
              continue;
            }
            if (recoveries) count(await this.sweepIssue(companyId, issue, config).catch(() => "error" as const));
            if (blockerAttention) {
              for (const item of blockedItems(companyId, issue, config, this.options.now())) {
                if (item.kind === "blocker_tree" && (await this.terminalOwnedByTriage(companyId, issue, item.issueId, config))) continue;
                count(await this.enqueueSwept(item, config));
              }
            }
          }
        }
        if (reviews) {
          const inReview = await this.ctx.issues.list({ companyId, status: "in_review", limit: MAX_SWEEP_ISSUES });
          for (const raw of inReview) {
            const issue = raw as unknown as SweepIssue & IssueReviewView;
            if (!issue.id || isOwnIssue(issue) || ownedByTriage(issue, config)) continue;
            const reason = reviewReason(issue);
            if (!reason) continue;
            if (full()) {
              outcome.deferred = (outcome.deferred ?? 0) + 1;
              continue;
            }
            count(await this.enqueueSwept(sweptItem(companyId, reviewKey(issue.id, reason), "review", issue.id, `review_${reason.split(":")[0]}`), config));
          }
        }
        await this.requeueDueMissed(companyId);
        outcome.closed = (outcome.closed ?? 0) + (await this.closeStaleRoutes(companyId, config).catch(() => 0));
      }
      // The cache only holds issues that are still blocked.
      const live = new Set(seenIds);
      for (const id of [...this.swept.keys()]) if (!live.has(id)) this.swept.delete(id);
    } finally {
      this.sweeping = false;
    }
    // Counts only: no ids, titles or text.
    this.ctx.logger.info("decision triage: sweep finished", { ...outcome });
    return outcome;
  }

  /**
   * Keeps the triage agent's queue current: a routing issue still `todo` (not
   * started: no checkout or execution run) whose source item has left the
   * board or changed state is closed (`cancelled`) with a short comment. Only
   * the plugin's own routing issues assigned to the triage agent are touched;
   * a source that cannot be read, or an item kind the plugin cannot re-check
   * (board decisions), is left for the triage agent.
   */
  private async closeStaleRoutes(companyId: string, config: TriageConfig): Promise<number> {
    const routes = await this.ctx.issues.list({ companyId, originKind: ROUTE_ORIGIN_KIND, status: "todo", limit: MAX_SWEEP_ISSUES });
    let closed = 0;
    for (const route of routes as unknown as RouteView[]) {
      if (route.originKind !== ROUTE_ORIGIN_KIND || typeof route.originId !== "string") continue;
      if ((route.assigneeAgentId ?? "").toLowerCase() !== config.triageAgentId.toLowerCase()) continue;
      if (route.checkoutRunId || route.executionRunId) continue;
      const reason = await this.staleReason(companyId, route.originId).catch(() => null);
      if (!reason) continue;
      await this.ctx.issues.createComment(
        route.id,
        `Decision triage: the source item ${reason}. This routing issue is closed; nothing else was changed.`,
        companyId,
      );
      await this.ctx.issues.update(route.id, { status: "cancelled" }, companyId);
      await this.forgetRoutedMarker(companyId, route);
      closed += 1;
    }
    if (closed > 0) this.ctx.logger.info("decision triage: stale routing issues closed", { outcome: "route_closed", items: closed });
    return closed;
  }

  /**
   * After a stale routing issue is cancelled, drop its item's `woken:` marker
   * and index entry, so the item is routed again (new routing issue, new wake)
   * if it comes back to the board. A marker that names a different routing
   * issue (a later episode) is left alone.
   */
  private async forgetRoutedMarker(companyId: string, route: RouteView): Promise<void> {
    const key = (route.originId ?? "").split("@")[0];
    if (!key) return;
    await this.exclusive(async () => {
      const scope = this.markerScope(companyId, key);
      const marker = (await this.ctx.state.get(scope)) as WokenMarker | null | undefined;
      if (!marker || (marker.routeIssueId && marker.routeIssueId !== route.id)) return;
      await this.ctx.state.delete(scope);
      await this.markers.forget({ companyId, stateKey: scope.stateKey });
    });
  }

  /** Why a routed item is no longer on the board, or null when it still is (or cannot be told). */
  private async staleReason(companyId: string, originId: string): Promise<string | null> {
    const key = originId.split("@")[0];
    const marker = (await this.ctx.state.get(this.markerScope(companyId, key))) as WokenMarker | null | undefined;
    if (key.startsWith("episode:")) return marker && marker.open === false ? "left the board feed" : null;
    const read = async (issueId: string | null | undefined) =>
      issueId ? ((await this.ctx.issues.get(issueId, companyId)) as (IssueBlockerView & IssueReviewView) | null) : null;
    if (key.startsWith("recovery:")) {
      const source = await read(marker?.issueId);
      if (!source) return null;
      return isOpenRecovery(source) ? null : "is no longer an open recovery";
    }
    if (key.startsWith("blocker:")) {
      const issueId = blockerIssueId(key);
      const source = await read(issueId);
      if (!source || !issueId) return null;
      return isHumanOwnedBlocker(source) && blockerDecisionKey(issueId, source) === key ? null : "is no longer blocked on a person";
    }
    if (key.startsWith("review:")) {
      const [, issueId, ...rest] = key.split(":");
      const source = await read(issueId);
      if (!source) return null;
      return reviewReason(source) === rest.join(":") ? null : "is no longer waiting on a person in review";
    }
    if (key.startsWith("interaction:")) {
      const sourceId = marker?.issueId;
      if (!sourceId) return null;
      const cards = await this.ctx.issues.listInteractions(sourceId, companyId);
      const card = cards.find((entry) => entry.id === key.slice("interaction:".length)) as InteractionView | undefined;
      return card && card.status !== undefined && card.status !== "pending" ? "card is no longer pending" : null;
    }
    return null;
  }

  /**
   * Sweep path: whether a blocker tree's terminal is held by the triage agent
   * (a plugin issue, or assigned to it). The listed issue is used when it is
   * the terminal; otherwise the terminal is read. An unreadable terminal is
   * not held (it is routed as an episode, as before).
   */
  private async terminalOwnedByTriage(companyId: string, listed: BlockedSweepView, terminalId: string | null, config: TriageConfig): Promise<boolean> {
    if (!terminalId) return false;
    if (terminalId === listed.id) return ownedByTriage(listed, config);
    const terminal = (await this.ctx.issues.get(terminalId, companyId).catch(() => null)) as OwnView | null;
    return !!terminal && ownedByTriage(terminal, config);
  }

  private async enqueueSwept(item: PendingItem, config: TriageConfig): Promise<"queued" | "duplicate" | "error"> {
    const result = await this.enqueue(item, config).catch(() => "error" as const);
    this.log(item.kind, result);
    return result === "queued" || result === "duplicate" ? result : "error";
  }

  private async sweepIssue(companyId: string, listed: SweepIssue, config: TriageConfig): Promise<"skip" | "none" | "queued" | "duplicate" | "error"> {
    if (!listed.id || !isOpenRecovery(listed)) return "skip";
    const stamp = episodeStamp(listed.blockedTransitionAt);
    const seen = this.swept.get(listed.id);
    if (seen && seen.stamp === stamp && this.options.now() < seen.until) return "skip";
    const comments = (await this.ctx.issues.listComments(listed.id, companyId)) as CommentLike[];
    const since = stamp === "unknown" ? 0 : Date.parse(stamp) - NOTICE_EPISODE_SLACK_MS;
    let notice: ReturnType<typeof recoveryNoticeFromComment> = null;
    for (const comment of comments) {
      const found = recoveryNoticeFromComment(comment);
      if (found && found.at >= since && (!notice || found.at >= notice.at)) notice = found;
    }
    if (!notice) {
      this.swept.set(listed.id, { stamp, until: this.options.now() + NONE_RECHECK_MS });
      return "none";
    }
    const item: PendingItem = {
      ...sweptItem(companyId, recoveryKey(notice.recoveryActionId), "recovery", listed.id, notice.recoveryKind ?? "recovery_board"),
      itemId: notice.recoveryActionId,
    };
    const result = await this.enqueue(item, config);
    if (result === "queued" || result === "duplicate") this.swept.set(listed.id, { stamp, until: Number.POSITIVE_INFINITY });
    this.log("recovery", result);
    return result === "queued" || result === "duplicate" ? result : "error";
  }

  // ---- state -------------------------------------------------------------

  private exclusive<T>(op: () => Promise<T>): Promise<T> {
    const result = this.lock.then(op, op);
    this.lock = result.then(
      () => undefined,
      () => undefined,
    );
    return result;
  }

  private pendingScope() {
    return { scopeKind: "instance" as const, namespace: STATE_NAMESPACE, stateKey: "pending" };
  }

  private markerScope(companyId: string, key: string) {
    return { scopeKind: "company" as const, scopeId: companyId, namespace: STATE_NAMESPACE, stateKey: `woken:${key}` };
  }

  private missedScope() {
    return { scopeKind: "instance" as const, namespace: STATE_NAMESPACE, stateKey: "missed" };
  }

  private async loadMissed(): Promise<PendingItem[]> {
    const raw = (await this.ctx.state.get(this.missedScope())) as PendingState | null | undefined;
    return raw && raw.v === 1 && Array.isArray(raw.items) ? raw.items : [];
  }

  private async saveMissed(items: PendingItem[]): Promise<void> {
    await this.ctx.state.set(this.missedScope(), { v: 1, items } satisfies PendingState);
  }

  /**
   * Record items whose last wake attempt failed with no fallback. They stay in
   * a durable list until a later wake for their company carries them.
   */
  private async recordMissed(items: PendingItem[], retryAt?: number): Promise<void> {
    const missed = await this.loadMissed();
    const now = this.options.now();
    for (const item of items) {
      if (missed.some((entry) => entry.companyId === item.companyId && entry.key === item.key)) continue;
      if (typeof retryAt === "number") {
        // Held, not failed (daily cap): no failed round is counted.
        missed.push({ ...item, retryAt });
        continue;
      }
      // Back off: each failed round doubles the wait before the next one.
      const rounds = (item.rounds ?? 0) + 1;
      const wait = Math.min(MISSED_RETRY_BASE_MS * 2 ** (rounds - 1), MISSED_RETRY_MAX_MS);
      missed.push({ ...item, rounds, retryAt: now + wait });
    }
    const overflow = Math.max(0, missed.length - MAX_MISSED_ITEMS);
    if (overflow > 0) {
      this.ctx.logger.warn("decision triage: missed-item list is full; oldest items dropped", { outcome: "missed_overflow", items: overflow });
    }
    await this.saveMissed(missed.slice(overflow));
  }

  /**
   * Move missed items (all companies, or one) back into the pending queue,
   * due with `dueAt` (or now). Items already woken, or already pending, are
   * skipped. The missed list keeps only items that were not moved.
   */
  private async requeueMissed(pending: PendingItem[], missed: PendingItem[], only: { companyId: string; dueAt: number } | null): Promise<PendingItem[]> {
    const left: PendingItem[] = [];
    let moved = 0;
    const now = this.options.now();
    for (const item of missed) {
      if (only && item.companyId !== only.companyId) {
        left.push(item);
        continue;
      }
      // Still backing off from its last failed round.
      if (typeof item.retryAt === "number" && item.retryAt > now) {
        left.push(item);
        continue;
      }
      if (pending.length >= MAX_PENDING_ITEMS) {
        left.push(item);
        continue;
      }
      const marker = (await this.ctx.state.get(this.markerScope(item.companyId, item.key))) as WokenMarker | null | undefined;
      if (markerSuppresses(marker, item)) continue;
      if (pending.some((entry) => entry.companyId === item.companyId && entry.key === item.key)) continue;
      pending.push({ ...item, attempts: 0, retryAt: undefined, dueAt: only?.dueAt ?? now });
      moved += 1;
    }
    if (left.length !== missed.length) await this.saveMissed(left);
    if (moved > 0) this.ctx.logger.info("decision triage: missed items queued again", { outcome: "missed_requeued", items: moved });
    return pending;
  }

  /** Sweep step: queue again the company's missed items whose back-off has passed. */
  private requeueDueMissed(companyId: string): Promise<void> {
    return this.exclusive(async () => {
      const missed = await this.loadMissed();
      if (!missed.some((entry) => entry.companyId === companyId && (entry.retryAt ?? 0) <= this.options.now())) return;
      const pending = await this.requeueMissed(await this.loadPending(), missed, { companyId, dueAt: this.options.now() });
      await this.savePending(pending);
      this.scheduleFrom(pending);
    });
  }

  private capScope(companyId: string, day: string) {
    return { scopeKind: "company" as const, scopeId: companyId, namespace: STATE_NAMESPACE, stateKey: `cap:${day}` };
  }

  private async loadPending(): Promise<PendingItem[]> {
    const raw = (await this.ctx.state.get(this.pendingScope())) as PendingState | null | undefined;
    return raw && raw.v === 1 && Array.isArray(raw.items) ? raw.items : [];
  }

  private async savePending(items: PendingItem[]): Promise<void> {
    await this.ctx.state.set(this.pendingScope(), { v: 1, items } satisfies PendingState);
  }

  async loadCap(companyId: string, day: string): Promise<CapState> {
    const raw = (await this.ctx.state.get(this.capScope(companyId, day))) as CapState | null | undefined;
    return raw && raw.v === 1 ? raw : { v: 1, wakes: 0, suppressed: 0, investigationIssueId: null };
  }

  private enqueue(item: PendingItem, config: TriageConfig): Promise<TriageOutcome> {
    return this.exclusive(async (): Promise<TriageOutcome> => {
      const scope = this.markerScope(item.companyId, item.key);
      const marker = (await this.ctx.state.get(scope)) as WokenMarker | null | undefined;
      if (markerSuppresses(marker, item)) {
        await this.markers.touch({ companyId: item.companyId, stateKey: scope.stateKey }, false);
        return "duplicate";
      }
      // The same episode back within the cooldown: reopen it, keep its routing issue, no new wake.
      if (marker && reenteredWithinCooldown(marker, item, this.options.now())) {
        await this.ctx.state.set(scope, { ...marker, open: true } satisfies WokenMarker);
        await this.markers.touch({ companyId: item.companyId, stateKey: scope.stateKey }, true);
        this.ctx.logger.debug("decision triage: episode re-entered within cooldown", { kind: item.kind, outcome: "episode_reopened" });
        return "duplicate";
      }
      const pending = await this.loadPending();
      if (pending.some((entry) => entry.companyId === item.companyId && entry.key === item.key)) return "duplicate";
      // An item whose routing failed waits for its back-off; a new event or sweep does not repeat it.
      const missedNow = await this.loadMissed();
      if (missedNow.some((entry) => entry.companyId === item.companyId && entry.key === item.key)) return "duplicate";
      if (pending.length >= MAX_PENDING_ITEMS) {
        this.ctx.logger.warn("decision triage: pending queue is full; item not queued", { kind: item.kind, outcome: "queue_full" });
        return "error";
      }
      // A burst of items for one company shares the first item's flush time.
      const batchDue = pending.find((entry) => entry.companyId === item.companyId && entry.attempts === 0)?.dueAt;
      item.dueAt = batchDue ?? this.options.now() + config.debounceSeconds * 1000;
      pending.push(item);
      // Items whose wake failed earlier (and whose back-off has passed) ride along with this new item's wake.
      if (missedNow.some((entry) => entry.companyId === item.companyId)) {
        await this.requeueMissed(pending, missedNow, { companyId: item.companyId, dueAt: item.dueAt });
      }
      await this.savePending(pending);
      this.scheduleFrom(pending);
      return "queued";
    });
  }

  private closeEpisode(companyId: string, key: string): Promise<TriageOutcome> {
    return this.exclusive(async (): Promise<TriageOutcome> => {
      const scope = this.markerScope(companyId, key);
      const marker = (await this.ctx.state.get(scope)) as WokenMarker | null | undefined;
      if (marker && marker.open !== false) {
        await this.ctx.state.set(scope, { ...marker, open: false });
        await this.markers.touch({ companyId, stateKey: scope.stateKey }, true);
      }
      const missed = await this.loadMissed();
      const missedKept = missed.filter((entry) => !(entry.companyId === companyId && entry.key === key));
      if (missedKept.length !== missed.length) await this.saveMissed(missedKept);
      const pending = await this.loadPending();
      const kept = pending.filter((entry) => !(entry.companyId === companyId && entry.key === key));
      if (kept.length !== pending.length) {
        await this.savePending(kept);
        this.scheduleFrom(kept);
      }
      return "episode_closed";
    });
  }

  private scheduleFrom(pending: PendingItem[]): void {
    if (pending.length === 0) {
      this.stop();
      return;
    }
    const due = Math.min(...pending.map((entry) => entry.dueAt));
    if (this.timer !== null && this.timerDueAt !== null && this.timerDueAt <= due) return;
    if (this.timer !== null) this.options.clearTimer(this.timer);
    this.timerDueAt = due;
    this.timer = this.options.setTimer(() => {
      this.timer = null;
      this.timerDueAt = null;
      detached(() => {
        void this.flushDue().catch((error) => {
          this.ctx.logger.warn("decision triage: flush failed", { errorName: error instanceof Error ? error.name : typeof error });
        });
      });
    }, Math.max(0, due - this.options.now()));
  }

  // ---- flush -------------------------------------------------------------

  /** Wake for every due item. Exposed for tests; normally run by the timer. */
  flushDue(): Promise<FlushOutcome[]> {
    return this.exclusive(async () => {
      const outcomes: FlushOutcome[] = [];
      let pending = await this.loadPending();
      for (;;) {
        const now = this.options.now();
        const due = pending.filter((entry) => entry.dueAt <= now);
        if (due.length === 0) break;
        const companyId = due[0].companyId;
        const batch = due.filter((entry) => entry.companyId === companyId).slice(0, MAX_ITEMS_PER_WAKE);
        const { outcome, retry } = await this.flushBatch(companyId, batch, now);
        outcomes.push(outcome);
        const batchKeys = new Set(batch.map((entry) => entry.key));
        pending = pending.filter((entry) => !(entry.companyId === companyId && batchKeys.has(entry.key)));
        pending.push(...retry);
        await this.savePending(pending);
      }
      // Clear any armed timer before re-arming (this run may not be the timer's).
      this.stop();
      this.scheduleFrom(pending);
      return outcomes;
    });
  }

  private async flushBatch(
    companyId: string,
    batch: PendingItem[],
    now: number,
  ): Promise<{ outcome: FlushOutcome; retry: PendingItem[] }> {
    const config = await this.loadConfig(companyId).catch(() => null);
    if (!config || !config.enabled) {
      // Kill switch (or removed config): no wake, no issue.
      return { outcome: { companyId, items: batch.length, result: "dropped" }, retry: [] };
    }
    // The host refuses to invoke a paused, terminated or pending-approval agent, and a
    // routing issue assigned to it is blocked. Hold the batch: no issue, wake, comment or cap count.
    if (await this.triageAgentUnavailable(config, companyId)) {
      this.ctx.logger.info("decision triage: triage agent cannot be invoked; items held", { outcome: "agent_unavailable", items: batch.length });
      return {
        outcome: { companyId, items: batch.length, result: "retry" },
        retry: batch.map((entry) => ({ ...entry, dueAt: now + AGENT_UNAVAILABLE_RECHECK_MS })),
      };
    }
    const day = utcDay(now);
    const cap = await this.loadCap(companyId, day);
    if (cap.wakes >= config.maxWakesPerDay) {
      cap.suppressed += batch.length;
      await this.ctx.state.set(this.capScope(companyId, day), cap);
      await this.markers.touch({ companyId, stateKey: `cap:${day}` }, false);
      await this.ensureInvestigation(companyId, day, cap, config);
      // Kept, not dropped: the sweep queues the items again from 00:00 UTC.
      await this.recordMissed(batch, nextUtcMidnight(now)).catch((error) => {
        this.ctx.logger.warn("decision triage: capped items not recorded", {
          outcome: "capped_unrecorded",
          items: batch.length,
          errorName: error instanceof Error ? error.name : typeof error,
        });
      });
      this.ctx.logger.warn("decision triage: daily wake cap reached; items not woken", { outcome: "capped", items: batch.length });
      return { outcome: { companyId, items: batch.length, result: "capped" }, retry: [] };
    }

    // Route first: each `route` item gets its routing issue assigned to the triage agent.
    const routed = new Map<string, RouteRef>();
    const unrouted: PendingItem[] = [];
    for (const entry of batch) {
      if (dispositionOf(entry) !== "route") continue;
      const ref = await this.ensureRoutingIssue(companyId, entry, config).catch(() => null);
      if (ref) routed.set(entry.key, ref);
      else unrouted.push(entry);
    }
    const wakeBatch = batch.filter((entry) => !unrouted.includes(entry));
    if (wakeBatch.length === 0) {
      return { outcome: { companyId, items: batch.length, result: "retry" }, retry: await this.failRouting(unrouted, now) };
    }
    const text = buildWakeText(await this.wakeLines(companyId, wakeBatch, config, routed));
    const wake = await this.wake(config, companyId, text, `${day}:${wakeBatch[0].key}`);
    const routeRetry = unrouted.length > 0 ? await this.failRouting(unrouted, now) : [];
    if (wake.ok) {
      cap.wakes += 1;
      await this.ctx.state.set(this.capScope(companyId, day), cap);
      await this.markers.touch({ companyId, stateKey: `cap:${day}` }, false);
      const at = new Date(now).toISOString();
      for (const entry of wakeBatch) {
        const base: WokenMarker =
          entry.mode === "episode"
            ? { v: 1, at, open: true }
            : (entry.kind === "recovery" || entry.kind === "interaction") && entry.issueId
              ? { v: 1, at, issueId: entry.issueId }
              : { v: 1, at };
        const routeIssueId = routed.get(entry.key)?.id;
        const marker: WokenMarker = routeIssueId ? { ...base, routeIssueId } : base;
        const scope = this.markerScope(companyId, entry.key);
        await this.ctx.state.set(scope, marker);
        await this.markers.touch({ companyId, stateKey: scope.stateKey }, true);
      }
      this.ctx.logger.info("decision triage: triage agent woken", { route: wake.route, items: wakeBatch.length, routed: routed.size, runId: wake.runId });
      return {
        outcome: { companyId, items: wakeBatch.length, result: wake.route === "invoke" ? "woken" : "fallback", runId: wake.runId },
        retry: routeRetry,
      };
    }
    const retry = [...routeRetry, ...(await this.failRouting(wakeBatch, now))];
    this.ctx.logger.warn("decision triage: wake failed", {
      outcome: retry.length > 0 ? "retry" : "failed",
      items: batch.length,
    });
    return { outcome: { companyId, items: batch.length, result: retry.length > 0 ? "retry" : "failed" }, retry };
  }

  /**
   * True only when the triage agent is known not to be invokable: not found, or
   * paused, terminated or pending approval. A failed read (for example the
   * `agents.read` capability not granted) returns false, so triage carries on.
   */
  private async triageAgentUnavailable(config: TriageConfig, companyId: string): Promise<boolean> {
    let agent: { status?: string | null } | null;
    try {
      agent = (await this.ctx.agents.get(config.triageAgentId, companyId)) as { status?: string | null } | null;
    } catch {
      return false;
    }
    return !agent || NON_INVOKABLE_AGENT_STATUSES.has(String(agent.status));
  }

  /**
   * One failed attempt for each item: retried after `retryDelayMs` up to
   * `MAX_WAKE_ATTEMPTS`, then kept in the durable missed list with back-off.
   */
  private async failRouting(batch: PendingItem[], now: number): Promise<PendingItem[]> {
    const next = batch.map((entry) => ({ ...entry, attempts: entry.attempts + 1, dueAt: now + this.options.retryDelayMs }));
    const retry = next.filter((entry) => entry.attempts < MAX_WAKE_ATTEMPTS);
    const exhausted = next.filter((entry) => entry.attempts >= MAX_WAKE_ATTEMPTS);
    if (exhausted.length > 0) {
      await this.recordMissed(exhausted).catch((error) => {
        this.ctx.logger.warn("decision triage: items not woken and not recorded", {
          outcome: "missed_unrecorded",
          items: exhausted.length,
          errorName: error instanceof Error ? error.name : typeof error,
        });
      });
    }
    if (exhausted.length > 0) {
      // Items kept in the durable missed list; retried after their back-off.
      this.ctx.logger.warn("decision triage: items not routed; backing off", { outcome: "missed", items: exhausted.length });
    }
    return retry;
  }

  /**
   * The routing issue of one item: assigned to the triage agent, so the triage
   * agent is the item's responder of record. It names the item (kind, id,
   * bounded detail) and its source issue by validated ids only. Idempotent:
   * an existing one is found by origin before a new one is created. The source
   * issue is never written to and never becomes the routing issue's parent
   * (a child would change the source's own recovery path).
   */
  private async ensureRoutingIssue(companyId: string, entry: PendingItem, config: TriageConfig): Promise<RouteRef> {
    const originId = routeOriginId(entry);
    const existing = await this.ctx.issues.list({ companyId, originKind: ROUTE_ORIGIN_KIND, originId, limit: 5 });
    // A cancelled or done routing issue (closed as stale, or finished) is not reused: a returning item gets a new one.
    const found = existing.find((issue) => issue.originId === originId && issue.status !== "cancelled" && issue.status !== "done");
    if (found) return { id: found.id, identifier: found.identifier ?? null };
    const company = await this.ctx.companies.get(companyId).catch(() => null);
    const source = entry.issueId
      ? ((await this.ctx.issues.get(entry.issueId, companyId).catch(() => null)) as { identifier?: string | null; title?: string | null } | null)
      : null;
    const sourceIdentifier = isSafeIdentifier(source?.identifier) ? source.identifier : null;
    const link = buildBoardLink(config.paperclipBaseUrl, {
      issuePrefix: company?.issuePrefix ?? null,
      issueIdentifier: source?.identifier ?? null,
      issueId: entry.issueId,
      approvalId: entry.approvalId,
      decisionId: entry.decisionId,
    });
    const title = safeTitle(source?.title);
    const created = await this.ctx.issues.create({
      companyId,
      projectId: config.investigationProjectId ?? undefined,
      assigneeAgentId: config.triageAgentId,
      title: `Decision triage: ${entry.kind} ${sourceIdentifier ?? entry.itemId}`,
      description: buildRoutingDescription({
        kind: entry.kind,
        itemId: entry.itemId,
        detail: entry.detail ?? null,
        sourceIssueId: entry.issueId,
        sourceIdentifier,
        title,
        raisedBy: entry.raisedBy,
        link,
        key: entry.key,
      }),
      status: "todo",
      priority: "high",
      originKind: ROUTE_ORIGIN_KIND,
      originId,
    });
    return { id: created.id, identifier: created.identifier ?? null };
  }

  private async wakeLines(companyId: string, batch: PendingItem[], config: TriageConfig, routed: Map<string, RouteRef> = new Map()): Promise<WakeLine[]> {
    const company = await this.ctx.companies.get(companyId).catch(() => null);
    const lines: WakeLine[] = [];
    for (const entry of batch) {
      const issue = entry.issueId
        ? ((await this.ctx.issues.get(entry.issueId, companyId).catch(() => null)) as { identifier?: string | null; title?: string | null } | null)
        : null;
      const gate = entry.kind === "recovery" && entry.issueId ? await this.humanGate(companyId, entry.issueId) : null;
      lines.push({
        kind: entry.kind,
        itemId: entry.itemId,
        issueIdentifier: issue?.identifier ?? null,
        title: safeTitle(issue?.title),
        raisedBy: entry.raisedBy,
        link: buildBoardLink(config.paperclipBaseUrl, {
          issuePrefix: company?.issuePrefix ?? null,
          issueIdentifier: issue?.identifier ?? null,
          issueId: entry.issueId,
          approvalId: entry.approvalId,
          decisionId: entry.decisionId,
        }),
        gate,
        disposition: dispositionOf(entry),
        detail: entry.detail ?? null,
        sourceIssueId: entry.issueId,
        routeIssue: routed.get(entry.key) ?? null,
      });
    }
    return lines;
  }

  /**
   * `human` when a card on the issue waits for a person. Such a gate stays
   * with that person; the wake only reports it. An unreadable card list is
   * reported as a gate, so a failed read never hides one.
   */
  private async humanGate(companyId: string, issueId: string): Promise<"human" | null> {
    const cards = await this.ctx.issues.listInteractions(issueId, companyId).catch(() => null);
    if (!cards) return "human";
    const waiting = cards.some((card) => {
      const entry = card as { status?: unknown; addresseeAgentId?: unknown };
      return interactionRouting({ interactionStatus: entry.status, addresseeAgentId: entry.addresseeAgentId ?? null }) === "human";
    });
    return waiting ? "human" : null;
  }

  /**
   * Primary route: `ctx.agents.invoke` (capability `agents.invoke`). The host
   * calls `heartbeat.wakeup` for the agent and returns the run id, or throws
   * when no run is queued. Fallback, only when that throws and a standing
   * triage issue is configured: a comment on that issue (durable record of the
   * items) plus `ctx.issues.requestWakeup` on it, which wakes its assignee.
   * A plain plugin comment alone does not wake an assignee on this host.
   */
  private async wake(
    config: TriageConfig,
    companyId: string,
    text: string,
    idempotencyKey: string,
  ): Promise<{ ok: true; route: "invoke" | "fallback" | "comment_only"; runId: string | null } | { ok: false }> {
    try {
      const { runId } = await this.ctx.agents.invoke(config.triageAgentId, companyId, { prompt: text, reason: "decision_triage" });
      return { ok: true, route: "invoke", runId };
    } catch {
      // fall through to the standing issue
    }
    if (!config.triageIssueId) return { ok: false };
    let commented = false;
    try {
      await this.ctx.issues.createComment(config.triageIssueId, text, companyId);
      commented = true;
    } catch {
      // try the wake anyway
    }
    try {
      const result = await this.ctx.issues.requestWakeup(config.triageIssueId, companyId, {
        reason: "decision_triage",
        idempotencyKey: `decision-triage:${idempotencyKey}`.slice(0, 200),
      });
      if (commented && result.queued) return { ok: true, route: "fallback", runId: result.runId };
    } catch {
      // reported below
    }
    // The items are recorded on the standing issue; the agent sees them on its next run.
    return commented ? { ok: true, route: "comment_only", runId: null } : { ok: false };
  }

  /**
   * Exactly one investigation issue per company and UTC day. Idempotent across
   * restarts: the issue carries `originKind`/`originId`, and an existing one is
   * found by that origin before a new one is created.
   */
  private async ensureInvestigation(companyId: string, day: string, cap: CapState, config: TriageConfig): Promise<void> {
    if (cap.investigationIssueId) return;
    const originId = `daily-cap:${day}`;
    try {
      const existing = await this.ctx.issues.list({ companyId, originKind: CAP_ORIGIN_KIND, originId, limit: 5 });
      let issueId = existing.find((issue) => issue.originId === originId)?.id ?? null;
      if (!issueId) {
        const created = await this.ctx.issues.create({
          companyId,
          projectId: config.investigationProjectId ?? undefined,
          assigneeAgentId: config.investigationAssigneeAgentId,
          title: `Decision triage: daily wake cap reached (${day} UTC)`,
          description: [
            `The decision-triage plugin reached its daily wake cap on ${day} (UTC).`,
            "",
            `- Wakes sent today: ${cap.wakes}`,
            `- Cap (maxWakesPerDay): ${config.maxWakesPerDay}`,
            `- Items not woken so far today: ${cap.suppressed}`,
            "",
            "No further triage wakes are sent until 00:00 UTC. Items that were not woken are kept and queued again from 00:00 UTC.",
            "Find why so many decision items appeared (a loop, a flood of cards, or a cap set too low) and fix the cause.",
          ].join("\n"),
          status: "todo",
          priority: "high",
          originKind: CAP_ORIGIN_KIND,
          originId,
        });
        issueId = created.id;
      }
      cap.investigationIssueId = issueId;
      await this.ctx.state.set(this.capScope(companyId, day), cap);
    } catch (error) {
      // Retried on the next suppressed batch.
      this.ctx.logger.warn("decision triage: could not create the investigation issue", {
        errorName: error instanceof Error ? error.name : typeof error,
      });
    }
  }
}

/** The next 00:00 UTC strictly after `ms`. */
export function nextUtcMidnight(ms: number): number {
  const d = new Date(ms);
  return Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate() + 1);
}

export function utcDay(ms: number): string {
  return new Date(ms).toISOString().slice(0, 10);
}

function itemIdOf(candidate: DecisionCandidate): string {
  switch (candidate.kind) {
    case "approval":
      return candidate.approvalId;
    case "interaction":
      return candidate.interactionId;
    case "decision":
      return candidate.decisionId;
    case "recovery":
      return candidate.recoveryActionId;
    default:
      return candidate.issueId;
  }
}

interface SweepIssue extends IssueBlockerView {
  id: string;
}

/** Dedupe identity of one recovery action: routed at most once, ever. */
export function recoveryKey(recoveryActionId: string): string {
  return `recovery:${recoveryActionId.toLowerCase()}`;
}

function episodeStamp(at: string | Date | null | undefined): string {
  if (at instanceof Date) return at.toISOString();
  return typeof at === "string" && !Number.isNaN(Date.parse(at)) ? new Date(Date.parse(at)).toISOString() : "unknown";
}

function feedOrderKey(event: PluginEvent): string | null {
  if ((event.eventType as string) !== BLOCKER_ATTENTION_CHANGED) return null;
  const payload = event.payload as { dedupKey?: unknown } | null | undefined;
  const dedupKey = payload && typeof payload === "object" ? payload.dedupKey : undefined;
  if (typeof dedupKey !== "string" || dedupKey.length === 0) return null;
  return `${event.companyId}\u0000${dedupKey}`;
}

interface RouteRef {
  id: string;
  identifier: string | null;
}

interface OwnView {
  assigneeAgentId?: string | null;
  originKind?: string | null;
}

/** An issue this plugin created (routing, daily cap): never routed itself. */
function isOwnIssue(issue: OwnView | null | undefined): boolean {
  return typeof issue?.originKind === "string" && issue.originKind.startsWith(OWN_ORIGIN_PREFIX);
}

/** The triage agent already holds the issue (its own escalation, or one it took): no routing, no wake. */
function ownedByTriage(issue: OwnView | null | undefined, config: TriageConfig): boolean {
  if (isOwnIssue(issue)) return true;
  const assignee = issue?.assigneeAgentId;
  return typeof assignee === "string" && assignee.toLowerCase() === config.triageAgentId.toLowerCase();
}

function dispositionOf(entry: PendingItem): "route" | "report" {
  return entry.disposition ?? (entry.kind === "approval" ? "report" : "route");
}

/**
 * Whether a `woken:` marker means the item was already handled at this state.
 * An episode marker closed by its exit event does not count. A marker without
 * `routeIssueId` was written by 0.2.0 (notify only): it does not hold back a
 * `route` item, which still needs its routing issue and one correlated wake.
 * The new marker then carries `routeIssueId`, so this happens once per item.
 */
function markerSuppresses(marker: WokenMarker | null | undefined, item: PendingItem): boolean {
  if (!marker) return false;
  if (item.mode !== "once" && marker.open === false) return false;
  if (dispositionOf(item) === "route" && !marker.routeIssueId) return false;
  return true;
}

/**
 * An episode item whose closed marker was routed and woken less than
 * `EPISODE_REENTRY_COOLDOWN_MS` ago. A marker with an unreadable time is not.
 */
function reenteredWithinCooldown(marker: WokenMarker, item: PendingItem, now: number): boolean {
  if (item.mode !== "episode" || marker.open !== false || !marker.routeIssueId) return false;
  const at = Date.parse(marker.at);
  if (Number.isNaN(at)) return false;
  return now - at < EPISODE_REENTRY_COOLDOWN_MS;
}

/** Dedupe identity of one review hand-off: an issue and the reason it waits on a person. */
export function reviewKey(issueId: string, reason: string): string {
  return `review:${issueId}:${reason}`;
}

/** Routing issue origin: the item key, plus the episode start for an episode item. */
export function routeOriginId(entry: Pick<PendingItem, "key" | "mode" | "episodeAt">): string {
  const id = entry.mode === "episode" && entry.episodeAt ? `${entry.key}@${entry.episodeAt}` : entry.key;
  return id.slice(0, 255);
}

function sweptItem(companyId: string, key: string, kind: PendingItem["kind"], issueId: string, detail: string | null, mode: PendingItem["mode"] = "once"): PendingItem {
  return {
    companyId,
    key,
    mode,
    kind,
    itemId: issueId,
    issueId,
    approvalId: null,
    decisionId: null,
    raisedBy: raisedByLabel({ type: "system" }),
    dueAt: 0,
    attempts: 0,
    disposition: "route",
    detail,
    episodeAt: null,
  };
}

interface BlockedSweepView extends SweepIssue, OwnView {
  blockerAttention?: {
    state?: unknown;
    blockingTreeLive?: unknown;
    terminalBlockerIssueId?: unknown;
    terminalBlocker?: { id?: unknown } | null;
  } | null;
}

/**
 * Board items a blocked issue puts on the feed, from the listed issue alone:
 * a human-owned unblock descriptor (one item per blocked episode) and a
 * non-live blocker tree (one episode per terminal blocker). A terminal
 * blocker the plugin cannot read (private) is skipped, never guessed.
 */
function blockedItems(companyId: string, issue: BlockedSweepView, config: TriageConfig, now: number): PendingItem[] {
  const items: PendingItem[] = [];
  if (isHumanOwnedBlocker(issue) && !ownedByTriage(issue, config)) {
    items.push(sweptItem(companyId, blockerDecisionKey(issue.id, issue), "blocker", issue.id, "unblock_owner"));
  }
  const attention = issue.blockerAttention;
  if (attention && (attention.state === "stalled" || attention.state === "needs_attention") && attention.blockingTreeLive === false) {
    const visibleTerminal = typeof attention.terminalBlocker?.id === "string" ? attention.terminalBlocker.id : null;
    const declared = typeof attention.terminalBlockerIssueId === "string" ? attention.terminalBlockerIssueId : null;
    const terminal = visibleTerminal ?? (declared === null || declared === issue.id ? issue.id : null);
    if (terminal) {
      const item = sweptItem(companyId, blockerTreeEpisodeKey(`blocker:${terminal}`), "blocker_tree", terminal, "blocker_tree", "episode");
      item.episodeAt = new Date(now).toISOString();
      items.push(item);
    }
  }
  return items;
}

interface RouteView {
  id: string;
  originKind?: string | null;
  originId?: string | null;
  assigneeAgentId?: string | null;
  checkoutRunId?: string | null;
  executionRunId?: string | null;
}
