import { describe, expect, test } from "bun:test";
import memoryExtension from "../extensions/user-memory";
import {
  convertDraftToRememberParams,
  parseCommaList,
  previewMemoryWizardDraft,
  validateMemoryWizardDraft,
  type MemoryWizardDraft,
} from "../extensions/user-memory/wizard";

describe("memory wizard draft validation", () => {
  test("normalizes tags and converts expiry/sensitivity to remember params", () => {
    const draft: MemoryWizardDraft = {
      content: "  User prefers Bun for TypeScript project checks.  ",
      category: "preference",
      subcategory: "tooling",
      sensitivity: "general",
      expiry: "7d",
      tags: [" Bun", "#Typescript", "bun"],
    };

    expect(validateMemoryWizardDraft(draft)).toEqual({
      ok: true,
      draft: {
        content: "User prefers Bun for TypeScript project checks.",
        category: "preference",
        subcategory: "tooling",
        sensitivity: "general",
        expiry: "7d",
        tags: ["bun", "typescript"],
        confidence: 1,
      },
    });

    expect(convertDraftToRememberParams(draft)).toEqual({
      content: "User prefers Bun for TypeScript project checks.",
      category: "preference",
      subcategory: "tooling",
      tags: ["bun", "typescript"],
      confidence: 1,
      sensitivity: "general",
      expiry_tier: "7d",
      temporal: true,
    });
  });

  test("rejects blank content and pinned profile memories without profile tags", () => {
    const result = validateMemoryWizardDraft({
      content: " ",
      category: "fact",
      pinnedProfile: true,
      tags: ["profile"],
    });

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.errors).toContain("content is required");
      expect(result.errors.join("\n")).toContain("profile tag");
    }
  });

  test("accepts profile-style memories when an existing pinned tag is present", () => {
    const params = convertDraftToRememberParams({
      content: "User's birthday is 1990-01-01.",
      category: "fact",
      sensitivity: "baseline",
      pinnedProfile: true,
      tags: ["birthday", "profile"],
    });

    expect(params.tags).toEqual(["birthday", "profile"]);
    expect(params.sensitivity).toBe("baseline");
  });

  test("parses comma-separated entity/tag input", () => {
    expect(parseCommaList(" Alex, #Keylime, alex ,, pi ")).toEqual(["alex", "keylime", "pi"]);
  });

  test("renders a save preview", () => {
    expect(previewMemoryWizardDraft({
      content: "User is working on Keylime.",
      category: "context",
      tags: ["keylime"],
    })).toContain("Memory preview\ncategory: context\ncontent: User is working on Keylime.");
  });
});

describe("memory wizard command registration", () => {
  test("user-memory extension registers /memory-wizard", () => {
    const commands: Array<{ name: string; description?: string }> = [];
    const tools: Array<{ name: string }> = [];
    const contextProviders: string[] = [];
    const pi = {
      registerCommand: (name: string, options: { description?: string }) => commands.push({ name, description: options.description }),
      registerTool: (tool: { name: string }) => tools.push(tool),
      on: () => undefined,
    } as any;

    memoryExtension(pi);

    expect(commands).toContainEqual({
      name: "memory-wizard",
      description: "Interactively create a structured user memory",
    });
    expect(tools.some(tool => tool.name === "remember")).toBe(true);
    expect(contextProviders.length).toBe(0);
  });
});
