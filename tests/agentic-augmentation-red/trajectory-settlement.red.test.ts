import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import trajectoryEvalExtension from "../../extensions/trajectory-eval";
import { createPiRecorder } from "./helpers";

let previous: string | undefined;
beforeEach(() => { previous = process.env.KEYLIME_ENABLE_TRAJECTORY; process.env.KEYLIME_ENABLE_TRAJECTORY = "1"; });
afterEach(() => { if (previous === undefined) delete process.env.KEYLIME_ENABLE_TRAJECTORY; else process.env.KEYLIME_ENABLE_TRAJECTORY = previous; });

async function setup() {
  const recorder = createPiRecorder();
  trajectoryEvalExtension(recorder.pi);
  await recorder.emit("session_start", { reason: "new" });
  await recorder.emit("before_agent_start", {});
  return recorder;
}

function reports(entries: any[]) { return entries.filter(entry => entry.customType === "trajectory-eval").map(entry => entry.data); }

describe("RED AA-011..017: trajectory evaluation closes at agent_settled", () => {
  test("AA-011 does not finalize a task at an intermediate assistant message", async () => {
    const recorder = await setup();
    await recorder.emit("message_end", { message: { role: "assistant", content: [{ type: "text", text: "I will inspect the file." }] } });
    expect(reports(recorder.entries)).toHaveLength(0);
  });

  test("AA-012 finalizes exactly once when the agent is settled", async () => {
    const recorder = await setup();
    await recorder.emit("message_end", { message: { role: "assistant", content: [{ type: "text", text: "Done." }] } });
    await recorder.emit("agent_settled", {});
    await recorder.emit("agent_settled", {});
    expect(reports(recorder.entries)).toHaveLength(1);
    expect(reports(recorder.entries)[0].finalizationEvent).toBe("agent_settled");
  });

  test("AA-013 produces one report across several tool-calling turns", async () => {
    const recorder = await setup();
    await recorder.emit("tool_call", { toolName: "code_search", input: { query: "symbol" } });
    await recorder.emit("message_end", { message: { role: "assistant", content: [{ type: "text", text: "Searching." }] } });
    await recorder.emit("tool_result", { toolName: "code_search", isError: false });
    await recorder.emit("message_end", { message: { role: "assistant", content: [{ type: "text", text: "Found it." }] } });
    await recorder.emit("agent_settled", {});
    expect(reports(recorder.entries)).toHaveLength(1);
  });

  test("AA-014 recognizes Keylime inspection tools as concrete evidence", async () => {
    const recorder = await setup();
    await recorder.emit("tool_call", { toolName: "inspect_lines", input: { path: "src/a.ts" } });
    await recorder.emit("tool_result", { toolName: "inspect_lines", isError: false, details: { contextObjectId: "object-1" } });
    await recorder.emit("message_end", { message: { role: "assistant", content: [{ type: "text", text: "Evidence collected." }] } });
    await recorder.emit("agent_settled", {});
    expect(reports(recorder.entries)[0].issues).not.toContain("low_evidence");
  });

  test("AA-015 does not penalize a discussion-only response for no tool use", async () => {
    const recorder = await setup();
    await recorder.emit("message_end", { message: { role: "assistant", content: [{ type: "text", text: "Here is the requested explanation." }] } });
    await recorder.emit("agent_settled", {});
    const report = reports(recorder.entries)[0];
    expect(report.outcome).toBe("read_only_complete");
    expect(report.issues).not.toContain("no_tool_use");
  });

  test("AA-016 records final verification rather than merely counting tool errors", async () => {
    const recorder = await setup();
    await recorder.emit("tool_result", { toolName: "apply_code_replacements", isError: false, details: { changedPaths: ["src/a.ts"] } });
    await recorder.emit("tool_result", { toolName: "run_checks", isError: true, details: { results: [{ command: "bun", args: ["test"], ok: false }] } });
    await recorder.emit("tool_result", { toolName: "run_checks", isError: false, details: { results: [{ command: "bun", args: ["test"], ok: true }] } });
    await recorder.emit("message_end", { message: { role: "assistant", content: [{ type: "text", text: "Fixed and verified." }] } });
    await recorder.emit("agent_settled", {});
    expect(reports(recorder.entries)[0]).toMatchObject({ outcome: "verified", recoveredFailures: 1 });
  });

  test("AA-017 reports a mutation without verification as unverified", async () => {
    const recorder = await setup();
    await recorder.emit("tool_result", { toolName: "create_file", isError: false, details: { changedPaths: ["src/new.ts"] } });
    await recorder.emit("message_end", { message: { role: "assistant", content: [{ type: "text", text: "Created." }] } });
    await recorder.emit("agent_settled", {});
    expect(reports(recorder.entries)[0].outcome).toBe("unverified_mutation");
  });
});
