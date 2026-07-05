---
name: change-planning
description: >
  Repo-aware implementation planning workflow. Use when the user asks for a technical plan, implementation outline, refactor plan, architecture plan, or asks what work is involved. Produces a constrained, actionable plan grounded in repository conventions and concrete files.
---

# Change Planning Skill

Use this skill when the user asks for a technical plan, implementation outline, refactor plan, architecture plan, or asks “what work is involved”.

## Goal

Produce a practical, repo-aware plan that can be handed directly to an implementation agent or developer. The plan should be specific, constrained, and actionable without becoming generic architecture prose.

---

## Default preferences

Apply these by default unless the user explicitly asks otherwise or repo instructions clearly require a different approach.

- Prefer repo-native/custom implementation over adding dependencies.
- Recommend a library only when the custom implementation would be disproportionately complex, risky, or outside the project’s scope.
- Before recommending a library or major pattern, check repo guidance such as:
  - `AGENTS.md`
  - `CLAUDE.md`
  - `.cursorrules`
  - project README/development docs
  - package conventions already present in the repo
- Avoid time estimates.
- Avoid artificial phases.
- Avoid broad “best practices” sections.
- Avoid presenting lots of alternatives unless there is a real decision to make.
- Prefer extending existing models, DTOs, hooks, services, and UI primitives.
- Prefer high-visibility proof points over converting the entire app at once.
- Prefer acceptance checks that prove the core behaviour without requiring exhaustive implementation.
- Preserve project conventions even if they differ from industry defaults.

---

## Planning principles

- Start from the user’s goal and the repo’s existing structure.
- Make assumptions explicit only when they affect implementation.
- Reference concrete files, models, APIs, components, and types where known.
- Separate implementation tasks from correctness rules.
- Include security, tenancy, auditability, data retention, and UX edge cases when relevant.
- If a repo convention says to flatten migrations, avoid proposing new migrations.
- If there is existing shared infrastructure, extend it before creating parallel systems.
- If the user corrects the plan, rewrite cleanly and incorporate the correction.

---

## Repo reconnaissance before planning

Keep reconnaissance narrow and relevant to the requested change.

1. Read repo guidance first when present: `AGENTS.md`, `CLAUDE.md`, `.cursorrules`, README, development docs.
2. Identify existing implementation seams: models, DTOs, routes, services, hooks, components, validation, tests, seed data, and migrations.
3. Check package conventions before recommending new dependencies or patterns.
4. Prefer `repo-map` first if the repo or target area is unfamiliar.

Do not produce a generic plan when concrete repo files can be found cheaply.

---

## Response structure

Use this default shape.

### Goal

One short paragraph describing the intended end state.

### Repo conventions / constraints

Only include constraints that are evident from the repo or necessary for implementation.

Examples:

- “Use existing shared DTOs in `app/shared/src`.”
- “Extend existing Prisma models directly.”
- “Use current UI primitives from `@/ui`.”
- “Keep stored audit timestamps immutable.”

### Data model changes

Name exact models and fields.

Include schema/type snippets where useful.

Example:

```prisma
model Organisation {
  defaultLanguage String @default("en-AU")
  defaultLocale   String @default("en-AU")
}
```

### Shared types / contracts

List DTOs, shared interfaces, constants, validation enums, and resolver functions.

Include where they should live.

Example:

```text
app/shared/src/types/preferences.ts
app/shared/src/types/admin.ts
```

### Backend changes

Cover:

- API route changes
- service changes
- validation
- persistence
- seed/default behaviour
- permission/tenant implications

### Frontend/runtime changes

Cover:

- providers/hooks
- route/page changes
- high-visibility proof points
- user/admin settings screens
- UI primitives to reuse

### Correctness rules

Include specific non-negotiables.

Examples:

- Audit timestamps remain immutable UTC instants.
- Displayed audit timestamps must be sortable and include timezone/offset permanence.
- User preferences override org defaults.
- Org defaults override browser/system fallback.
- Do not allow user-controlled locale/timezone values without validation.

### Files touched

Concise list of likely files.

Example:

```text
app/server/prisma/schema.prisma
app/shared/src/types/preferences.ts
app/client/src/lib/i18n.tsx
```

### Acceptance checks

Concrete observable outcomes.

Good:

- “Login language picker changes the title, email label, password label, and submit button before sign-in.”
- “Admin workspace localisation defaults persist and appear in `/api/me`.”
- “Audit trail timestamps render as `YYYY-MM-DDTHH:mm:ss.sssZ UTC` or equivalent sortable permanent format.”

Bad:

- “i18n works.”
- “Dates are correct.”
- “UI is improved.”

---

## Library recommendation rule

Default to hand-rolled implementation.

Only recommend a dependency if all are true:

1. The feature needs complexity that would be expensive or risky to maintain manually.
2. The dependency fits existing project conventions.
3. The repo does not already contain a suitable primitive.
4. The plan clearly explains why custom implementation is not appropriate.

When recommending a dependency, include:

- why it is needed
- where it would be introduced
- what surface area it owns
- how the repo avoids lock-in

---

## Migration rule

Do not default to adding a new migration.

First check repo convention.

If the repo uses disposable/flattened development DBs, plan to:

- update the Prisma model
- update the flattened/init migration state if applicable
- tear down local dev DB
- recreate/reseed

Only propose a new migration when the repo clearly uses accumulating migrations or the user asks for production migration planning.

---

## Date/time/audit rule

For date/time-related plans:

- Store instants as UTC.
- Treat display formatting as presentation only.
- User/org timezone changes must not mutate historical data.
- Audit trails need a dedicated audit timestamp formatter.
- Audit display must be immutable, sortable, and timezone-permanent.

Recommended audit display examples:

```text
2026-07-05T02:34:10.123Z UTC
2026-07-05T12:34:10.123+10:00 Australia/Brisbane
```

Avoid audit-only displays like:

```text
5 Jul 2026, 12:34 pm
```

---

## Custom implementation preference

When custom implementation is suitable:

- Keep it small.
- Use plain typed objects for registries/catalogues.
- Use shared resolver functions for precedence rules.
- Keep validation centralized.
- Add a high-visibility proof point before broad conversion.
- Avoid clever abstractions until repetition is proven.

Example for custom i18n:

```ts
const messages = {
  "en-AU": {
    "login.title": "Sign in",
  },
  "mi-NZ": {
    "login.title": "Takiuru",
  },
} as const;
```

---

## Tone

- Confident and direct.
- Concise but complete.
- No filler.
- No apology unless correcting an actual error.
- No generic textbook explanations.
