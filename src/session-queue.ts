export interface SessionLifecycle {
  abort(): Promise<void>;
  dispose(): void;
}

/** Owns the serial work and lifetime of one agent session. */
export class SessionQueue {
  private tail: Promise<unknown> = Promise.resolve();
  private closed = false;
  private closing?: Promise<void>;
  private cancelActive?: () => Promise<void>;

  private readonly session: SessionLifecycle;

  constructor(session: SessionLifecycle) {
    this.session = session;
  }

  run<T>(task: (signal: AbortSignal) => Promise<T>, signal?: AbortSignal): Promise<T> {
    if (this.closed) return Promise.reject(new Error("Session is closed"));

    const run = this.tail.then(async () => {
      if (this.closed) throw new Error("Session is closed");
      signal?.throwIfAborted();

      const controller = new AbortController();
      let aborting: Promise<void> | undefined;
      const cancel = (reason: unknown) => {
        controller.abort(reason);
        // Keep the queue occupied until abort has settled as well as the task.
        aborting ??= Promise.resolve().then(() => this.session.abort()).catch(() => {});
        return aborting;
      };
      const onAbort = () => { void cancel(signal?.reason); };
      this.cancelActive = () => cancel(new Error("Session is closed"));
      signal?.addEventListener("abort", onAbort, { once: true });
      try {
        const result = await task(controller.signal);
        controller.signal.throwIfAborted();
        if (this.closed) throw new Error("Session is closed");
        return result;
      } finally {
        signal?.removeEventListener("abort", onAbort);
        this.cancelActive = undefined;
        await aborting;
      }
    });
    this.tail = run.then(() => undefined, () => undefined);
    return run;
  }

  close(): Promise<void> {
    if (this.closing) return this.closing;
    this.closed = true;
    void this.cancelActive?.();
    this.closing = this.tail.then(() => { this.session.dispose(); });
    return this.closing;
  }
}
