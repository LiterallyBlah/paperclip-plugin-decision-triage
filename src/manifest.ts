import type { PaperclipPluginManifestV1 } from "@paperclipai/plugin-sdk";
import { INSTANCE_CONFIG_SCHEMA } from "./config.js";

export const PLUGIN_ID = "paperclip.decision-triage";
export const PLUGIN_VERSION = "0.3.4";

const manifest: PaperclipPluginManifestV1 = {
  id: PLUGIN_ID,
  apiVersion: 1,
  version: PLUGIN_VERSION,
  displayName: "Decision Triage",
  description:
    "Routes each board- or user-owned decision item the triage agent did not raise (recovery actions, human-owned blocked work, blocker attention, reviews held by a person or stalled, cards to a person, board decisions) to a configured triage agent: one routing issue per item and a wake naming the item and source. Pending approvals and reserved human choices are reported, not routed. Debounced, deduplicated, backed off; daily wake cap and kill switch.",
  author: "LiterallyBlah",
  categories: ["automation"],
  capabilities: [
    "events.subscribe",
    "plugin.state.read",
    "plugin.state.write",
    "issues.read",
    "issue.interactions.read",
    // Recovery catch-up sweep: reads the host's recovery notice comment (plugins cannot read recovery actions).
    "issue.comments.read",
    "companies.read",
    // Read-only: before routing, the triage agent's status is read once per batch. While it is
    // paused, terminated or pending approval the host refuses the wake and blocks its routing
    // issues, so the batch is held (no issue, wake or cap count) and checked again later.
    "agents.read",
    "agents.invoke",
    "issues.create",
    // Closes the plugin's own routing issues (originKind plugin:paperclip.decision-triage:route,
    // assigned to the triage agent, still todo) whose source item left the board. Never used on any other issue.
    "issues.update",
    "issue.comments.create",
    "issues.wakeup",
  ],
  entrypoints: {
    worker: "./dist/worker.js",
  },
  instanceConfigSchema: INSTANCE_CONFIG_SCHEMA as unknown as PaperclipPluginManifestV1["instanceConfigSchema"],
};

export default manifest;
