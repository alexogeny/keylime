import { afterEach, describe, expect, mock, test } from "bun:test";
import { classifyIntent, setCurrentRoute } from "../extensions/shared/intent";

mock.module("@earendil-works/pi-coding-agent", () => ({
  isToolCallEventType: (name: string, event: any) => event.toolName === name,
}));

const {
  default: dangerGuardExtension,
  codingModeBlockReasonForToolCall,
  looksLikeCodingModeBashMutation,
} = await import("../extensions/danger-guard");

function setCodingMode() {
  setCurrentRoute(classifyIntent("implement this code change"));
}

afterEach(() => {
  setCurrentRoute(classifyIntent("hello"));
});

describe("danger guard coding-mode hard enforcement", () => {
  test("blocks built-in read/write/edit when coding capability is active", () => {
    setCodingMode();

    expect(codingModeBlockReasonForToolCall("read", { path: "src/a.ts" })).toContain("built-in read");
    expect(codingModeBlockReasonForToolCall("write", { path: "src/a.ts" })).toContain("built-in write");
    expect(codingModeBlockReasonForToolCall("edit", { path: "src/a.ts" })).toContain("built-in edit");
  });

  test("does not block built-in read/write/edit outside coding mode", () => {
    setCurrentRoute(classifyIntent("hello"));

    expect(codingModeBlockReasonForToolCall("read", { path: "src/a.ts" })).toBeNull();
    expect(codingModeBlockReasonForToolCall("write", { path: "src/a.ts" })).toBeNull();
    expect(codingModeBlockReasonForToolCall("edit", { path: "src/a.ts" })).toBeNull();
  });

  test("detects bash file mutation forms banned in coding mode", () => {
    const commands = [
      "cat > file.ts",
      "cat <<EOF > file.ts\ncontent\nEOF",
      "tee file.ts",
      "sed -i 's/a/b/' file.ts",
      "python -c \"open('file.ts', 'w').write('x')\"",
      "node -e \"require('fs').writeFileSync('file.ts', 'x')\"",
      "echo hi > file.ts",
      "printf hi >> file.ts",
      "touch file.ts",
      "mkdir src/generated",
      "rm file.ts",
      "cp a.ts b.ts",
      "mv a.ts b.ts",
      "perl -pi -e 's/a/b/' file.ts",
      "bun -e \"require('fs').writeFileSync('file.ts', 'x')\"",
      "deno eval \"Deno.writeTextFile('file.ts', 'x')\"",
      "bash -c 'echo hi > file.ts'",
    ];

    for (const command of commands) {
      expect(looksLikeCodingModeBashMutation(command)?.label).toBeString();
    }
  });

  test("allows read-only-looking bash commands in coding mode", () => {
    const commands = ["rg foo src", "ls -la", "cat file.ts", "echo hi", "grep foo file.ts", "tee /dev/null"];

    for (const command of commands) {
      expect(looksLikeCodingModeBashMutation(command)).toBeNull();
    }
  });

  test("blocks mutation-looking bash commands in coding mode", () => {
    setCodingMode();

    expect(codingModeBlockReasonForToolCall("bash", { command: "cat > file.ts" })).toContain("bash file mutation");
    expect(codingModeBlockReasonForToolCall("bash", { command: "rg foo src" })).toBeNull();
  });

  test("extension blocks coding-mode violations without confirmation", async () => {
    setCodingMode();
    const handlers: Record<string, any> = {};
    let confirmCalls = 0;
    dangerGuardExtension({
      on: (name: string, handler: any) => { handlers[name] = handler; },
      registerCommand: () => {},
    } as any);

    const result = await handlers.tool_call(
      { toolName: "bash", input: { command: "node -e \"require('fs').writeFileSync('file.ts', 'x')\"" } },
      {
        ui: { confirm: async () => { confirmCalls += 1; return true; } },
        sessionManager: { getEntries: () => [] },
      },
    );

    expect(result.block).toBe(true);
    expect(result.reason).toContain("coding mode blocks bash file mutation");
    expect(confirmCalls).toBe(0);
  });

  test("extension blocks built-in read/write/edit in coding mode without confirmation", async () => {
    setCodingMode();
    const handlers: Record<string, any> = {};
    let confirmCalls = 0;
    dangerGuardExtension({
      on: (name: string, handler: any) => { handlers[name] = handler; },
      registerCommand: () => {},
    } as any);

    for (const toolName of ["read", "write", "edit"]) {
      const result = await handlers.tool_call(
        { toolName, input: { path: "src/a.ts" } },
        {
          ui: { confirm: async () => { confirmCalls += 1; return true; } },
          sessionManager: { getEntries: () => [] },
        },
      );

      expect(result.block).toBe(true);
      expect(result.reason).toContain(`coding mode blocks built-in ${toolName}`);
    }

    expect(confirmCalls).toBe(0);
  });

  test("extension checks protected paths for create_directory", async () => {
    setCurrentRoute(classifyIntent("hello"));
    const handlers: Record<string, any> = {};
    let confirmCalls = 0;
    dangerGuardExtension({
      on: (name: string, handler: any) => { handlers[name] = handler; },
      registerCommand: () => {},
    } as any);

    const result = await handlers.tool_call(
      { toolName: "create_directory", input: { path: ".git/hooks/generated" } },
      {
        ui: { confirm: async () => { confirmCalls += 1; return false; } },
        sessionManager: { getEntries: () => [] },
      },
    );

    expect(result.block).toBe(true);
    expect(result.reason).toContain("protected path");
    expect(confirmCalls).toBe(1);
  });
});
