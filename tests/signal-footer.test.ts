import { describe, expect, test } from "bun:test";
import { buildSignalParts } from "../extensions/signal-footer";

describe("signal footer formatting", () => {
  test("shows context pressure first and summarizes cache reuse intelligibly", () => {
    const statuses = new Map([
      ["memory-manager", "coding:core+repo+coding+project+safety+memory-lite"],
      ["cache-guard", "cache:98% (88.6M↩/90.4Min)"],
      ["context-health", "[███████░░░] 73% 146k/200k"],
    ]);
    expect(buildSignalParts(statuses)).toEqual([
      "ctx:73% pressure (146k/200k)",
      "cache:98% reused",
      "mem:coding:core+repo+coding+project+safety+memory-lite",
    ]);
  });

  test("does not duplicate labels and keeps unavailable pressure visible", () => {
    const statuses = new Map([
      ["context-health", "ctx: —"],
      ["cache-guard", "cache: —"],
    ]);
    expect(buildSignalParts(statuses)).toEqual(["ctx:—", "cache:—"]);
  });
});
