import { describe, expect, test } from "bun:test";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import boundedToolPipeline from "../extensions/bounded-tool-pipeline";
import { storeContextObject } from "../extensions/context-object-store";

async function registeredTool(): Promise<any> {
  let tool: any;
  await boundedToolPipeline({ registerTool: (value: any) => { tool = value; } } as any);
  return tool;
}

describe("bounded_tool_pipeline extension", () => {
  test("aggregates verified context-object rows through a fixed operation allowlist", async () => {
    const cwd = await mkdtemp(join(tmpdir(), "bounded-pipeline-"));
    await storeContextObject(cwd, {
      id: "research.rows", kind: "table", sourceTool: "extract_document_tables",
      content: JSON.stringify([{ sourceId: "source-1", score: 3, privateBody: "large page body" }, { sourceId: "source-2", score: 1 }]),
      summary: "research rows", retention: "reconstructable",
    });
    const tool = await registeredTool();
    const result = await tool.execute("call-1", {
      steps: [{ id: "research", operation: "context_object_rows", input: { object_id: "research.rows" } }],
      projection: { from: ["research"], select: ["sourceId", "score"], sort: [{ field: "score", direction: "desc" }], limit: 1 },
      budgets: { max_calls: 2, max_intermediate_chars: 2000, max_output_chars: 300, max_wall_clock_ms: 1000 },
    }, new AbortController().signal, undefined, { cwd });

    expect(JSON.parse(result.content[0].text).rows).toEqual([{ sourceId: "source-1", score: 3 }]);
    expect(result.details.success).toBe(true);
    expect(result.content[0].text).not.toContain("large page body");
  });

  test("rejects dynamic or mutation operation names before reading inputs", async () => {
    const tool = await registeredTool();
    const cwd = await mkdtemp(join(tmpdir(), "bounded-pipeline-"));
    await expect(tool.execute("call-2", {
      steps: [{ id: "bad", operation: "apply_code_replacements", input: {} }],
      projection: { from: ["bad"] },
      budgets: { max_calls: 1, max_intermediate_chars: 100, max_output_chars: 100, max_wall_clock_ms: 100 },
    }, new AbortController().signal, undefined, { cwd })).rejects.toThrow("Unsupported pipeline operation");
  });
});
