import { describe, expect, it, vi } from "vitest";
import { createTestHarness } from "@paperclipai/plugin-sdk/testing";
import manifest from "../src/manifest.js";
import plugin, { SUBSCRIBED_EVENTS } from "../src/worker.js";
import { BASE_CONFIG } from "./fixtures.js";

vi.mock("@paperclipai/plugin-sdk", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@paperclipai/plugin-sdk")>()),
  runWorker: () => {},
}));

describe("worker wiring", () => {
  it("registers each event name exactly once, the same set as the ntfy notifier", async () => {
    const harness = createTestHarness({ manifest, config: BASE_CONFIG });
    const on = vi.spyOn(harness.ctx.events, "on");
    await plugin.definition.setup(harness.ctx);
    const names = on.mock.calls.map((call) => call[0]);
    expect(names).toEqual([
      "approval.created",
      "issue.thread_interaction_created",
      "activity.logged",
      "issue.updated",
      "issue.blocker_attention_changed",
      "decision.created",
    ]);
    expect(names).toEqual([...SUBSCRIBED_EVENTS]);
    await plugin.definition.onShutdown?.();
  });

  it("remembers configured companies from onConfigChanged without restarting the worker", async () => {
    const harness = createTestHarness({ manifest, config: BASE_CONFIG });
    await plugin.definition.setup(harness.ctx);
    expect(plugin.definition.onConfigChanged).toBeTypeOf("function");
    await expect(
      plugin.definition.onConfigChanged?.(BASE_CONFIG, { companyId: "00000000-0000-4000-8000-000000000001" }),
    ).resolves.toBeUndefined();
    await expect(plugin.definition.onConfigChanged?.({}, { companyId: null })).resolves.toBeUndefined();
    await plugin.definition.onShutdown?.();
  });

  it("validates config through onValidateConfig", async () => {
    await expect(plugin.definition.onValidateConfig?.(BASE_CONFIG)).resolves.toEqual({ ok: true });
    const bad = await plugin.definition.onValidateConfig?.({ ...BASE_CONFIG, triageAgentId: "triage-agent" });
    expect(bad?.ok).toBe(false);
  });

  it("declares only the capabilities it uses", () => {
    expect(manifest.id).toBe("paperclip.decision-triage");
    expect(manifest.version).toBe("0.3.4");
    expect([...manifest.capabilities].sort()).toEqual([
      "agents.invoke",
      "agents.read",
      "companies.read",
      "events.subscribe",
      "issue.comments.create",
      "issue.comments.read",
      "issue.interactions.read",
      "issues.create",
      "issues.read",
      "issues.update",
      "issues.wakeup",
      "plugin.state.read",
      "plugin.state.write",
    ]);
    expect(manifest.entrypoints.ui).toBeUndefined();
  });

  it("keeps the manifest description within the host's 500-character limit", () => {
    expect(manifest.description.length).toBeLessThanOrEqual(500);
  });
});
