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
  return { id: "shared", profile, virtualModel: `omp-switch/${profile}`, enabled: true, upstreams: [{ id: "one", providerId: "local", modelId: "model", kind: "secret", credentialId: "test", enabled: true }] };
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
  const refresh = async () => {
    await act(async () => { container.querySelector<HTMLButtonElement>(`.module-heading button[aria-label='${i18n.t("common.refresh")}']`)!.click(); });
  };
  return { container, render, selectPool, editModel, save, model, click, refresh, runningLabel, notices };
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
    api.gatewayStatus = async (profileId) => {
      const status = await getStatus(profileId);
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
    expect((await api.gatewayStatus("empty")).running).toBe(false);
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
    expect(await api.gatewayStatus("work")).toMatchObject({ running: true, profileId: "work" });
    expect(view.container.textContent).toContain(view.runningLabel("work"));
    expect(view.notices.some((notice) => notice.tone === "error")).toBe(true);
    expect(view.container.querySelector<HTMLInputElement>("input[name='bearerToken']")?.value).toBe((await api.gatewayStatus("work")).token);
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
    expect((await api.gatewayStatus("default")).running).toBe(false);
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
    expect(button(view.container, "gateway.probeUpstream").disabled).toBe(true);
  });
});

describe("gateway connection recovery", () => {
  const token = (container: HTMLElement) => container.querySelector<HTMLInputElement>("input[name='bearerToken']");

  it("restores the running connection without selecting a pool and scopes it through refresh, remount and stop", async () => {
    const api = createMockApi();
    await api.saveGatewayPool(pool("default"));
    const started = await api.startGateway("default");
    const view = await mount(api);
    expect(token(view.container)?.value).toBe(started.token);
    expect(token(view.container)?.readOnly).toBe(true);
    expect(view.model()).toBeUndefined();
    await view.refresh();
    expect(token(view.container)?.value).toBe(started.token);
    await view.render("work");
    expect(token(view.container)).toBeNull();
    expect(view.container.textContent).toContain(view.runningLabel("default"));
    await view.render("default");
    expect(token(view.container)?.value).toBe(started.token);
    await view.click("gateway.stop", "default");
    expect(token(view.container)).toBeNull();
    expect(view.container.textContent).toContain(i18n.t("gateway.stoppedBadge"));
  });

  it.each(["listGatewayPools", "gatewayStatus"] as const)("hides an unconfirmed previous token when %s fails during refresh", async (method) => {
    const api = createMockApi();
    await api.saveGatewayPool(pool("default"));
    const view = await mount(api);
    await view.selectPool();
    await view.click("gateway.start", "default");
    expect(token(view.container)).not.toBeNull();
    api[method] = async () => { throw new Error("Connection refresh failed"); };
    await view.refresh();
    expect(token(view.container)).toBeNull();
    expect(view.notices).toContainEqual({ tone: "error", text: "Connection refresh failed" });
  });

  it("restores the still-active connection after a failed restart", async () => {
    const api = createMockApi();
    await api.saveGatewayPool(pool("default"));
    const view = await mount(api);
    await view.selectPool();
    await view.click("gateway.start", "default");
    expect(token(view.container)).not.toBeNull();
    const previous = token(view.container)!.value;
    api.startGateway = async () => { throw new Error("Token unavailable"); };
    await view.click("gateway.start", "default");
    expect(token(view.container)?.value).toBe(previous);
    expect(view.container.textContent).toContain(view.runningLabel("default"));
    expect(view.notices).toContainEqual({ tone: "error", text: "Token unavailable" });
  });

  it("does not let a delayed previous-profile status expose its token in the new owner's connection", async () => {
    const api = createMockApi();
    await api.saveGatewayPool(pool("default"));
    await api.saveGatewayPool(pool("work"));
    await api.startGateway("default");
    const getStatus = api.gatewayStatus;
    const previous = { ...await getStatus("default"), token: "default-only-token" };
    let finish!: (value: typeof previous) => void;
    const pending = new Promise<typeof previous>((resolve) => { finish = resolve; });
    api.gatewayStatus = async (profileId) => profileId === "default" ? pending : { ...await getStatus(profileId), token: "work-only-token" };
    const view = await mount(api);
    await api.startGateway("work");
    await view.render("work");
    await act(async () => { finish(previous); });
    expect(token(view.container)?.value).toBe("work-only-token");
    expect(view.container.textContent).toContain(view.runningLabel("work"));
    expect(view.container.textContent).not.toContain(view.runningLabel("default"));
  });
});

describe("gateway Profile listener settings", () => {
  const portInput = (container: HTMLElement) => container.querySelector<HTMLInputElement>("input[name='listenerPort']")!;
  const action = (container: HTMLElement, key: string, profile = "default") => [...container.querySelectorAll<HTMLButtonElement>("button")].find((button) => button.textContent === i18n.t(key, { profile }))!;
  const editPort = async (container: HTMLElement, value: string) => {
    const input = portInput(container);
    await act(async () => { Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!.call(input, value); input.dispatchEvent(new Event("input", { bubbles: true })); });
  };

  it("saves and reloads the Profile port without a pool or pool draft", async () => {
    const api = createMockApi();
    const view = await mount(api);
    await editPort(view.container, "49123");
    await view.click("gateway.savePort", "default");
    expect(await api.gatewayListenerSettings("default")).toEqual({ port: 49123, conflictingPorts: [] });
    expect(await api.listGatewayPools("default")).toEqual([]);
    await editPort(view.container, "49124");
    await view.refresh();
    expect(portInput(view.container).value).toBe("49123");
    await view.render("work");
    await view.render("default");
    expect(portInput(view.container).value).toBe("49123");
  });

  it("blocks start on unsaved port edits without implicitly saving either configuration", async () => {
    const api = createMockApi();
    await api.saveGatewayPool(pool("default"));
    const view = await mount(api);
    await view.selectPool();
    await view.editModel("omp-switch/unsaved");
    const previous = await api.gatewayListenerSettings("default");
    await editPort(view.container, "49123");
    expect(action(view.container, "gateway.start").disabled).toBe(true);
    expect(view.container.textContent).toContain(i18n.t("gateway.portSaveFirst"));
    await view.click("gateway.start", "default");
    expect((await api.gatewayStatus("default")).running).toBe(false);
    expect(await api.gatewayListenerSettings("default")).toEqual(previous);
    expect((await api.listGatewayPools("default"))[0]).toEqual(pool("default"));
    await view.click("gateway.savePort", "default");
    expect(action(view.container, "gateway.start").disabled).toBe(false);
    expect((await api.listGatewayPools("default"))[0]).toEqual(pool("default"));
    await view.click("gateway.start", "default");
    expect(await api.gatewayStatus("default")).toMatchObject({ running: true, port: 49123 });
  });

  it("requires an explicit saved choice for conflicting legacy ports", async () => {
    const api = createMockApi();
    await api.saveGatewayPool(pool("default"));
    const getSettings = api.gatewayListenerSettings;
    let unresolved = true;
    api.gatewayListenerSettings = async (profile) => unresolved ? { port: null, conflictingPorts: [48111, 49222] } : getSettings(profile);
    const save = api.setGatewayPort;
    api.setGatewayPort = async (profile, port) => { const settings = await save(profile, port); unresolved = false; return settings; };
    const view = await mount(api);
    await view.selectPool();
    expect(portInput(view.container).value).toBe("");
    expect(view.container.textContent).toContain("48111, 49222");
    expect(action(view.container, "gateway.start").disabled).toBe(true);
    await editPort(view.container, "49222");
    expect(action(view.container, "gateway.start").disabled).toBe(true);
    await view.click("gateway.savePort", "default");
    expect(action(view.container, "gateway.start").disabled).toBe(false);
    expect(view.container.textContent).not.toContain("48111, 49222");
    await view.refresh();
    expect(portInput(view.container).value).toBe("49222");
  });

  it.each(["", "1023", "65536", "48123.5", "invalid"])("does not save or start with invalid listener input %s", async (value) => {
    const api = createMockApi();
    await api.saveGatewayPool(pool("default"));
    const previous = await api.gatewayListenerSettings("default");
    const view = await mount(api);
    await view.selectPool();
    await editPort(view.container, value);
    expect(action(view.container, "gateway.savePort").disabled).toBe(true);
    expect(action(view.container, "gateway.start").disabled).toBe(true);
    if (value) expect(view.container.textContent).toContain(i18n.t("gateway.portInvalid"));
    await view.click("gateway.savePort", "default");
    expect(await api.gatewayListenerSettings("default")).toEqual(previous);
  });

  it("keeps listener controls outside existing and new pool drafts", async () => {
    const api = createMockApi();
    await api.saveGatewayPool(pool("default"));
    const view = await mount(api);
    await view.selectPool();
    expect(view.container.querySelectorAll("input[name='listenerPort']")).toHaveLength(1);
    expect(view.container.querySelector(".gateway-editor input[name='listenerPort']")).toBeNull();
    expect(view.container.querySelectorAll(".gateway-editor input[inputmode='numeric']")).toHaveLength(0);
    await view.click("common.add", "default");
    expect(view.container.querySelectorAll(".gateway-editor input[inputmode='numeric']")).toHaveLength(0);
    await view.save();
    expect((await api.listGatewayPools("default")).every((saved) => !("port" in saved))).toBe(true);
  });

  it("preserves the saved setting and unsaved input when saving fails", async () => {
    const api = createMockApi();
    await api.saveGatewayPool(pool("default"));
    const previous = await api.gatewayListenerSettings("default");
    api.setGatewayPort = async () => { throw new Error("Listener settings write failed"); };
    const view = await mount(api);
    await view.selectPool();
    await editPort(view.container, "49123");
    await view.click("gateway.savePort", "default");
    expect(portInput(view.container).value).toBe("49123");
    expect(await api.gatewayListenerSettings("default")).toEqual(previous);
    expect(action(view.container, "gateway.start").disabled).toBe(true);
    expect(action(view.container, "gateway.savePort").disabled).toBe(false);
    expect(view.notices).toContainEqual({ tone: "error", text: "Listener settings write failed" });
    await view.refresh();
    expect(portInput(view.container).value).toBe(String(previous.port));
  });

  it("locks the active owner's setting but allows another Profile to save independently, refusing a different-port switch", async () => {
    const api = createMockApi();
    await api.saveGatewayPool(pool("default"));
    await api.saveGatewayPool(pool("work"));
    const active = await api.startGateway("default");
    const view = await mount(api);
    expect(portInput(view.container).disabled).toBe(true);
    expect(action(view.container, "gateway.savePort").disabled).toBe(true);
    await expect(api.setGatewayPort("default", 49123)).rejects.toThrow("Stop the gateway");
    await view.render("work");
    expect(portInput(view.container).disabled).toBe(false);
    await editPort(view.container, "49123");
    await view.click("gateway.savePort", "work");
    expect(await api.gatewayListenerSettings("work")).toEqual({ port: 49123, conflictingPorts: [] });
    await view.selectPool();
    await view.click("gateway.switchProfile", "work");
    expect(await api.gatewayStatus("default")).toMatchObject({ running: true, profileId: "default", port: active.port, token: active.token });
    expect(view.container.querySelector("input[name='bearerToken']")).toBeNull();
    expect(view.notices.some((notice) => notice.tone === "error" && notice.text.includes("Stop the gateway"))).toBe(true);
    await view.render("default");
    expect(portInput(view.container).value).toBe(String(active.port));
    expect(view.container.querySelector<HTMLInputElement>("input[name='bearerToken']")?.value).toBe(active.token);
    await view.click("gateway.stop", "default");
    expect(portInput(view.container).disabled).toBe(false);
    await view.render("work");
    expect(portInput(view.container).value).toBe("49123");
  });
});

describe("gateway pool deletion", () => {
  const dialogAction = async (key: string) => {
    const dialog = document.querySelector<HTMLElement>("[role='dialog']")!;
    const button = [...dialog.querySelectorAll<HTMLButtonElement>("button")].find((candidate) => candidate.textContent === i18n.t(key))!;
    await act(async () => { button.click(); });
  };

  it("cancels without discarding the edited saved pool", async () => {
    const api = createMockApi();
    await api.saveGatewayPool(pool("default"));
    const view = await mount(api);
    await view.selectPool();
    await view.editModel("omp-switch/unsaved");
    await view.click("gateway.deletePool", "default");
    await dialogAction("common.cancel");
    expect(document.querySelector("[role='dialog']")).toBeNull();
    expect(view.model()).toBe("omp-switch/unsaved");
    expect(await api.listGatewayPools("default")).toEqual([pool("default")]);
    expect(view.notices).toEqual([]);
  });

  it("deletes only the selected saved pool, retaining other pools and shared credentials", async () => {
    const api = createMockApi();
    const other = { ...pool("default"), id: "other", virtualModel: "omp-switch/other" };
    await api.saveGatewayPool(pool("default"));
    await api.saveGatewayPool(other);
    await api.saveGatewayPool(pool("work"));
    const credentials = new Map([["test", "shared-secret"]]);
    api.secretStatus = async (id) => ({ exists: credentials.has(id), label: "Shared", masked: "••••" });
    api.secretDelete = async (id) => ({ deleted: credentials.delete(id), references: [] });
    const view = await mount(api);
    await view.selectPool();
    await view.click("gateway.deletePool", "default");
    await dialogAction("gateway.deletePool");
    expect(await api.listGatewayPools("default")).toEqual([other]);
    expect(await api.listGatewayPools("work")).toEqual([pool("work")]);
    expect((await api.secretStatus("test")).exists).toBe(true);
    expect(credentials.get("test")).toBe("shared-secret");
    expect(view.model()).toBeUndefined();
    expect(view.container.querySelectorAll(".module-list-row")).toHaveLength(1);
    await view.selectPool();
    expect(view.model()).toBe("omp-switch/other");
  });

  it("leaves the last-pool listener running and keeps its independent port until explicitly stopped", async () => {
    const api = createMockApi();
    await api.saveGatewayPool(pool("default"));
    await api.setGatewayPort("default", 49123);
    await api.startGateway("default");
    const view = await mount(api);
    await view.selectPool();
    await view.click("gateway.deletePool", "default");
    await dialogAction("gateway.deletePool");
    expect(view.container.textContent).toContain(i18n.t("gateway.empty"));
    expect(view.container.querySelector(".gateway-editor")).toBeNull();
    expect(await api.listGatewayPools("default")).toEqual([]);
    expect(await api.gatewayStatus("default")).toMatchObject({ running: true, profileId: "default", port: 49123, upstreams: [] });
    expect(await api.gatewayHealth("default")).toEqual({});
    expect(view.container.querySelector<HTMLInputElement>("input[name='listenerPort']")?.value).toBe("49123");
    await view.click("gateway.stop", "default");
    expect((await api.gatewayStatus("default")).running).toBe(false);
    expect((await api.gatewayListenerSettings("default")).port).toBe(49123);
  });

  it("preserves the draft and saved pool when deletion fails and never reports success", async () => {
    const api = createMockApi();
    await api.saveGatewayPool(pool("default"));
    api.deleteGatewayPool = async () => { throw new Error("Delete persistence failed"); };
    const view = await mount(api);
    await view.selectPool();
    await view.editModel("omp-switch/keep-draft");
    await view.click("gateway.deletePool", "default");
    await dialogAction("gateway.deletePool");
    expect(view.model()).toBe("omp-switch/keep-draft");
    expect(await api.listGatewayPools("default")).toEqual([pool("default")]);
    expect(view.notices).toEqual([{ tone: "error", text: "Delete persistence failed" }]);
    await dialogAction("common.cancel");
    await view.save();
    expect((await api.listGatewayPools("default"))[0].virtualModel).toBe("omp-switch/keep-draft");
  });

  it("binds a delayed deletion to its captured Profile without clearing the new Profile draft", async () => {
    const api = createMockApi();
    await api.saveGatewayPool(pool("default"));
    await api.saveGatewayPool(pool("work"));
    const remove = api.deleteGatewayPool;
    const gate = new EventEmitter();
    api.deleteGatewayPool = async (profile, id) => { await once(gate, "finish"); await remove(profile, id); };
    const view = await mount(api);
    await view.selectPool();
    await view.click("gateway.deletePool", "default");
    await dialogAction("gateway.deletePool");
    expect([...view.container.querySelectorAll<HTMLButtonElement>("button")].find((button) => button.textContent === i18n.t("common.save"))?.disabled).toBe(true);
    await view.render("work");
    await view.selectPool();
    await view.editModel("omp-switch/work-draft");
    await act(async () => { gate.emit("finish"); });
    expect(view.model()).toBe("omp-switch/work-draft");
    expect(await api.listGatewayPools("default")).toEqual([]);
    expect(await api.listGatewayPools("work")).toEqual([pool("work")]);
    await view.save();
    expect((await api.listGatewayPools("work"))[0].virtualModel).toBe("omp-switch/work-draft");
  });
});

describe("gateway upstream enabled draft", () => {
  const toggle = async (container: HTMLElement, index: number) => {
    const input = container.querySelector<HTMLInputElement>(`input[name='upstreams.${index}.enabled']`)!;
    input.focus();
    await act(async () => { input.click(); });
    expect(document.activeElement).toBe(input);
    return input;
  };
  const probeButtons = (container: HTMLElement) => [...container.querySelectorAll<HTMLButtonElement>(`button[aria-label='${i18n.t("gateway.probeUpstream")}']`)];

  it("keeps stable row identity and persists an all-disabled draft only on save, then applies a re-enabled draft on Start", async () => {
    const api = createMockApi();
    await api.saveGatewayPool(pool("default"));
    const view = await mount(api);
    await view.selectPool();
    const input = await toggle(view.container, 0);
    expect(input.checked).toBe(false);
    expect(input.parentElement?.textContent).toContain(i18n.t("gateway.disabled"));
    expect((await api.listGatewayPools("default"))[0].upstreams[0].enabled).toBe(true);
    expect(probeButtons(view.container)[0].disabled).toBe(true);
    await view.save();
    expect((await api.listGatewayPools("default"))[0].upstreams[0]).toMatchObject({ id: "one", enabled: false });
    expect(probeButtons(view.container)[0].disabled).toBe(true);
    const batch = view.container.querySelector<HTMLButtonElement>(`button[title='${i18n.t("gateway.probeAll")}']`)!;
    expect(batch.disabled).toBe(true);
    expect(view.container.textContent).toContain(i18n.t("gateway.probeNoneEnabled"));
    await view.click("gateway.start", "default");
    expect((await api.gatewayStatus("default")).running).toBe(true);
    await toggle(view.container, 0);
    expect((await api.listGatewayPools("default"))[0].upstreams[0].enabled).toBe(false);
    await view.click("gateway.start", "default");
    expect((await api.listGatewayPools("default"))[0].upstreams[0]).toMatchObject({ id: "one", enabled: true });
    expect(probeButtons(view.container)[0].disabled).toBe(false);
  });

  it("disables a saved disabled upstream's single probe and excludes it from batch results", async () => {
    const api = createMockApi();
    const saved = pool("default");
    saved.upstreams.push({ ...saved.upstreams[0], id: "two", enabled: false });
    await api.saveGatewayPool(saved);
    api.probeGatewayUpstream = async (_profile, _pool, id) => { if (id === "two") throw new Error("Disabled upstream was probed"); return { ok: true, status: 200, latencyMs: 29 }; };
    const view = await mount(api);
    await view.selectPool();
    expect(probeButtons(view.container).map((button) => button.disabled)).toEqual([false, true]);
    await act(async () => { view.container.querySelector<HTMLButtonElement>(`button[title='${i18n.t("gateway.probeAll")}']`)!.click(); });
    expect(view.notices).toContainEqual({ tone: "success", text: i18n.t("gateway.probeAllFinished", { pool: "shared", count: 1, ok: 1, failed: 0 }) });
    expect([...view.container.querySelectorAll(".health-badge")].map((badge) => badge.textContent)).toEqual(["29ms", i18n.t("gateway.untested")]);
  });
});
