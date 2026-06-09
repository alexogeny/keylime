import { existsSync, readFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { afterEach, describe, expect, mock, test } from "bun:test";
import { classifyIntent, setCurrentRoute } from "../extensions/shared/intent";

mock.module("@earendil-works/pi-coding-agent", () => ({
  isToolCallEventType: (name: string, event: any) => event.toolName === name,
}));

const {
  default: dangerGuardExtension,
  codingModeBlockReasonForToolCall,
  looksLikeCodingModeBashMutation,
  looksLikeCodingModeBashNativeInspection,
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
      "ln -s a.ts b.ts",
      "truncate -s 0 file.ts",
      "dd if=/dev/zero of=file.ts bs=1 count=1",
      "perl -pi -e 's/a/b/' file.ts",
      "bun -e \"require('fs').writeFileSync('file.ts', 'x')\"",
      "deno eval \"Deno.writeTextFile('file.ts', 'x')\"",
      "bash -c 'echo hi > file.ts'",
      "git add -A",
      "git commit -m checkpoint",
      "git reset --hard HEAD~1",
      "git restore src/file.ts",
      "git clean -fd",
      "git push origin main",
      "true > file.ts",
      ": > file.ts",
      "grep foo src > results.txt",
      "bun test 2> errors.log",
    ];

    for (const command of commands) {
      expect(looksLikeCodingModeBashMutation(command)?.label).toBeString();
    }
  });

  test("detects native repository inspection forms banned in coding mode", () => {
    const commands = [
      "find . -name '*.ts'",
      "grep foo file.ts",
      "rg foo src",
      "jq '.memories' data.json",
      "ls -la",
      "cat file.ts",
      "head -20 file.ts",
      "tail -20 file.ts",
      "wc -l file.ts",
      "awk '{print $1}' file.ts",
      "cut -d: -f1 file.ts",
      "sort file.ts",
      "uniq file.ts",
      "tree .",
      "stat file.ts",
      "file file.ts",
      "strings binary.bin",
      "xxd file.ts",
      "diff a.ts b.ts",
      "printf hi",
      "echo hi",
      "cat file.ts | grep foo",
    ];

    for (const command of commands) {
      expect(looksLikeCodingModeBashNativeInspection(command)?.label).toContain("use list_files/inspect_text_matches/inspect_lines");
    }
  });

  test("logs when deterministic fallback catches a classifier miss", () => {
    setCodingMode();
    const logPath = join(process.cwd(), ".pi", "safety-fallbacks.ndjson");
    rmSync(logPath, { force: true });

    expect(codingModeBlockReasonForToolCall("bash", { command: "ls" })).toContain("native repository inspection");

    expect(existsSync(logPath)).toBe(true);
    const last = readFileSync(logPath, "utf8").trim().split("\n").at(-1)!;
    expect(JSON.parse(last)).toMatchObject({ kind: "coding_bash_native_inspection", toolName: "bash" });
    rmSync(logPath, { force: true });
  });

  test("blocks broad shell fallback commands even when they do not directly mutate", () => {
    const commands = [
      "true",
      "pwd",
      "which bun",
      "git status --short",
      "git diff",
      "curl https://example.com",
      "python --version",
      "node --version",
      "bun test",
      "npm test",
      "make test",
      "vim file.ts",
    ];

    for (const command of commands) {
      expect(looksLikeCodingModeBashNativeInspection(command)?.label).toMatch(/shell fallback|repository inspection/);
    }
  });

  test("blocks bash native fallbacks outside coding mode too", () => {
    setCurrentRoute(classifyIntent("research latest sources"));

    expect(codingModeBlockReasonForToolCall("bash", { command: "printf hi" })).toContain("native repository inspection");
    expect(codingModeBlockReasonForToolCall("bash", { command: "python - <<'PY'\nprint(1)\nPY" })).toContain("file mutation");
  });

  test("blocks mutation-looking bash commands in coding mode", () => {
    setCodingMode();

    expect(codingModeBlockReasonForToolCall("bash", { command: "cat > file.ts" })).toContain("bash file mutation");
    expect(codingModeBlockReasonForToolCall("bash", { command: "rg foo src" })).toContain("native repository inspection");
    expect(codingModeBlockReasonForToolCall("bash", { command: "echo hi" })).toContain("native repository inspection");
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
    expect(result.reason).toContain("blocks bash file mutation");
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
