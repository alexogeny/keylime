export class BoundedTopK<T> {
  private readonly heap: T[] = [];

  constructor(private readonly limit: number, private readonly compare: (a: T, b: T) => number) {}

  add(value: T): void {
    if (this.limit <= 0) return;
    if (this.heap.length < this.limit) {
      this.heap.push(value);
      this.siftUp(this.heap.length - 1);
      return;
    }
    if (this.compare(value, this.heap[0]) >= 0) return;
    this.heap[0] = value;
    this.siftDown(0);
  }

  values(): T[] {
    return [...this.heap].sort(this.compare);
  }

  get size(): number { return this.heap.length; }

  private siftUp(index: number): void {
    while (index > 0) {
      const parent = Math.floor((index - 1) / 2);
      if (this.compare(this.heap[index], this.heap[parent]) <= 0) break;
      [this.heap[index], this.heap[parent]] = [this.heap[parent], this.heap[index]];
      index = parent;
    }
  }

  private siftDown(index: number): void {
    for (;;) {
      const left = index * 2 + 1;
      const right = left + 1;
      let worst = index;
      if (left < this.heap.length && this.compare(this.heap[left], this.heap[worst]) > 0) worst = left;
      if (right < this.heap.length && this.compare(this.heap[right], this.heap[worst]) > 0) worst = right;
      if (worst === index) return;
      [this.heap[index], this.heap[worst]] = [this.heap[worst], this.heap[index]];
      index = worst;
    }
  }
}

export function boundedTopK<T>(values: Iterable<T>, limit: number, compare: (a: T, b: T) => number): T[] {
  const top = new BoundedTopK(limit, compare);
  for (const value of values) top.add(value);
  return top.values();
}
