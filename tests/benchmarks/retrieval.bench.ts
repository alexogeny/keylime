import { performance } from "node:perf_hooks";
import { BM25Index, TFIDFStore, buildRetrievalIndex } from "../../extensions/shared/retrieval";

type Sample = { name: string; documents: number; buildMs: number; queryMedianMs: number; queryP95Ms: number };

function percentile(values: number[], fraction: number): number {
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[Math.min(sorted.length - 1, Math.floor(sorted.length * fraction))] ?? 0;
}

function documents(count: number) {
  return Array.from({ length: count }, (_, index) => ({
    id: `doc-${index}`,
    kind: index % 5 === 0 ? "policy" : "context",
    title: `Document ${index}`,
    body: `safe mutation routing retrieval token ${index % 97} category ${index % 13} implementation details`,
    tags: [`group-${index % 11}`],
  }));
}

function measure(name: string, count: number, build: (docs: ReturnType<typeof documents>) => (query: string) => unknown): Sample {
  const docs = documents(count);
  const buildStart = performance.now();
  const search = build(docs);
  const buildMs = performance.now() - buildStart;
  for (let index = 0; index < 10; index++) search(`routing token ${index}`);
  const timings: number[] = [];
  for (let index = 0; index < 50; index++) {
    const start = performance.now();
    search(`safe retrieval category ${index % 13}`);
    timings.push(performance.now() - start);
  }
  return {
    name,
    documents: count,
    buildMs,
    queryMedianMs: percentile(timings, 0.5),
    queryP95Ms: percentile(timings, 0.95),
  };
}

const samples: Sample[] = [];
for (const count of [100, 1_000, 10_000]) {
  samples.push(measure("BM25", count, docs => {
    const index = new BM25Index();
    for (const doc of docs) index.add(doc.id, `${doc.title} ${doc.body}`);
    return query => index.search(query, 10);
  }));
  samples.push(measure("TF-IDF", count, docs => {
    const index = new TFIDFStore();
    for (const doc of docs) index.add(doc.id, `${doc.title} ${doc.body}`);
    return query => index.search(query, 10);
  }));
  samples.push(measure("Hybrid", count, docs => {
    const index = buildRetrievalIndex(docs);
    return query => index.search(query, { topK: 10 });
  }));
}

console.table(samples.map(sample => ({
  ...sample,
  buildMs: sample.buildMs.toFixed(2),
  queryMedianMs: sample.queryMedianMs.toFixed(3),
  queryP95Ms: sample.queryP95Ms.toFixed(3),
})));
