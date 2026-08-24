export class CursorQueue<T> {
  private values: T[] = [];
  private head = 0;

  get length(): number {
    return this.values.length - this.head;
  }

  push(value: T): void {
    this.values.push(value);
  }

  shift(): T | undefined {
    if (this.head >= this.values.length) {
      return undefined;
    }
    const value = this.values[this.head];
    this.head += 1;
    this.compact();
    return value;
  }

  prepend(values: readonly T[]): void {
    if (values.length === 0) return;
    const remaining = this.values.slice(this.head);
    this.values = [...values, ...remaining];
    this.head = 0;
  }

  private compact(): void {
    if (this.head > 1_024 && this.head * 2 > this.values.length) {
      this.values = this.values.slice(this.head);
      this.head = 0;
    }
  }
}
