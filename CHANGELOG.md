# Changelog

## 0.3.4

Paused-agent and daily-cap fixes. While the triage agent was paused, each
batch still made routing issues (which the host then blocked: "assignee is
not invokable"), fell back to a comment plus `requestWakeup` that started no
run, and counted against the daily cap. Items held by the cap were dropped;
a card or decision never came back.

- **New capability `agents.read`** (read-only). Used only for
  `ctx.agents.get(triageAgentId)` once per batch.
- **No routing or wake while the triage agent cannot be invoked.** After the
  kill-switch check and before the cap check, a batch whose triage agent is
  not found or is `paused`, `terminated` or `pending_approval` creates no
  routing issue, sends no wake and posts no comment. The cap and the items'
  attempts are unchanged; the batch is checked again after
  `AGENT_UNAVAILABLE_RECHECK_MS` (5 min). Log line `outcome: agent_unavailable`
  with an item count. If `agents.get` throws (for example the capability is
  not granted), routing and the wake go ahead as in 0.3.3.
- **Capped items are kept.** A batch held by the daily cap still adds to the
  suppressed count, ensures the day's investigation issue and logs `capped`.
  Its items now also go into the durable missed list with `retryAt` = the next
  00:00 UTC, without counting a failed round and without storing an item
  twice. The first sweep after midnight queues them again. The investigation
  issue text says so.
- No change to the cap value, approval and reserved-card reporting, routing
  rules, the 0.3.3 owner guard and cooldown, event subscriptions, the
  `wake()` fallback, config schema or state keys.

## 0.3.3

Self-routing loop fix. The daily wake cap could be used up by a loop, not by
real decision items: routing issues targeted the plugin's own routing issues
or issues the triage agent already held, and blocker episodes re-entered the
feed minutes after they had been woken.

- **Owner guard on the blocker-tree terminal.** A `blocker_tree` item whose
  terminal blocker is readable and held by the triage agent (a plugin issue by
  `originKind`, or assigned to the triage agent) is not routed and wakes
  nobody. This applies on the event path (checked before the human-owned
  branch) and in the sweep (the terminal is checked, not only the listed
  blocked issue; a terminal other than the listed issue is read with
  `issues.get`). The exit event still closes the episode. An unreadable or
  private terminal is still routed as an episode, and a human-owned terminal
  the triage agent does not hold still routes `unblock_owner`.
- **Episode re-entry cooldown.** `EPISODE_REENTRY_COOLDOWN_MS` = 2 h. An
  episode that enters the feed again less than 2 h after its last wake, and
  whose closed marker names a routing issue, has its marker reopened (same
  `at` and `routeIssueId`) and counts as a duplicate: no new routing issue and
  no new wake. After 2 h a re-entry is a new episode, as before. A stale
  routing issue cancelled by the sweep still deletes the marker, so an item
  that comes back after that is routed normally.
- No change to the cap value or cap logic, approval and reserved-card
  reporting, recovery routing, event subscriptions, capabilities, config
  schema or state keys.

## 0.3.2

Scheduled-sweep company scope fix. On a host with this behaviour the
recovery catch-up sweep, which runs from a worker timer outside any host
invocation, failed `companies.list` with "the worker referenced a missing,
expired, or unknown invocation scope" whenever an event invocation of the
worker was open, so it swept nothing.

- The worker keeps a set of configured company ids, learned from the SDK
  `onConfigChanged` hook, which the host replays for every stored config right
  after the worker starts and sends on every save (company id UUID-checked; an
  empty config forgets the company). `start()` does not probe the company
  list, so the worker never asks for the config of an unconfigured company. The sweep iterates that set; the unscoped
  `companies.list` is only a fallback when the set is empty. Every host call
  in the sweep names its company, which the host admits proactively for
  configured companies only.
- Timer callbacks (the recovery sweep and the debounced flush) run through
  `detached()`, an `AsyncLocalStorage.snapshot()` taken at module load, so
  they never inherit the invocation of the event or `onConfigChanged` call
  that armed them. The SDK stamps each host call with the invocation in
  scope, and the host refuses calls stamped with an ended one.
- A failed or empty enumeration logs a warn with `outcome:
  company_list_failed | no_companies` (no ids). Every sweep logs
  `decision triage: sweep finished` at info with counts only (`source`,
  `candidates`, `companies`, `disabled`, `noConfig`, `issues`, `queued`, ...).
- Because the worker now implements `onConfigChanged`, the host calls the
  hook on a config save instead of restarting the worker. The kill switch is
  read at each event and sweep, so it still applies from the next one.
- No capability, config schema, state key/format or dedupe change.

## 0.3.1

Manifest-only patch. The manifest `description` is shortened to fit the
host's 500-character limit (0.3.0's was 513 characters and the host's
manifest validator refused it at install). Same meaning, plain text. No
behaviour, capability, config, state or dedupe change.

## 0.3.0

Routes every board- or user-owned recovery and attention item to the triage
agent, and makes the triage agent its responder of record.
**One new capability: `issues.update`**, used only to close the plugin's own
routing issues (see below).

- **No kind allowlist for recoveries.** Any board- or user-owned recovery
  action is routed, whatever its kind, cause or `routingPolicy` (including
  `deliberate_wait_without_target`, review-path recoveries and kinds the
  plugin does not know). The event only needs to show the issue as blocked.
- **New class: reviews.** An in-review issue held by a person (user assignee,
  or a user as the current native stage participant) or whose
  `reviewAttention.state` is `stalled`, by `issue.updated` and by the sweep.
  New trigger `triggers.reviews` (default on). The review stage itself is
  never touched.
- **Routing, not only a wake.** Each routed item gets one routing issue,
  assigned to the triage agent (`originKind`
  `plugin:paperclip.decision-triage:route`, `originId` = the item key), in
  `investigationProjectId`. It names the item kind, id, class and source issue
  by validated ids only. An existing one is found by origin before a new one
  is made, so a restart never makes a second. It is never a child of the
  source issue. The wake line now carries `class`, `source issue id` and
  `route: yours, routing issue <id>`.
- **Reported, never routed:** pending approvals; human-addressed cards whose
  structured fields show a reserved choice (`connection_intent`, a
  tool-gateway action, a secret proposal, a `human_only`/`board_only`
  resolver policy, or a card a person raised); and cards whose fields cannot
  be read. These lines say `report only`. Titles and bodies are never used to
  decide. Agent-addressed cards stay ignored.
- **Wider catch-up sweep** (same worker timer, every 5 minutes and 30 s after
  start): blocked issues (recovery notices of any kind, human-owned unblock
  descriptors, non-live blocker trees with a readable terminal) and in-review
  issues. The first sweep routes the items that already exist.
- **No loops.** Issues the triage agent holds (assignee) and the plugin's own
  issues are never routed.
- **Stale routing issues are closed.** Each sweep re-checks the plugin's own
  routing issues that are still `todo`, assigned to the triage agent and not
  started (no checkout or execution run). If the source item left the board
  or changed state (recovery no longer open, block no longer on a person,
  review no longer held by a person, tree episode closed, card no longer
  pending), it gets a short comment and is set to `cancelled`. A source the
  plugin cannot read, and board decisions, are left for the triage agent.
- **Per-sweep cap.** One sweep queues at most 100 new items per company
  (`MAX_SWEEP_QUEUED`); the rest come on the next sweep. Routing issues are
  only made at flush time, after the kill switch and the daily wake cap.
- **Legacy 0.2.0 markers.** A `woken:` marker without `routeIssueId` (written
  by 0.2.0, notify only) no longer holds back a `route` item, in the event
  path and the missed-item re-queue: a still-live item 0.2.0 woke for gets
  one routing issue and one additional wake, once. Report-only items keep
  being held back.
- **A returning item is routed again.** Cancelling a stale routing issue also
  deletes the item's `woken:` marker and its marker-index entry. A cancelled
  or done routing issue is never reused, so an item that comes back to the
  board gets a new routing issue and one new wake.
- **Back-off.** An item whose routing failed on every attempt waits
  5 min × 2^(round−1) (at most 6 h) in the missed list, across restarts,
  before it is tried again. A sweep or event inside the back-off does not
  repeat it.

## 0.2.0

Routes board- and user-owned recovery actions (`board_escalation_no_takeover_v1`)
to the triage agent. Includes 0.1.1.

- New item kind `recovery`, one wake per recovery action (`recovery:<id>`),
  deduplicated, debounced and capped like every other item. Not replayed
  after a restart; the marker is kept while the recovery is still open.
- Event path: a system `issue.updated` that moves an issue into `blocked` and
  names a board- or user-owned recovery action (host recovery events).
- Catch-up sweep in the worker (every 5 minutes, and 30 s after start): reads
  the host's recovery notice comment on blocked issues to find actions whose
  event was missed.
- Both paths route only a recovery that is still open: the issue is blocked
  and no agent has taken it through its unblock descriptor.
- A card on the issue waiting for a person is marked `gate: human` in the
  wake. The plugin never answers cards or writes to the source issue.
- New trigger `triggers.recoveries` (default on).
- **New capability `issue.comments.read`** (the sweep). On hosts that refuse
  a capability-adding upgrade, install 0.2.0 by soft uninstall + install.

## 0.1.1

Hardening release. No new capability, setting or trigger.

- Items whose wake failed `MAX_WAKE_ATTEMPTS` times with no fallback route
  are kept in a durable `missed` list (at most 500) instead of being dropped.
  The next wake for the same company, or the next worker start, carries them.
  A feed item that leaves the board is removed from the list.
- A flush that runs outside the debounce timer clears the armed timer before
  arming a new one.
- `woken:` markers and the daily `cap:` records are pruned once they have not
  been touched for 30 days. A marker is touched on every wake and on every
  later event for the same item, and a marker is kept while its item is still
  live (an open feed episode, or an issue still blocked on the same
  human-owned step). An instance-scope index (`marker-index`) tracks them,
  because plugin state cannot be listed. Markers written by 0.1.0 join the
  index the next time an event for their item arrives.
- Install notes: read plugin log lines from the server log, because
  `GET /api/plugins/<id>/logs` can return `[]` on some host builds.

## 0.1.0

- First release: wake a triage agent for new board decision items it did not
  raise, with persisted dedupe, debounce batching, a daily wake cap with one
  investigation issue per day, and a kill switch.
- Known gap: board recovery actions are not covered on host 2026.1106.0,
  because the host emits no plugin event for them.
