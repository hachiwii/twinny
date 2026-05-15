export class SerialQueue {
  private tail: Promise<void> = Promise.resolve();
  private active = false;
  private depthValue = 0;

  get isActive(): boolean {
    return this.active;
  }

  get depth(): number {
    return this.depthValue;
  }

  enqueue<T>(task: () => Promise<T>): Promise<T> {
    this.depthValue += 1;
    const run = async (): Promise<T> => {
      this.active = true;
      try {
        return await task();
      } finally {
        this.depthValue -= 1;
        this.active = false;
      }
    };
    const next = this.tail.then(run, run);
    this.tail = next.then(
      () => undefined,
      () => undefined
    );
    return next;
  }
}
