import { describe, expect, test } from "bun:test";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  createContextObject,
  selectContextObjectText,
  verifyContextObjectContent,
} from "../extensions/shared/context-objects";
import contextObjectStoreExtension, {
  cleanupContextObjects,
  readStoredContextObject,
  storeContextObject,
} from "../extensions/context-object-store";

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

  test("stores atomically and recovers a verified named section", async () => {
    const cwd = await mkdtemp(join(tmpdir(), "context-object-store-"));
    try {
      const stored = await storeContextObject(cwd, {
        id: "stored-1",
        kind: "test_run",
        sourceTool: "run_checks",
        content,
        summary: "failure",
        retention: "pinned",
        sections: { failure: { startLine: 2, endLine: 3 } },
      });
      const recovered = await readStoredContextObject(cwd, "stored-1");
      expect(recovered.object.contentHash).toBe(stored.object.contentHash);
      expect(selectContextObjectText(recovered.object, recovered.content, { section: "failure" })).toContain("2 | beta failure");
      const manifest = JSON.parse(await readFile(join(cwd, ".pi", "context-objects", "index.json"), "utf8"));
      expect(manifest[0]).not.toHaveProperty("content");
    } finally {
      await rm(cwd, { recursive: true, force: true });
    }
  });

  test("rejects traversal ids and tampered payloads", async () => {
    const cwd = await mkdtemp(join(tmpdir(), "context-object-tamper-"));
    try {
      await expect(readStoredContextObject(cwd, "../../etc/passwd")).rejects.toThrow("Invalid context object id");
      const stored = await storeContextObject(cwd, {
        id: "tamper-1",
        kind: "generic",
        sourceTool: "unknown",
        content,
        summary: "generic",
        retention: "reconstructable",
      });
      const payload = JSON.parse(await readFile(stored.path, "utf8"));
      payload.content += "tampered";
      await writeFile(stored.path, JSON.stringify(payload), "utf8");
      await expect(readStoredContextObject(cwd, "tamper-1")).rejects.toThrow("hash mismatch");
    } finally {
      await rm(cwd, { recursive: true, force: true });
    }
  });

  test("folds duplicate reconstructable payloads by source and content hash", async () => {
    const cwd = await mkdtemp(join(tmpdir(), "context-object-dedupe-"));
    try {
      const first = await storeContextObject(cwd, {
        id: "duplicate-1",
        kind: "file_read",
        sourceTool: "inspect_lines",
        content: "same file content",
        summary: "read",
        retention: "foldable",
      });
      const second = await storeContextObject(cwd, {
        id: "duplicate-2",
        kind: "file_read",
        sourceTool: "inspect_lines",
        content: "same file content",
        summary: "read again",
        retention: "foldable",
      });
      expect(second.object.id).toBe(first.object.id);
      expect(second.deduplicated).toBe(true);
      const manifest = JSON.parse(await readFile(join(cwd, ".pi", "context-objects", "index.json"), "utf8"));
      expect(manifest).toHaveLength(1);
    } finally {
      await rm(cwd, { recursive: true, force: true });
    }
  });

  test("cleanup retains pinned objects and removes expired reconstructable objects", async () => {
    const cwd = await mkdtemp(join(tmpdir(), "context-object-cleanup-"));
    try {
      await storeContextObject(cwd, {
        id: "pinned-1",
        kind: "test_run",
        sourceTool: "run_checks",
        content: "important failure",
        summary: "failure",
        retention: "pinned",
        dependencies: ["evidence-1"],
        createdAt: "2026-01-01T00:00:00.000Z",
      });
      await storeContextObject(cwd, {
        id: "evidence-1",
        kind: "generic",
        sourceTool: "run_checks",
        content: "referenced evidence",
        summary: "evidence",
        retention: "reconstructable",
        createdAt: "2026-01-01T00:00:00.000Z",
      });
      await storeContextObject(cwd, {
        id: "stale-1",
        kind: "repo_search",
        sourceTool: "code_search",
        content: "reconstructable search",
        summary: "search",
        retention: "reconstructable",
        createdAt: "2026-01-01T00:00:00.000Z",
      });

      const result = await cleanupContextObjects(cwd, { maxAgeDays: 1, now: "2026-07-19T00:00:00.000Z" });
      expect(result.deleted).toEqual(["stale-1"]);
      expect(result.kept).toContain("pinned-1");
      expect(result.kept).toContain("evidence-1");
      await expect(readStoredContextObject(cwd, "pinned-1")).resolves.toBeDefined();
      await expect(readStoredContextObject(cwd, "evidence-1")).resolves.toBeDefined();
      await expect(readStoredContextObject(cwd, "stale-1")).rejects.toThrow();
    } finally {
      await rm(cwd, { recursive: true, force: true });
    }
  });

  test("inspect_context_object caps after selecting a section", async () => {
    const cwd = await mkdtemp(join(tmpdir(), "context-object-tool-"));
    const tools: Record<string, any> = {};
    contextObjectStoreExtension({ registerTool: (tool: any) => { tools[tool.name] = tool; } } as any);
    try {
      await storeContextObject(cwd, {
        id: "tool-1",
        kind: "test_run",
        sourceTool: "run_checks",
        content: `header\n${"failure detail ".repeat(80)}\ntail`,
        summary: "failure",
        retention: "pinned",
        sections: { failure: { startLine: 2, endLine: 2 } },
      });
      const result = await tools.inspect_context_object.execute("id", {
        object_id: "tool-1",
        section: "failure",
        max_chars: 120,
      }, undefined, undefined, { cwd });
      expect(result.content[0].text.length).toBeLessThan(220);
      expect(result.content[0].text).toContain("[truncated");
      expect(result.details).toMatchObject({ objectId: "tool-1", section: "failure" });
    } finally {
      await rm(cwd, { recursive: true, force: true });
    }
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
