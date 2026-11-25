import { definePlugin, runWorker, type PluginEvent, type PluginEventType } from "@paperclipai/plugin-sdk";
import { parseConfig } from "./config.js";
import { DecisionTriage } from "./triage.js";
import { BLOCKER_ATTENTION_CHANGED, DECISION_CREATED, INTERACTION_CREATED } from "./triggers.js";

/**
 * Same event set as the ntfy decision notifier. Each name is registered
 * exactly once. Board- or user-owned recovery actions arrive as a system
 * `issue.updated` (status `blocked`, `recoveryActionId`, `recoveryOwnerType`)
 * on hosts that publish recovery status changes; a catch-up sweep in the
 * worker covers missed events and hosts that do not publish them.
 */
export const SUBSCRIBED_EVENTS = [
  "approval.created",
  INTERACTION_CREATED,
  "activity.logged",
  "issue.updated",
  BLOCKER_ATTENTION_CHANGED,
  DECISION_CREATED,
] as const;

let triage: DecisionTriage | null = null;

const plugin = definePlugin({
  multiCompanyConfig: true,

  async setup(ctx) {
    triage = new DecisionTriage(ctx);
    const current = triage;
    const handler = async (event: PluginEvent) => {
      await current.handle(event);
    };
    for (const name of SUBSCRIBED_EVENTS) {
      ctx.events.on(name as PluginEventType, handler);
    }
    // Items queued before a restart are flushed (overdue ones at once).
    await current.start();
  },

  async onValidateConfig(config) {
    const parsed = parseConfig(config);
    return parsed.ok ? { ok: true } : { ok: false, errors: parsed.errors };
  },

  async onConfigChanged(newConfig, change) {
    // Remembers which companies are configured, so the timer-driven sweep names
    // each company instead of listing companies outside an invocation.
    triage?.noteConfigChanged(change?.companyId, newConfig);
  },

  async onHealth() {
    return { status: "ok", message: "decision triage ready" };
  },

  async onShutdown() {
    triage?.stop(true);
  },
});

export default plugin;
runWorker(plugin, import.meta.url);
