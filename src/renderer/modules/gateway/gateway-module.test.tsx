// @vitest-environment jsdom
import { EventEmitter, once } from "node:events";
import { act } from "react";
import * as TooltipPrimitive from "@radix-ui/react-tooltip";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { GatewayPool } from "@omp-switch/core";
import { createMockApi } from "../../api";
import i18n from "../../i18n";
import { GatewayModule } from "./gateway-module";

const mounted: Array<{ root: Root; container: HTMLDivElement }> = [];
afterEach(async () => {
  await act(async () => { for (const { root, container } of mounted.splice(0)) { root.unmount(); container.remove(); } });
});

function pool(profile: string): GatewayPool {
  return { id: "shared", profile, virtualModel: `omp-switch/${profile}`, port: 46831, enabled: true, upstreams: [{ id: "one", providerId: "local", modelId: "model", kind: "secret", credentialId: "test", enabled: true }] };
}

async function mount(api = createMockApi()) {
  const container = document.createElement("div");
  document.body.appendChild(container);
  const root = createRoot(container);
  mounted.push({ root, container });
  const notices: Array<{ tone: "success" | "error" | "info"; text: string }> = [];
  const render = async (profileId: string) => {
    await act(async () => { root.render(<TooltipPrimitive.Provider><GatewayModule api={api} profileId={profileId} readOnly={false} onNotice={(notice) => notices.push(notice)} providers={[]} /></TooltipPrimitive.Provider>); });
  };
  await render("default");
  const selectPool = async () => { await act(async () => { (container.querySelector(".module-list-row") as HTMLButtonElement).click(); }); };
  const editModel = async (value: string) => {
    const input = container.querySelector<HTMLInputElement>("input[name='virtualModel']")!;
    await act(async () => { Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!.call(input, value); input.dispatchEvent(new Event("input", { bubbles: true })); });
  };
  const save = async () => {
    const button = [...container.querySelectorAll("button")].find((candidate) => candidate.textContent === i18n.t("common.save"))!;
    await act(async () => { button.click(); });
  };
  const model = () => container.querySelector<HTMLInputElement>("input[name='virtualModel']")?.value;
  const click = async (key: string, profile: string) => {
    const button = [...container.querySelectorAll("button")].find((candidate) => candidate.textContent === i18n.t(key, { profile }))!;
    await act(async () => { button.click(); });
  };
  const runningLabel = (profile: string) => i18n.t("gateway.running", { profile, port: 46831 });
  return { container, render, selectPool, editModel, save, model, click, runningLabel, notices };
}

describe("gateway profile isolation", () => {
  it("discards the old draft and saves equal-ID pools independently after a profile switch", async () => {
    const api = createMockApi();
    await api.saveGatewayPool(pool("default"));
    await api.saveGatewayPool(pool("work"));
    const view = await mount(api);
    await view.selectPool();
    await view.editModel("omp-switch/unsaved-default");
    await view.render("work");
    expect(view.model()).toBeUndefined();
    await view.selectPool();
    expect(view.model()).toBe("omp-switch/work");
    await view.editModel("omp-switch/saved-work");
    await view.save();
    expect((await api.listGatewayPools("default"))[0]).toEqual(pool("default"));
    expect((await api.listGatewayPools("work"))[0].virtualModel).toBe("omp-switch/saved-work");
    await view.render("default");
    await view.selectPool();
    expect(view.model()).toBe("omp-switch/default");
  });

  it("does not let an old in-flight save replace the new profile editor", async () => {
    const api = createMockApi();
    await api.saveGatewayPool(pool("default"));
    await api.saveGatewayPool(pool("work"));
    const persist = api.saveGatewayPool;
    let finishSave!: () => void;
    const pendingSave = new Promise<void>((resolve) => { finishSave = resolve; });
    api.saveGatewayPool = async (draft) => { await pendingSave; return persist(draft); };
    const view = await mount(api);
    await view.selectPool();
    await view.editModel("omp-switch/saved-default");
    await view.save();
    await view.render("work");
    await view.selectPool();
    await act(async () => { finishSave(); });
    expect(view.model()).toBe("omp-switch/work");
    expect((await api.listGatewayPools("work"))[0]).toEqual(pool("work"));
    expect((await api.listGatewayPools("default"))[0].virtualModel).toBe("omp-switch/saved-default");
  });

  it("ignores a previous profile's delayed refresh", async () => {
    const api = createMockApi();
    await api.saveGatewayPool(pool("default"));
    await api.saveGatewayPool(pool("work"));
    const list = api.listGatewayPools;
    let finishRefresh!: (pools: GatewayPool[]) => void;
    const pendingRefresh = new Promise<GatewayPool[]>((resolve) => { finishRefresh = resolve; });
    api.listGatewayPools = async (profileId) => profileId === "default" ? pendingRefresh : list(profileId);
    const view = await mount(api);
    await view.render("work");
    await view.selectPool();
    await act(async () => { finishRefresh([pool("default")]); });
    expect(view.model()).toBe("omp-switch/work");
    expect(view.container.querySelector(".module-list-row strong")?.textContent).toBe("omp-switch/work");
  });
});

describe("gateway active profile ownership", () => {
  it("labels active A while viewing equal-ID B pools, hides A stats, and saves B before switching", async () => {
    const api = createMockApi();
    await api.saveGatewayPool(pool("default"));
    await api.saveGatewayPool(pool("work"));
    await api.startGateway("default");
    const getStatus = api.gatewayStatus;
    api.gatewayStatus = async () => {
      const status = await getStatus();
      return { ...status, upstreams: status.profileId === "default" ? [{ poolId: "shared", upstreamId: "one", lastStatus: 503, lastLatencyMs: 1234, lastAt: new Date().toISOString(), consecutiveFailures: 7 }] : [] };
    };
    const view = await mount(api);
    await view.selectPool();
    expect(view.container.querySelector(".upstream-status-row")?.textContent).toContain("503");
    await view.render("work");
    await view.selectPool();
    expect(view.container.textContent).toContain(view.runningLabel("default"));
    expect(view.container.querySelector(".upstream-status-row")).toBeNull();
    expect(view.container.querySelector("input[name='bearerToken']")).toBeNull();
    await view.editModel("omp-switch/switch-draft");
    await view.click("gateway.switchProfile", "work");
    expect((await api.listGatewayPools("work"))[0].virtualModel).toBe("omp-switch/switch-draft");
    expect(view.container.textContent).toContain(view.runningLabel("work"));
    expect(view.container.textContent).not.toContain(view.runningLabel("default"));
    expect(view.container.querySelector<HTMLInputElement>("input[name='bearerToken']")?.value).toBeTruthy();
    expect(view.notices).toContainEqual({ tone: "success", text: i18n.t("gateway.started", { profile: "work", port: 46831 }) });
  });

  it("offers an explicit stop A action even in empty B without a draft", async () => {
    const api = createMockApi();
    await api.saveGatewayPool(pool("default"));
    await api.startGateway("default");
    const stop = vi.spyOn(api, "stopGateway");
    const view = await mount(api);
    await view.render("empty");
    expect(view.container.textContent).toContain(i18n.t("gateway.empty"));
    expect(view.container.textContent).toContain(view.runningLabel("default"));
    await view.click("gateway.stop", "default");
    expect(stop).toHaveBeenCalledWith("default");
    expect((await api.gatewayStatus()).running).toBe(false);
    expect(view.container.textContent).toContain(i18n.t("gateway.stoppedBadge"));
    expect(view.notices).toContainEqual({ tone: "success", text: i18n.t("gateway.stopped", { profile: "default" }) });
  });

  it("rejects a stale stop A and refreshes the actual new B owner", async () => {
    const api = createMockApi();
    await api.saveGatewayPool(pool("default"));
    await api.saveGatewayPool(pool("work"));
    await api.startGateway("default");
    const stop = vi.spyOn(api, "stopGateway");
    const view = await mount(api);
    await view.render("work");
    await api.startGateway("work");
    await view.click("gateway.stop", "default");
    expect(stop).toHaveBeenCalledWith("default");
    expect(await api.gatewayStatus()).toMatchObject({ running: true, profileId: "work" });
    expect(view.container.textContent).toContain(view.runningLabel("work"));
    expect(view.notices.some((notice) => notice.tone === "error")).toBe(true);
    expect(view.container.querySelector("input[name='bearerToken']")).toBeNull();
  });

  it("keeps A ownership and no token while a switch is delayed and after it fails", async () => {
    const api = createMockApi();
    await api.saveGatewayPool(pool("default"));
    await api.saveGatewayPool(pool("work"));
    await api.startGateway("default");
    const switchGate = new EventEmitter();
    api.startGateway = async () => { await once(switchGate, "finish"); throw new Error("Target resolver failed"); };
    const view = await mount(api);
    await view.render("work");
    await view.selectPool();
    await view.click("gateway.switchProfile", "work");
    expect(view.container.textContent).toContain(view.runningLabel("default"));
    expect(view.container.querySelector("input[name='bearerToken']")).toBeNull();
    await act(async () => { switchGate.emit("finish"); });
    expect(view.container.textContent).toContain(view.runningLabel("default"));
    expect(view.container.textContent).not.toContain(view.runningLabel("work"));
    expect(view.container.querySelector("input[name='bearerToken']")).toBeNull();
    expect(view.notices).toContainEqual({ tone: "error", text: "Target resolver failed" });
    expect(view.notices.some((notice) => notice.text === i18n.t("gateway.started", { profile: "work", port: 46831 }))).toBe(false);
  });

  it("clears a previously shown token on a failed restart and refreshes status", async () => {
    const api = createMockApi();
    await api.saveGatewayPool(pool("default"));
    const view = await mount(api);
    await view.selectPool();
    await view.click("gateway.start", "default");
    expect(view.container.querySelector("input[name='bearerToken']")).not.toBeNull();
    const status = vi.spyOn(api, "gatewayStatus");
    api.startGateway = async () => { throw new Error("Token unavailable"); };
    await view.click("gateway.start", "default");
    expect(status).toHaveBeenCalled();
    expect(view.container.textContent).toContain(view.runningLabel("default"));
    expect(view.container.querySelector("input[name='bearerToken']")).toBeNull();
  });
});

describe("gateway upstream identity", () => {
  it("keeps new upstream identities unique through deletion, addition and reordering without reusing deleted IDs", async () => {
    const api = createMockApi();
    const saved = pool("default");
    saved.upstreams = [1, 2, 3].map((number) => ({ ...saved.upstreams[0], id: `upstream-${number}` }));
    await api.saveGatewayPool(saved);
    const view = await mount(api);
    await view.selectPool();
    const ids = () => [...view.container.querySelectorAll<HTMLInputElement>(".upstream-row input[name$='.id']")].map((input) => input.value);
    const action = async (key: string, row?: number) => {
      const scope = row === undefined ? view.container : view.container.querySelectorAll(".upstream-row")[row];
      const button = [...scope.querySelectorAll<HTMLButtonElement>("button")].find((candidate) => candidate.getAttribute("aria-label") === i18n.t(key))!;
      await act(async () => { button.click(); });
    };
    const seen = new Set(ids());
    await action("gateway.deleteUpstream", 1);
    await action("gateway.addUpstream");
    const added = ids()[2];
    expect(ids().slice(0, 2)).toEqual(["upstream-1", "upstream-3"]);
    expect(seen.has(added)).toBe(false);
    seen.add(added);
    await action("gateway.moveUpstreamUp", 2);
    expect(ids()).toEqual(["upstream-1", added, "upstream-3"]);
    await action("gateway.deleteUpstream", 1);
    await action("gateway.addUpstream");
    expect(seen.has(ids()[2])).toBe(false);
    expect(new Set(ids()).size).toBe(3);
  });

  it("reports manually duplicated IDs and does not save or start the invalid draft", async () => {
    const api = createMockApi();
    const saved = pool("default");
    saved.upstreams.push({ ...saved.upstreams[0], id: "two" });
    await api.saveGatewayPool(saved);
    const view = await mount(api);
    await view.selectPool();
    const input = view.container.querySelector<HTMLInputElement>("input[name='upstreams.1.id']")!;
    input.focus();
    await act(async () => { Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!.call(input, "one"); input.dispatchEvent(new Event("input", { bubbles: true })); });
    expect(document.activeElement).toBe(input);
    await view.save();
    await view.click("gateway.start", "default");
    expect(view.notices).toContainEqual({ tone: "error", text: i18n.t("gateway.duplicateUpstreamId", { id: "one" }) });
    expect((await api.listGatewayPools("default"))[0]).toEqual(saved);
    expect((await api.gatewayStatus()).running).toBe(false);
  });
});

describe("gateway saved-configuration probes", () => {
  const button = (container: HTMLElement, key: string) => [...container.querySelectorAll<HTMLButtonElement>("button")].find((candidate) => candidate.getAttribute("aria-label") === i18n.t(key) || candidate.title === i18n.t(key))!;
  const fill = async (container: HTMLElement, name: string, value: string) => {
    const input = container.querySelector<HTMLInputElement>(`input[name='${name}']`)!;
    await act(async () => { Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!.call(input, value); input.dispatchEvent(new Event("input", { bubbles: true })); });
  };

  it("requires saving a new pool before probing and does not implicitly persist it", async () => {
    const api = createMockApi();
    const view = await mount(api);
    await view.click("gateway.newPool", "default");
    expect(button(view.container, "gateway.probeUpstream").disabled).toBe(true);
    expect(button(view.container, "gateway.probeAll").disabled).toBe(true);
    expect(view.container.textContent).toContain(i18n.t("gateway.probeSaveFirst"));
    expect(await api.listGatewayPools("default")).toEqual([]);
  });

  it("blocks edited credentials and new upstreams until saved, including after a failed save", async () => {
    const api = createMockApi();
    const saved = pool("default");
    await api.saveGatewayPool(saved);
    const view = await mount(api);
    await view.selectPool();
    expect(button(view.container, "gateway.probeUpstream").disabled).toBe(false);
    await fill(view.container, "upstreams.0.credentialId", "changed");
    expect(button(view.container, "gateway.probeUpstream").disabled).toBe(true);
    api.saveGatewayPool = async () => { throw new Error("disk full"); };
    await view.save();
    expect(button(view.container, "gateway.probeAll").disabled).toBe(true);
    expect((await api.listGatewayPools("default"))[0]).toEqual(saved);
    await act(async () => { button(view.container, "gateway.addUpstream").click(); });
    expect([...view.container.querySelectorAll<HTMLButtonElement>(`button[aria-label='${i18n.t("gateway.probeUpstream")}']`)].every((candidate) => candidate.disabled)).toBe(true);
    expect(view.container.textContent).toContain(i18n.t("gateway.probeSaveFirst"));
  });

  it("rejects a saved version changed outside the current editor before running a probe", async () => {
    const api = createMockApi();
    const saved = pool("default");
    await api.saveGatewayPool(saved);
    const view = await mount(api);
    await view.selectPool();
    await api.saveGatewayPool({ ...saved, upstreams: [{ ...saved.upstreams[0], credentialId: "external" }] });
    await act(async () => { button(view.container, "gateway.probeUpstream").click(); });
    expect(view.notices).toContainEqual({ tone: "error", text: i18n.t("gateway.probeConfigurationChanged") });
    expect(view.container.querySelector(".health-badge")?.textContent).toBe(i18n.t("gateway.untested"));
    expect(button(view.container, "gateway.probeUpstream").disabled).toBe(true);
  });

  it("does not attach a late probe result to edited credentials and clears it after saving", async () => {
    const api = createMockApi();
    await api.saveGatewayPool(pool("default"));
    let finish!: (result: { ok: boolean; status: number; latencyMs: number }) => void;
    api.probeGatewayUpstream = () => new Promise((resolve) => { finish = resolve; });
    const view = await mount(api);
    await view.selectPool();
    await act(async () => { button(view.container, "gateway.probeUpstream").click(); });
    const save = [...view.container.querySelectorAll<HTMLButtonElement>("button")].find((candidate) => candidate.textContent === i18n.t("common.save"))!;
    expect(save.disabled).toBe(true);
    await fill(view.container, "upstreams.0.credentialId", "changed");
    await act(async () => { finish({ ok: true, status: 200, latencyMs: 937 }); });
    expect(view.container.querySelector(".health-badge")?.textContent).toBe(i18n.t("gateway.untested"));
    await view.save();
    expect((await api.listGatewayPools("default"))[0].upstreams[0].credentialId).toBe("changed");
    expect(view.container.querySelector(".health-badge")?.textContent).toBe(i18n.t("gateway.untested"));
    expect(button(view.container, "gateway.probeUpstream").disabled).toBe(false);
  });

  it("does not show a previous pool's late result on another pool with the same upstream ID", async () => {
    const api = createMockApi();
    await api.saveGatewayPool(pool("default"));
    await api.saveGatewayPool({ ...pool("default"), id: "other", virtualModel: "omp-switch/other" });
    let finish!: (result: { ok: boolean; status: number; latencyMs: number }) => void;
    api.probeGatewayUpstream = () => new Promise((resolve) => { finish = resolve; });
    const view = await mount(api);
    await view.selectPool();
    await act(async () => { button(view.container, "gateway.probeUpstream").click(); });
    await act(async () => { (view.container.querySelectorAll(".module-list-row")[1] as HTMLButtonElement).click(); });
    await act(async () => { finish({ ok: true, status: 200, latencyMs: 937 }); });
    expect(view.model()).toBe("omp-switch/other");
    expect(view.container.querySelector(".health-badge")?.textContent).toBe(i18n.t("gateway.untested"));
  });

  it("reports partial failures, including rejected probes, and counts only enabled upstreams", async () => {
    const api = createMockApi();
    const saved = pool("default");
    saved.upstreams = [saved.upstreams[0], { ...saved.upstreams[0], id: "two" }, { ...saved.upstreams[0], id: "three" }, { ...saved.upstreams[0], id: "disabled", enabled: false }];
    await api.saveGatewayPool(saved);
    api.gatewayHealth = async () => ({ "shared:two": { poolId: "shared", upstreamId: "two", ok: true, consecutiveFailures: 0, healthState: "healthy", lastLatencyMs: 444, recentHistory: [] } });
    api.probeGatewayUpstream = async (_profile, _poolId, id) => {
      if (id === "two") throw new Error("credential missing");
      return id === "one" ? { ok: true, status: 200, latencyMs: 17 } : { ok: false, status: 503, latencyMs: 23, error: "HTTP 503" };
    };
    const view = await mount(api);
    await view.selectPool();
    await act(async () => { button(view.container, "gateway.probeAll").click(); });
    const errors = view.notices.filter((notice) => notice.tone === "error");
    expect(errors).toHaveLength(1);
    expect(errors[0].text).toContain(i18n.t("gateway.probeAllFailed", { pool: saved.id, count: 3, ok: 1, failed: 2 }));
    expect(errors[0].text).toContain("credential missing");
    expect(errors[0].text).toContain("HTTP 503");
    expect(view.notices.some((notice) => notice.tone === "success")).toBe(false);
    expect([...view.container.querySelectorAll(".health-badge")].map((badge) => badge.classList.contains("unhealthy"))).toEqual([false, true, true, false]);
    expect(view.container.querySelectorAll(".health-badge")[1].textContent).toBe(i18n.t("gateway.probeError"));
  });

  it("does not report successful batch completion when no upstream is enabled", async () => {
    const api = createMockApi();
    const saved = pool("default");
    saved.upstreams[0].enabled = false;
    await api.saveGatewayPool(saved);
    const view = await mount(api);
    await view.selectPool();
    expect(button(view.container, "gateway.probeAll").disabled).toBe(true);
    expect(view.container.textContent).toContain(i18n.t("gateway.probeNoneEnabled"));
    expect(button(view.container, "gateway.probeUpstream").disabled).toBe(false);
  });
});
