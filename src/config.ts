/**
 * Strict configuration parsing for decision triage. Unknown keys are
 * rejected so that a typo is reported instead of being silently ignored. Every
 * id is validated as a UUID before it is used in a host call.
 */

export interface TriageTriggers {
  approvals: boolean;
  interactions: boolean;
  blockerAttention: boolean;
  decisions: boolean;
  /** Board- or user-owned recovery actions, any kind, cause or policy. */
  recoveries: boolean;
  /** In-review issues held by a person (user assignee or stage participant) or with a stalled review path. */
  reviews: boolean;
}

export interface TriageConfig {
  enabled: boolean;
  triageAgentId: string;
  /** Standing issue assigned to the triage agent; a comment there is the fallback wake. */
  triageIssueId: string | null;
  paperclipBaseUrl: string;
  debounceSeconds: number;
  maxWakesPerDay: number;
  investigationProjectId: string | null;
  investigationAssigneeAgentId: string;
  allowInsecureHttp: boolean;
  triggers: TriageTriggers;
}

export type ConfigParseResult = { ok: true; config: TriageConfig } | { ok: false; errors: string[] };

export const DEFAULT_DEBOUNCE_SECONDS = 10;
export const DEFAULT_MAX_WAKES_PER_DAY = 50;

const TOP_LEVEL_KEYS = new Set([
  "enabled",
  "triageAgentId",
  "triageIssueId",
  "paperclipBaseUrl",
  "debounceSeconds",
  "maxWakesPerDay",
  "investigationProjectId",
  "investigationAssigneeAgentId",
  "allowInsecureHttp",
  "triggers",
]);
const TRIGGER_KEYS = new Set(["approvals", "interactions", "blockerAttention", "decisions", "recoveries", "reviews"]);

export const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function parseBoolean(field: string, value: unknown, fallback: boolean, errors: string[]): boolean {
  if (value === undefined) return fallback;
  if (typeof value !== "boolean") {
    errors.push(`${field} must be a boolean`);
    return fallback;
  }
  return value;
}

function parseUuid(field: string, value: unknown, required: boolean, errors: string[]): string | null {
  if (value === undefined || value === null || value === "") {
    if (required) errors.push(`${field} is required (a UUID)`);
    return null;
  }
  if (typeof value !== "string" || !UUID_PATTERN.test(value)) {
    errors.push(`${field} must be a UUID`);
    return null;
  }
  return value.toLowerCase();
}

function parseInteger(field: string, value: unknown, fallback: number, min: number, max: number, errors: string[]): number {
  if (value === undefined) return fallback;
  if (typeof value !== "number" || !Number.isInteger(value) || value < min || value > max) {
    errors.push(`${field} must be an integer from ${min} to ${max}`);
    return fallback;
  }
  return value;
}

function parseBaseUrl(value: unknown, allowInsecureHttp: boolean, errors: string[]): string | null {
  const field = "paperclipBaseUrl";
  if (typeof value !== "string" || value.trim() === "") {
    errors.push(`${field} is required`);
    return null;
  }
  let url: URL;
  try {
    url = new URL(value.trim());
  } catch {
    errors.push(`${field} must be an absolute URL`);
    return null;
  }
  if (url.protocol !== "https:" && !(allowInsecureHttp && url.protocol === "http:")) {
    errors.push(`${field} must use https (set allowInsecureHttp only for local testing)`);
    return null;
  }
  if (url.username || url.password || url.search || url.hash) {
    errors.push(`${field} must not contain credentials, a query or a fragment`);
    return null;
  }
  return `${url.origin}${url.pathname.replace(/\/+$/, "")}`;
}

export function parseConfig(raw: unknown): ConfigParseResult {
  const errors: string[] = [];
  if (!isRecord(raw)) return { ok: false, errors: ["config must be an object"] };
  for (const key of Object.keys(raw)) {
    if (!TOP_LEVEL_KEYS.has(key)) errors.push(`unknown config key "${key}"`);
  }

  const enabled = parseBoolean("enabled", raw.enabled, true, errors);
  const allowInsecureHttp = parseBoolean("allowInsecureHttp", raw.allowInsecureHttp, false, errors);
  const triageAgentId = parseUuid("triageAgentId", raw.triageAgentId, true, errors);
  const triageIssueId = parseUuid("triageIssueId", raw.triageIssueId, false, errors);
  const investigationProjectId = parseUuid("investigationProjectId", raw.investigationProjectId, false, errors);
  const investigationAssigneeAgentId = parseUuid("investigationAssigneeAgentId", raw.investigationAssigneeAgentId, false, errors);
  const paperclipBaseUrl = parseBaseUrl(raw.paperclipBaseUrl, allowInsecureHttp, errors);
  const debounceSeconds = parseInteger("debounceSeconds", raw.debounceSeconds, DEFAULT_DEBOUNCE_SECONDS, 0, 300, errors);
  const maxWakesPerDay = parseInteger("maxWakesPerDay", raw.maxWakesPerDay, DEFAULT_MAX_WAKES_PER_DAY, 1, 10_000, errors);

  const triggers: TriageTriggers = { approvals: true, interactions: true, blockerAttention: true, decisions: true, recoveries: true, reviews: true };
  if (raw.triggers !== undefined) {
    if (!isRecord(raw.triggers)) {
      errors.push("triggers must be an object");
    } else {
      for (const key of Object.keys(raw.triggers)) {
        if (!TRIGGER_KEYS.has(key)) errors.push(`triggers has unknown key "${key}"`);
      }
      for (const key of TRIGGER_KEYS) {
        triggers[key as keyof TriageTriggers] = parseBoolean(`triggers.${key}`, raw.triggers[key], true, errors);
      }
    }
  }

  if (errors.length > 0 || !triageAgentId || !paperclipBaseUrl) return { ok: false, errors };
  return {
    ok: true,
    config: {
      enabled,
      triageAgentId,
      triageIssueId,
      paperclipBaseUrl,
      debounceSeconds,
      maxWakesPerDay,
      investigationProjectId,
      investigationAssigneeAgentId: investigationAssigneeAgentId ?? triageAgentId,
      allowInsecureHttp,
      triggers,
    },
  };
}

const uuid = { type: "string", pattern: "^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$" } as const;

/** JSON Schema shown in the plugin settings form. Mirrors `parseConfig`. */
export const INSTANCE_CONFIG_SCHEMA = {
  type: "object",
  additionalProperties: false,
  required: ["triageAgentId", "paperclipBaseUrl"],
  properties: {
    enabled: { type: "boolean", default: true, title: "Enabled", description: "Kill switch. When off the plugin wakes no agent and creates nothing." },
    triageAgentId: { ...uuid, title: "Triage agent id", description: "Agent woken for decision items it did not raise." },
    triageIssueId: { ...uuid, title: "Standing triage issue id (fallback)", description: "Issue assigned to the triage agent. A comment there is the fallback when the direct wake is refused." },
    paperclipBaseUrl: { type: "string", title: "Paperclip base URL", description: "Used only to build board links in the wake text." },
    debounceSeconds: { type: "integer", minimum: 0, maximum: 300, default: DEFAULT_DEBOUNCE_SECONDS, title: "Debounce window (seconds)" },
    maxWakesPerDay: { type: "integer", minimum: 1, maximum: 10000, default: DEFAULT_MAX_WAKES_PER_DAY, title: "Maximum wakes per UTC day" },
    investigationProjectId: { ...uuid, title: "Project for the daily-cap investigation issue" },
    investigationAssigneeAgentId: { ...uuid, title: "Assignee of the daily-cap investigation issue", description: "Defaults to the triage agent." },
    allowInsecureHttp: { type: "boolean", default: false, title: "Allow a plain http base URL (local testing only)" },
    triggers: {
      type: "object",
      additionalProperties: false,
      title: "Triggers",
      properties: {
        approvals: { type: "boolean", default: true, title: "Approvals waiting for the board" },
        interactions: { type: "boolean", default: true, title: "Cards addressed to a person (questions, confirmations, connection intents)" },
        blockerAttention: { type: "boolean", default: true, title: "Blocked work that needs board attention" },
        decisions: { type: "boolean", default: true, title: "Agent decisions waiting for a board response" },
        recoveries: { type: "boolean", default: true, title: "Board- or user-owned recovery actions of any kind (event and catch-up sweep)" },
        reviews: { type: "boolean", default: true, title: "Reviews held by a person or with a stalled review path (event and catch-up sweep)" },
      },
    },
  },
} as const;
