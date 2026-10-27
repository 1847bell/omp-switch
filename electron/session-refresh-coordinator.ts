export interface RefreshExecution<T> {
  response: Promise<T>;
  complete: Promise<T>;
  completeIsForced: boolean;
}

interface ActiveRefresh<T> {
  complete: Promise<T>;
  completeIsForced: boolean;
  forced?: Promise<T>;
}

/** Coalesces normal refreshes while preserving an explicit request for a forced rebuild. */
export class SessionRefreshCoordinator<T> {
  private readonly active = new Map<string, ActiveRefresh<T>>();
  private readonly exclusive = new Map<string, Promise<void>>();

  run(key: string, force: boolean, start: (force: boolean) => RefreshExecution<T>): Promise<T> {
    const barrier = this.exclusive.get(key);
    if (barrier) return barrier.then(() => this.run(key, force, start));
    const current = this.active.get(key);
    if (current) {
      if (force && !current.completeIsForced) return this.queueForced(key, current, start);
      return current.forced ?? current.complete;
    }

    let execution: RefreshExecution<T>;
    try {
      execution = start(force);
    } catch (error) {
      return Promise.reject(error);
    }
    const task: ActiveRefresh<T> = {
      complete: execution.complete,
      completeIsForced: execution.completeIsForced,
    };
    this.active.set(key, task);
    void execution.complete.then(
      () => { if (!task.forced && this.active.get(key) === task) this.active.delete(key); },
      () => { if (!task.forced && this.active.get(key) === task) this.active.delete(key); },
    );
    return execution.response;
  }

  runExclusive<R>(key: string, operation: () => Promise<R>): Promise<R> {
    const previous = this.exclusive.get(key) ?? Promise.resolve();
    const result = previous.then(async () => {
      const current = this.active.get(key);
      if (current) await (current.forced ?? current.complete).catch(() => undefined);
      return operation();
    });
    const settled = result.then(() => undefined, () => undefined);
    this.exclusive.set(key, settled);
    void settled.then(() => {
      if (this.exclusive.get(key) === settled) this.exclusive.delete(key);
    });
    return result;
  }

  private queueForced(key: string, task: ActiveRefresh<T>, start: (force: boolean) => RefreshExecution<T>): Promise<T> {
    if (!task.forced) {
      const startForced = (): Promise<T> => start(true).complete;
      task.forced = task.complete.then(startForced, startForced);
      void task.forced.then(
        () => { if (this.active.get(key) === task) this.active.delete(key); },
        () => { if (this.active.get(key) === task) this.active.delete(key); },
      );
    }
    return task.forced;
  }
}
