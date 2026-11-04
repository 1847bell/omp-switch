// @vitest-environment jsdom
import { act } from "react";
import * as TooltipPrimitive from "@radix-ui/react-tooltip";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, describe, expect, it } from "vitest";
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
  const render = async (profileId: string) => {
    await act(async () => { root.render(<TooltipPrimitive.Provider><GatewayModule api={api} profileId={profileId} readOnly={false} onNotice={() => undefined} providers={[]} /></TooltipPrimitive.Provider>); });
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
  return { container, render, selectPool, editModel, save, model };
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
