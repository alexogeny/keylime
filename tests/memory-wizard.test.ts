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
  buildProfilePatch,
  convertedUnitHint,
  previewProfilePatch,
  profilePatchToFactValues,
  sectionCompleteness,
  fitTuiLine,
  convertTimelineDraftToRememberParams,
  inferTimelineSubkindFromQuery,
  previewTimelineEntryDraft,
  validateTimelineEntryDraft,
  type MemoryWizardDraft,
} from "../extensions/user-memory/wizard";
import { shouldPromptToAddTimelineMemory, temporalContextForMemory } from "../extensions/user-memory";

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
      height: "183",
      employer: "Keylime Labs",
    });

    expect(drafts.map(draft => draft.content)).toEqual([
      "User's preferred name is Alex.",
      "User's date of birth is 1990-01-02.",
      "User's height is 183 cm (72.0 in).",
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

  test("supports structured select fields for gender and coffee preferences", () => {
    const drafts = buildProfileFactDrafts({
      gender: "nonbinary",
      coffee_temperature: "iced",
      coffee_style: "latte",
      coffee_milk: "oat milk",
      coffee_sweetener: "none",
      caffeine_timing: "before noon",
    });

    expect(drafts.map(draft => draft.content)).toEqual([
      "User's gender is nonbinary.",
      "User's coffee temperature is iced.",
      "User's coffee style is latte.",
      "User's coffee milk is oat milk.",
      "User's coffee sweetener is none.",
      "User's caffeine timing is before noon.",
    ]);
    expect(drafts.every(draft => draft.tags.includes("profile"))).toBe(true);
  });

  test("supports unit conversion hints, unit selectors, cup size, and section completeness", () => {
    expect(convertedUnitHint("32", "in")).toBe("81.3 cm");
    expect(convertedUnitHint("183", "cm")).toBe("72.0 in");
    expect(sectionCompleteness({ height: "183", waist: "32" }, "body")).toBeGreaterThan(0);

    const drafts = buildProfileFactDrafts({
      waist: "32",
      waist__unit: "in",
      cup_size: "34D",
    });

    expect(drafts.map(draft => draft.content)).toContain("User's waist is 32 in (81.3 cm).");
    expect(drafts.map(draft => draft.content)).toContain("User's cup / bra size is 34D.");
  });

  test("records athlete metrics with measured-at timestamps and units", () => {
    const drafts = buildProfileFactDrafts({
      measurement_datetime: "2026-06-04 07:30",
      vo2max: "55",
      resting_heart_rate: "48",
      hrv: "72",
      race_prs: "5K 19:30",
    });

    expect(drafts.map(draft => draft.content)).toEqual([
      "User's resting heart rate is 48 bpm measured at 2026-06-04 07:30.",
      "User's HRV is 72 ms measured at 2026-06-04 07:30.",
      "User's VO2 max is 55 ml/kg/min measured at 2026-06-04 07:30.",
      "User's race PRs is 5K 19:30 measured at 2026-06-04 07:30.",
    ]);
    expect(drafts.every(draft => draft.dateRef === "2026-06-04 07:30")).toBe(true);
    expect(drafts[0].sensitivity).toBe("context_gated");
    expect(drafts[2].tags).toContain("vo2max");
  });

  test("validates athlete metric timestamps and numeric fields", () => {
    expect(validateProfileFactValues({ measurement_datetime: "2026/06/04", vo2max: "55" })).toContain("metric measured at must use YYYY-MM-DD or YYYY-MM-DD HH:mm");
    expect(validateProfileFactValues({ vo2max: "high" })).toContain("vo2 max must be numeric");
  });

  test("truncates wizard lines to the terminal render width", () => {
    const line = `Coffee temperature: ${"either ".repeat(40)}`;
    expect(fitTuiLine(line, 20).length).toBeLessThanOrEqual(19);
  });

  test("hydrates stored profile facts back into wizard form values", () => {
    const values = profilePatchToFactValues({
      identity: { preferred_name: "Andie" },
      body: { height: { value: 158, unit: "cm" }, shoe_size: "AU 8" },
      mental: { communication_style: "direct" },
    });

    expect(values.preferred_name).toBe("Andie");
    expect(values.height).toBe("158");
    expect(values.height__unit).toBe("cm");
    expect(values.shoe_size).toBe("AU 8");
    expect(sectionCompleteness(values, "identity")).toBeGreaterThan(0);
    expect(buildProfilePatch(values).body.height).toEqual({ value: 158, unit: "cm", measured_at: undefined });
  });

  test("builds canonical structured profile patches without text memory rows", () => {
    const patch = buildProfilePatch({
      preferred_name: "Alex",
      height: "183",
      height__unit: "cm",
      coffee_milk: "oat milk",
      vo2max: "55",
      measurement_datetime: "2026-06-04 07:30",
    });

    expect(patch).toEqual({
      identity: { preferred_name: "Alex" },
      body: { height: { value: 183, unit: "cm" } },
      athlete: { vo2max: { value: 55, unit: "ml/kg/min", measured_at: "2026-06-04 07:30" } },
      preferences: { coffee_milk: "oat milk" },
    });
    expect(previewProfilePatch(patch)).toContain("- preferred_name: Alex");
  });

  test("previews multiple profile facts", () => {
    expect(previewProfileFactDrafts(buildProfileFactDrafts({ preferred_name: "Alex" }))).toBe("Profile fact preview\n- User's preferred name is Alex.");
  });
});

describe("timeline memory wizard and retrieval helpers", () => {
  test("converts employment timeline entries into searchable temporal memories", () => {
    const draft = {
      subkind: "employment" as const,
      label: "Airbus",
      data: { employer: "Airbus", title: "Systems Engineer", location: "Bristol" },
      interval: { start: { value: "2018-03", precision: "month" as const }, end: { value: "2020-09", precision: "month" as const }, current: false },
      tags: ["Work", "airbus"],
    };

    expect(validateTimelineEntryDraft(draft).ok).toBe(true);
    const params = convertTimelineDraftToRememberParams(draft);
    expect(params.category).toBe("fact");
    expect(params.subcategory).toBe("timeline/employment");
    expect(params.temporal).toBe(true);
    expect(params.date_ref).toBe("2018-03 → 2020-09");
    expect(params.timeline?.data.employer).toBe("Airbus");
    expect(params.tags).toContain("timeline");
    expect(previewTimelineEntryDraft(draft)).toContain("Timeline memory preview");
  });

  test("converts significant people and life events into linked timeline memories", () => {
    const person = convertTimelineDraftToRememberParams({
      subkind: "person",
      label: "Sam",
      data: { name: "Sam", relationship: "friend", place: "Brisbane", status: "current" },
      interval: { start: { value: "2020", precision: "year" }, current: true },
    });
    expect(person.subcategory).toBe("timeline/person");
    expect(person.timeline?.data.relationship).toBe("friend");
    expect(person.tags).toEqual(expect.arrayContaining(["person", "sam", "friend", "brisbane"]));

    const event = convertTimelineDraftToRememberParams({
      subkind: "life_event",
      label: "Moved to Brisbane",
      data: { event: "Moved to Brisbane", people: "Sam, Jo", places: "Brisbane, Pashen Street", type: "move" },
      interval: { start: { value: "2018", precision: "year" }, current: false },
      notes: "Important personal milestone",
    });
    expect(event.subcategory).toBe("timeline/life_event");
    expect(event.content).toContain("people: Sam, Jo");
    expect(event.content).toContain("places: Brisbane, Pashen Street");
    expect(event.tags).toEqual(expect.arrayContaining(["life_event", "sam", "jo", "brisbane", "pashen street"]));
  });

  test("infers timeline add prompts and suppresses them when a strong timeline hit exists", () => {
    expect(inferTimelineSubkindFromQuery("remember when I worked at Airbus")).toBe("employment");
    expect(inferTimelineSubkindFromQuery("remember my friend Sam")).toBe("person");
    expect(inferTimelineSubkindFromQuery("remember when I graduated at QUT")).toBe("life_event");
    expect(shouldPromptToAddTimelineMemory("remember when I worked at Airbus", []).shouldPrompt).toBe(true);
    expect(shouldPromptToAddTimelineMemory("remember when I worked at Airbus", [{ memory: { timeline: { subkind: "employment" } }, score: 0.9 } as any]).shouldPrompt).toBe(false);
  });

  test("expands matching timeline memories with overlapping temporal context", () => {
    const airbus = { id: "job", content: "Airbus", timeline: { kind: "profile.timeline", subkind: "employment", entity: "user", interval: { start: { value: "2018-03", precision: "month" }, end: { value: "2020-09", precision: "month" } }, data: { employer: "Airbus" } } } as any;
    const bristol = { id: "home", content: "Lived in Bristol", timeline: { kind: "profile.timeline", subkind: "residence", entity: "user", interval: { start: { value: "2017", precision: "year" }, end: { value: "2021", precision: "year" } }, data: { city: "Bristol" } } } as any;
    const later = { id: "later", content: "Later job", timeline: { kind: "profile.timeline", subkind: "employment", entity: "user", interval: { start: { value: "2022", precision: "year" }, end: { value: "2023", precision: "year" } }, data: { employer: "Other" } } } as any;

    expect(temporalContextForMemory(airbus, [airbus, bristol, later]).map(memory => memory.id)).toEqual(["home"]);
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
      description: "Interactively edit structured profile, timeline history, or freeform memories",
    });
    expect(tools.some(tool => tool.name === "remember")).toBe(true);
    expect(tools.some(tool => tool.name === "remember_timeline")).toBe(true);
    expect(contextProviders.length).toBe(0);
  });
});
