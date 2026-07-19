import { describe, expect, test } from "bun:test";
import {
  createContextObject,
  selectContextObjectText,
  verifyContextObjectContent,
} from "../extensions/shared/context-objects";

describe("context object contracts", () => {
  const content = ["alpha", "beta failure", "gamma detail", "omega"].join("\n");

  test("creates immutable source metadata and verifies the content hash", () => {
    const object = createContextObject({
      id: "result-1",
      kind: "test_run",
      sourceTool: "run_checks",
      toolCallId: "call-1",
      content,
      summary: "one failing check",
      retention: "pinned",
      sections: { failure: { startLine: 2, endLine: 3 } },
    });

    expect(object).toMatchObject({
      version: 1,
      id: "result-1",
      kind: "test_run",
      sourceTool: "run_checks",
      toolCallId: "call-1",
      originalChars: content.length,
      retention: "pinned",
    });
    expect(object.contentHash).toMatch(/^[a-f0-9]{64}$/);
    expect(verifyContextObjectContent(object, content)).toBe(true);
    expect(verifyContextObjectContent(object, `${content}!`)).toBe(false);
  });

  test("selects a named section with original line numbers", () => {
    const object = createContextObject({
      id: "result-2",
      kind: "test_run",
      sourceTool: "run_checks",
      content,
      summary: "one failing check",
      retention: "foldable",
      sections: { failure: { startLine: 2, endLine: 3 } },
    });

    expect(selectContextObjectText(object, content, { section: "failure" })).toBe(
      "2 | beta failure\n3 | gamma detail",
    );
  });

  test("rejects unknown sections and out-of-range selectors", () => {
    const object = createContextObject({
      id: "result-3",
      kind: "generic",
      sourceTool: "unknown",
      content,
      summary: "generic",
      retention: "reconstructable",
    });

    expect(() => selectContextObjectText(object, content, { section: "missing" })).toThrow("Unknown context object section");
    expect(() => selectContextObjectText(object, content, { lines: { start: 0, end: 2 } })).toThrow("Line range");
    expect(() => selectContextObjectText(object, `${content}!`, { lines: { start: 1, end: 1 } })).toThrow("hash mismatch");
  });
});
