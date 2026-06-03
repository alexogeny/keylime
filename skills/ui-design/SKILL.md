---
name: ui-design
description: Interface and UX design skill. Use when designing new screens, components, or interaction flows. Covers user journey mapping, component hierarchy, design tokens, accessibility, responsive behaviour, and all interaction states (loading, error, empty, success). Produces design specs ready for TDD implementation.
---

# UI Design Skill

Use this skill before writing any UI code. Good interface design decisions made on paper are far cheaper than refactoring working components.

## Workflow

### Step 1 - Understand the Job-to-be-Done

Before touching layout or components, answer:

- **Who** is the user and what is their goal right now?
- **What** task are they trying to complete?
- **What** do they need to know, do, or decide?
- **What** do they need after they're done?
- **What** could go wrong and how will they recover?

Write a one-sentence job statement:
> "When [situation], I want to [motivation], so I can [outcome]."

### Step 2 - Map the User Flow

Sketch the sequence of screens/states the user moves through:

```
[Entry point]
  │
  ▼
[Screen / State A]  ──(error)──►  [Error state A]
  │
  ▼
[Screen / State B]
  │
  ├──(cancel)──► [Previous state]
  │
  ▼
[Success state]
```

For each screen/state, identify:
- What the user sees
- What actions are available
- What triggers the transition

### Step 3 - Define All States for Every Component

Every interactive component must have all states designed before implementation:

| State      | Description                                    |
|------------|------------------------------------------------|
| Default    | Normal, idle                                   |
| Hover      | Mouse over (desktop)                           |
| Focus      | Keyboard focus (accessibility)                 |
| Active     | Being pressed/interacted with                  |
| Loading    | Async operation in progress                    |
| Disabled   | Not available, but visible                     |
| Error      | Something went wrong, user must act            |
| Empty      | No data / first use (zero state)               |
| Success    | Operation completed                            |

Do not design only the happy path. The error and empty states are often what users remember most.

### Step 4 - Component Hierarchy

Break the UI into a tree of components from coarsest to finest:

```
Page / Route
├── Layout (header, sidebar, main, footer)
│   └── Navigation
├── Feature Region
│   ├── Container / Context provider
│   │   ├── List Component
│   │   │   └── ListItem (× N)
│   │   └── Empty State
│   └── Action Bar
│       ├── PrimaryButton
│       └── SecondaryButton
└── Modal / Overlay (if applicable)
```

For each component, specify:
- **Props / inputs** - what data does it receive?
- **Events / outputs** - what does it emit?
- **Internal state** - what does it manage itself (if anything)?
- **Side-effects** - does it fetch, write, or cause effects?

Prefer components that are:
- Pure: same props → same output
- Narrow: one clear responsibility
- Composable: can be assembled without knowing internals

### Step 5 — Design Tokens

Design tokens are the **single source of truth** shared between your design tool and your code. Define them once in code (a `tokens.json`, CSS custom properties, or your framework’s theme config); the design tool consumes them, not the other way around.

**Colours**
```json
{
  "color": {
    "primary":        "#...",
    "primary-hover":  "#...",
    "surface":        "#...",
    "surface-raised": "#...",
    "border":         "#...",
    "text":           "#...",
    "text-muted":     "#...",
    "error":          "#...",
    "success":        "#...",
    "warning":        "#..."
  }
}
```

**Spacing** (4px base grid)
```json
{ "space": { "1": "4px", "2": "8px", "3": "12px", "4": "16px", "6": "24px", "8": "32px", "12": "48px" } }
```

**Typography**
```json
{
  "font": { "sans": "system-ui, sans-serif", "mono": "monospace" },
  "text": {
    "xs":   { "size": "12px", "leading": "1.4" },
    "sm":   { "size": "14px", "leading": "1.5" },
    "base": { "size": "16px", "leading": "1.6" },
    "lg":   { "size": "18px", "leading": "1.5" },
    "xl":   { "size": "20px", "leading": "1.4" },
    "2xl":  { "size": "24px", "leading": "1.3" }
  },
  "weight": { "normal": "400", "medium": "500", "bold": "700" }
}
```

**Radii, Shadows, Transitions, Z-index** — define as tokens, never invent ad-hoc per-component.

> **Design system as product**: treat tokens and components as a living product with an owner, not a one-time project. When tokens change, update the source file — everything consuming them updates automatically. AI coding tools can query your token file directly; keep it accurate.

### Step 6 - Responsive Behaviour

Decide breakpoints and how layout changes:

| Breakpoint | Width    | Layout changes                        |
|------------|----------|---------------------------------------|
| mobile     | < 640px  | Single column, stacked, bottom nav    |
| tablet     | 640-1024px | Two columns, side navigation optional|
| desktop    | > 1024px | Full layout, persistent sidebar       |

For each component: does it collapse, reflow, hide, or replace at each breakpoint?

### Step 7 - Accessibility Requirements

Checklist - address each before writing component code:

- [ ] **Keyboard navigation**: tab order is logical, all actions reachable by keyboard
- [ ] **Focus indicators**: visible on all focusable elements (do not remove outline without replacement)
- [ ] **Screen reader labels**: every interactive element has an accessible name (`aria-label` or visible text)
- [ ] **Colour contrast**: text meets WCAG AA (4.5:1 for body, 3:1 for large text and UI components)
- [ ] **Error messages**: errors are associated with their field (`aria-describedby`), not just colour-coded
- [ ] **Loading states**: announced to screen readers (`aria-live`, `aria-busy`)
- [ ] **Motion**: respect `prefers-reduced-motion` for animations
- [ ] **Touch targets**: minimum 44×44px on mobile

### Step 8 - Produce a Component Spec

For each component to be built, write a spec in this format:

```markdown
## ComponentName

**Purpose:** One sentence.

**Props:**
| Prop       | Type     | Required | Default | Description       |
|------------|----------|----------|---------|-------------------|
| label      | string   | yes      | -       | Button label text |
| onClick    | function | yes      | -       | Click handler     |
| disabled   | boolean  | no       | false   | Disables the btn  |
| loading    | boolean  | no       | false   | Shows spinner     |

**States:** default, hover, focus, active, loading, disabled

**Accessibility:**
- role="button" (if not a <button> element)
- aria-disabled when disabled
- aria-busy + aria-label change when loading

**Tests to write (TDD):**
1. renders with label
2. calls onClick when clicked
3. does not call onClick when disabled
4. shows loading indicator when loading=true
5. is focusable and activatable by keyboard
```

### Step 9 — Validate Before Implementing

Before writing any code:
- [ ] Every screen has all states designed (loading, error, empty, success)
- [ ] Component hierarchy is agreed
- [ ] Design tokens are defined in a token file (not scattered in component styles)
- [ ] Accessibility requirements are listed per component
- [ ] Each component has a TDD test list ready

If web research would help (e.g. component library selection, animation patterns, accessibility patterns), use web_search + save_search_knowledge before proceeding.

## Handoff to TDD

**2026 standard: live specs over static redlines.** Don't produce a static image with annotations. Produce:
1. A token file the developer can import directly
2. Component specs (the table format above) committed alongside the code
3. Working prototype or Storybook story where possible — developers read code, not redlines

Once the spec is written, update the project plan:
- Add detailed acceptance criteria to each feature via `save_project_plan`
- For each component spec, the "Tests to write" list becomes the TDD acceptance criteria
- Start the TDD cycle with `/tdd <feature-name>`
- Call `log_decision` for any significant design system choices (token architecture, component library selection, etc.)
