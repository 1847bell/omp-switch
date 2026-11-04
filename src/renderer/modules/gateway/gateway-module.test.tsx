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
