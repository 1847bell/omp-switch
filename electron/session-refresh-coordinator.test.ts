import { describe, expect, it } from "vitest";
import { SessionRefreshCoordinator } from "./session-refresh-coordinator";

function deferred<T>(): { promise: Promise<T>; resolve(value: T): void } {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((next) => { resolve = next; });
  return { promise, resolve };
}

describe("SessionRefreshCoordinator", () => {
  it("merges concurrent normal refreshes into one task", async () => {
    const coordinator = new SessionRefreshCoordinator<string>();
    const pending = deferred<string>();
    let starts = 0;
    const start = (force: boolean) => {
      starts += 1;
      expect(force).toBe(false);
      return { response: pending.promise, complete: pending.promise, completeIsForced: false };
    };

    const first = coordinator.run("default", false, start);
    const second = coordinator.run("default", false, start);
    expect(starts).toBe(1);
    pending.resolve("indexed");
    await expect(first).resolves.toBe("indexed");
    await expect(second).resolves.toBe("indexed");
  });

  it("runs a requested forced rebuild after an active incremental refresh", async () => {
    const coordinator = new SessionRefreshCoordinator<string>();
    const normal = deferred<string>();
    const forced = deferred<string>();
    const starts: boolean[] = [];
    const start = (force: boolean) => {
      starts.push(force);
      const promise = force ? forced.promise : normal.promise;
      return { response: promise, complete: promise, completeIsForced: force };
    };

    const incremental = coordinator.run("default", false, start);
    const rebuild = coordinator.run("default", true, start);
    expect(starts).toEqual([false]);
    normal.resolve("incremental");
    await expect(incremental).resolves.toBe("incremental");
    await Promise.resolve();
    expect(starts).toEqual([false, true]);
    forced.resolve("rebuilt");
    await expect(rebuild).resolves.toBe("rebuilt");
  });

  it("does not queue a second rebuild behind an initial full index", async () => {
    const coordinator = new SessionRefreshCoordinator<string>();
    const quick = deferred<string>();
    const complete = deferred<string>();
    let starts = 0;
    const start = () => {
      starts += 1;
      return { response: quick.promise, complete: complete.promise, completeIsForced: true };
    };

    const first = coordinator.run("default", false, start);
    const rebuild = coordinator.run("default", true, start);
    quick.resolve("quick");
    complete.resolve("complete");
    await expect(first).resolves.toBe("quick");
    await expect(rebuild).resolves.toBe("complete");
    expect(starts).toBe(1);
  });

  it("waits for quick background completion and queued forced refresh before deleting", async () => {
    const coordinator = new SessionRefreshCoordinator<string>();
    const background = deferred<string>();
    const forced = deferred<string>();
    const mutation = deferred<string>();
    const entered = deferred<void>();
    const events: string[] = [];
    const start = (force: boolean) => {
      events.push(force ? "forced" : "quick");
      return { response: Promise.resolve("quick"), complete: force ? forced.promise : background.promise, completeIsForced: force };
    };
    await coordinator.run("default", false, start);
    const rebuild = coordinator.run("default", true, start);
    const deletion = coordinator.runExclusive("default", async () => {
      events.push("delete");
      entered.resolve();
      return mutation.promise;
    });
    const later = coordinator.run("default", false, () => {
      events.push("later");
      return { response: Promise.resolve("fresh"), complete: Promise.resolve("fresh"), completeIsForced: false };
    });
    background.resolve("background");
    await background.promise;
    await Promise.resolve();
    expect(events).toEqual(["quick", "forced"]);
    forced.resolve("forced");
    await rebuild;
    await entered.promise;
    expect(events).toEqual(["quick", "forced", "delete"]);
    mutation.resolve("deleted");
    await expect(deletion).resolves.toBe("deleted");
    await expect(later).resolves.toBe("fresh");
    expect(events).toEqual(["quick", "forced", "delete", "later"]);
  });

  it("serializes mutations, releases failures and isolates profile queues", async () => {
    const coordinator = new SessionRefreshCoordinator<string>();
    const release = deferred<void>();
    const entered = deferred<void>();
    const events: string[] = [];
    const first = coordinator.runExclusive("default", async () => {
      entered.resolve();
      await release.promise;
      events.push("first");
      throw new Error("trash failed");
    });
    const failed = expect(first).rejects.toThrow("trash failed");
    const second = coordinator.runExclusive("default", async () => { events.push("second"); return 2; });
    await entered.promise;
    await expect(coordinator.runExclusive("work", async () => 3)).resolves.toBe(3);
    expect(events).toEqual([]);
    release.resolve();
    await failed;
    await expect(second).resolves.toBe(2);
    await expect(coordinator.run("default", false, () => ({ response: Promise.resolve("ok"), complete: Promise.resolve("ok"), completeIsForced: false }))).resolves.toBe("ok");
    expect(events).toEqual(["first", "second"]);
  });

  it("allows deletion after refresh failure", async () => {
    const coordinator = new SessionRefreshCoordinator<string>();
    const failure = Promise.reject<string>(new Error("scan failed"));
    const refresh = coordinator.run("default", false, () => ({ response: failure, complete: failure, completeIsForced: false }));
    const rejected = expect(refresh).rejects.toThrow("scan failed");
    const deletion = coordinator.runExclusive("default", async () => "deleted");
    await rejected;
    await expect(deletion).resolves.toBe("deleted");
  });
});
