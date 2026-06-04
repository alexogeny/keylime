import { describe, expect, test } from "bun:test";
import memoryExtension from "../extensions/user-memory";
import {
  convertDraftToRememberParams,
  parseCommaList,
  previewMemoryWizardDraft,
  previewProfileFactDrafts,
  validateMemoryWizardDraft,
  validateProfileFactValues,
  buildProfileFactDrafts,
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

describe("structured profile facts", () => {
  test("converts profile schema values into pinned baseline fact drafts", () => {
    const drafts = buildProfileFactDrafts({
      preferred_name: " Alex ",
      date_of_birth: "1990-01-02",
      height: "183 cm",
      employer: "Keylime Labs",
    });

    expect(drafts.map(draft => draft.content)).toEqual([
      "User's preferred name is Alex.",
      "User's date of birth is 1990-01-02.",
      "User's height is 183 cm.",
      "User's employer is Keylime Labs.",
    ]);
    expect(drafts[0].sensitivity).toBe("baseline");
    expect(drafts[0].tags).toContain("name");
    expect(drafts[1].dateRef).toBe("1990-01-02");
    expect(convertDraftToRememberParams(drafts[2])).toMatchObject({
      category: "fact",
      subcategory: "body",
      sensitivity: "baseline",
      tags: ["profile", "height", "measurements", "body"],
    });
  });

  test("validates date picker output as real YYYY-MM-DD dates", () => {
    expect(validateProfileFactValues({ date_of_birth: "1990-02-30" })).toContain("date of birth is not a valid calendar date");
    expect(validateProfileFactValues({ date_of_birth: "02/03/1990" })).toContain("date of birth must use YYYY-MM-DD");
    expect(validateProfileFactValues({ date_of_birth: "1990-02-03" })).toEqual([]);
  });

  test("previews multiple profile facts", () => {
    expect(previewProfileFactDrafts(buildProfileFactDrafts({ preferred_name: "Alex" }))).toBe("Profile fact preview\n- User's preferred name is Alex.");
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
      description: "Interactively create structured user memories",
    });
    expect(tools.some(tool => tool.name === "remember")).toBe(true);
    expect(contextProviders.length).toBe(0);
  });
});
