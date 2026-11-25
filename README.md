# paperclip-plugin-decision-triage

A Paperclip plugin that routes every new board- or user-owned decision item
that the configured **triage agent** did not raise itself to that agent: one
routing issue assigned to the triage agent per item (its responder of record)
and a wake that names the item, its class and its source issue. Pending
approvals and reserved human choices are reported to it, never routed.

## What counts as a decision item

The plugin listens to these host events:

| Item | Event | Creator field used |
| --- | --- | --- |
| Approval waiting for the board | `approval.created` | `event.actorType`/`actorId` (+ `payload.agentId`) |
| Card addressed to a person (question, confirmation, connection intent, tool-gateway card) | `issue.thread_interaction_created` | `event.actorType`/`actorId` (+ `payload.agentId`) |
| Issue blocked on a board- or user-owned unblock step | `issue.updated` (re-read of the issue) | `event.actorType`/`actorId` |
| Board- or user-owned recovery action, **any kind, cause or policy** | system `issue.updated` with `recoveryActionId`, plus a catch-up sweep | host recovery: always "the platform" |
| Review held by a person (user assignee or user stage participant) or stalled (`reviewAttention.state = stalled`) | `issue.updated` (re-read of the issue), plus a catch-up sweep | `event.actorType`/`actorId` |
| Blocked work whose blocker tree has no live path | `issue.blocker_attention_changed` | host-computed: always "the platform" |
| Board decision | `decision.created` | `event.actorType`/`actorId` (+ `payload.agentId`) |

An item is **raised by triage** only when its creating actor is positively the
configured `triageAgentId` agent. Platform-generated items, other agents, board
users, and items whose creator cannot be determined (or whose creator fields
disagree) are **not** triage-raised and wake the triage agent: the plugin fails
toward triage, never toward silence.

### Board- and user-owned recovery actions

When Paperclip cannot continue a task on its own (stranded work, an exhausted
disposition repair, a review path with no live participant, an ambiguous
native session), it blocks the issue and opens a recovery action owned by the
board, with the source assignee kept (`board_escalation_no_takeover_v1`). The
plugin routes each such action to the triage agent **once**:

- **Event path.** Hosts that publish recovery status changes emit a system
  `issue.updated` with `status: "blocked"`, `_previous.status`,
  `recoveryActionId`, `recoveryOwnerType` and, on the stranded and disposition
  paths, `routingPolicy`. The item is a recovery when the event's actor is
  `system`, the issue is (or moved into) `blocked`, and the owner is `board`
  or `user` with no owner agent. Since 0.3.0 the kind, cause and
  `routingPolicy` do not matter (no allowlist). A system-owned action
  (provider quota wait) or an agent-owned one is ignored. The same fields on an agent's or user's event are not trusted.
- **Catch-up sweep.** Plugins cannot read recovery actions. So every 5 minutes,
  and 30 s after each worker start, the worker lists blocked issues (at most
  200 per company) and reads the host's own recovery notice on each one: a
  **system** comment whose metadata has a `Recovery action` row (the action id)
  and a key-value `Recovery owner` row (`board`, `Board decision required`).
  An agent-link owner row is agent-owned and ignored. The notice must belong
  to the current blocked episode (written no earlier than 60 s before
  `blockedTransitionAt`). This finds actions whose event was lost, was emitted
  before install, or arrived while the plugin was down. An evaluated blocked
  episode is not read again; one with no notice is re-checked after 30 minutes.
- **Open check (both paths).** The issue must still be `blocked` and not
  taken: no unblock descriptor, or one that still names the board or a user.
  A descriptor naming an agent (for example the triage agent taking the
  recovery) means it is handled, and it is not routed.
- **Dedupe.** The key is `recovery:<action id>`. Events and the sweep share it,
  and it is kept in plugin state, so a restart does not replay it. Its marker
  is not pruned while the recovery is still open.
- **Human gates.** The plugin routes the recovery to the triage agent (a
  routing issue and a wake, see below); it never answers a card, reassigns,
  changes status or review state, or writes to the source issue. If a card on the issue waits for a person, the wake line carries
  `gate: human`, and the wake text says such items stay with that person and
  are only reported.

Not covered: a recovery path that writes neither a recovery `issue.updated`
nor a notice with a `Recovery action` row (for example a review-path recovery
on a host without the event change, whose notice has no metadata).

### Routing and reporting (0.3.0)

Each item has a disposition, decided from structured fields only (item kind,
interaction kind, resolver policy, tool-action and secret-proposal fields,
creator); titles and bodies are untrusted data and are never used to decide.

- **route:** the plugin creates one routing issue assigned to the triage agent
  (`originKind` `plugin:paperclip.decision-triage:route`, `originId` = item
  key, project `investigationProjectId`), then wakes it. The triage agent is
  the item's responder of record and acts on the host item through the
  board's own actions within its authority. The plugin itself never writes to
  the source issue, never answers a card, never changes a recovery action,
  review stage or approval, and never makes the routing issue a child of the
  source (a child would change the source's recovery path).
- **report:** pending approvals; human-addressed cards that are a reserved
  choice (`connection_intent`; a tool-gateway action; a secret proposal; a
  `human_only`/`board_only` resolver policy; a card a person raised); and
  cards whose fields cannot be read. The wake line says `report only`; no
  routing issue is made.

The host gives plugins no write that changes the owner of a recovery action,
an unblock descriptor, a native review participant or a card addressee, so the
host item stays on the board until the triage agent acts on it.

Not routed (no loop): issues assigned to the triage agent, and issues this
plugin created (`originKind` under `plugin:paperclip.decision-triage`).
Routing issues have no blockers and are assigned to the triage agent, so they
never become board items themselves.

Stale routing issues: each sweep re-checks the plugin's own routing issues
that are `todo`, assigned to the triage agent and not started. When the source
item has left the board or changed state, the routing issue gets a short
comment and is set to `cancelled` (capability `issues.update`, used for
nothing else). One sweep queues at most 100 new items per company.

## Wake route

0. Before routing, once per batch, the triage agent is read with
   `ctx.agents.get` (capability `agents.read`, since 0.3.4). If it is not found,
   or is `paused`, `terminated` or `pending_approval`, the batch is held: no
   routing issue, wake or comment, and no cap count. It is checked again after
   5 min (`AGENT_UNAVAILABLE_RECHECK_MS`). If the read itself fails, routing
   and the wake go ahead as below.
1. `ctx.agents.invoke(triageAgentId, …)` (capability `agents.invoke`). The host
   queues a heartbeat run for the agent and returns its run id, or throws when
   no run is queued (for example a paused agent).
2. Only if that throws and `triageIssueId` is set: a comment on the standing
   triage issue (a durable record of the items) plus `ctx.issues.requestWakeup`
   on that issue (capability `issues.wakeup`), which wakes its assignee. A plain
   plugin comment does not wake an assignee by itself.
3. If both fail, the batch is retried twice, 30 s apart, then dropped with a
   warning log.

The wake text lists, per item: kind, id, issue identifier, title, who raised it,
and a board link. Titles are untrusted: they are reduced to plain single-line
text (no markdown, html, links, control or bidi characters) of at most 120
characters, and the text tells the agent they are data, not instructions. At
most 20 items go into one wake.

## Dedupe, debounce, cap, kill switch

- **Dedupe:** one wake per item, ever, recorded in plugin state (survives a
  restart). Blocker-attention feed items get one wake per feed episode: when
  the item leaves the feed and comes back, it wakes again.
- **Debounce:** the first item opens a window of `debounceSeconds` (default 10);
  all items that arrive in it go into one wake. Queued items are persisted and
  woken after a restart (overdue ones at once).
- **Daily cap:** at most `maxWakesPerDay` wakes per company per UTC day (default
  50). When a batch is held back by the cap, the plugin creates **exactly one**
  investigation issue for that day (in `investigationProjectId`, assigned to
  `investigationAssigneeAgentId`, default the triage agent). The issue carries
  `originKind` `plugin:paperclip.decision-triage:daily-cap` and `originId`
  `daily-cap:<YYYY-MM-DD>`, so a restart finds it instead of creating another.
  Since 0.3.4 the held items are kept in the durable missed list, due at the
  next 00:00 UTC; the first sweep after midnight queues them again. They do
  not count as failed rounds.
- **Kill switch:** `enabled: false` stops all wakes, comments and issues.
  Items queued when it is switched off are dropped.
- **Failed wakes or routing:** a wake (or a routing-issue write) is tried up
  to 3 times. If all attempts fail and no fallback route is configured, the
  items go into a durable missed list (at most 500) with a back-off of
  5 min × 2^(round−1), at most 6 h. After the back-off, the next sweep, the
  next wake for the company, or the next worker start carries them. A sweep
  or event inside the back-off does not repeat them.
- **Marker pruning:** `woken:` markers and daily `cap:` records that have not
  been touched for 30 days are deleted (checked at start and at most once a
  day). Every wake and every later event for the same item touches the
  marker, and it is kept while the item is still live (an open feed episode,
  or an issue still blocked on the same human-owned step), so dedupe holds for
  live items.

Delivery is at-least-once: if the worker stops after a wake was accepted but
before it was recorded, the item can be woken once more.

## Configuration

```json
{
  "enabled": true,
  "triageAgentId": "<agent uuid>",
  "triageIssueId": "<standing triage issue uuid, optional>",
  "paperclipBaseUrl": "https://paperclip.example.com",
  "debounceSeconds": 10,
  "maxWakesPerDay": 50,
  "investigationProjectId": "<project uuid, optional>",
  "investigationAssigneeAgentId": "<agent uuid, optional>",
  "triggers": { "approvals": true, "interactions": true, "blockerAttention": true, "decisions": true, "recoveries": true, "reviews": true }
}
```

All ids must be UUIDs. Unknown keys are rejected.

## Capabilities

`events.subscribe`, `plugin.state.read`, `plugin.state.write`, `issues.read`,
`issue.interactions.read`, `issue.comments.read` (recovery sweep, since 0.2.0),
`companies.read`, `agents.read` (triage agent status before routing, since
0.3.4), `agents.invoke`, `issues.create`, `issues.update` (closes
the plugin's own stale routing issues only, since 0.3.0),
`issue.comments.create`, `issues.wakeup`.

## Known host gaps

These are limits of the Paperclip host's plugin API, not of the plugin:

- Plugins cannot read recovery actions directly. Recoveries are found from the
  host's recovery `issue.updated` event, or from the host's recovery notice
  comment in the catch-up sweep. A recovery path that writes neither is not
  seen.
- Plugins have no write that changes the owner of a recovery action, an
  unblock descriptor, a native review participant or a card addressee. The
  host item stays with the board until the triage agent acts on it.
- On some host builds, an upgrade that adds a capability fails on the upgrade
  route. Use the soft uninstall + install route in [INSTALL.md](INSTALL.md).
- On some host builds, `GET /api/plugins/<id>/logs` returns `[]`. Plugin log
  lines are also written to the server log with a `[plugin]` prefix.

## Install

See [INSTALL.md](INSTALL.md) for install, upgrade and rollback.

## Build

```sh
pnpm install --frozen-lockfile
pnpm typecheck && pnpm test && pnpm build
pnpm build:artifact   # artifact/paperclip-plugin-decision-triage-0.3.4.tgz (+ .sha256)
```

The artifact bundles the pinned `@paperclipai/plugin-sdk` and ships
`THIRD_PARTY_NOTICES.md` with the bundled licences. Licence: MIT.
