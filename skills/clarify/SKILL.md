---
name: clarify
description: Structured requirement clarification workflow. Use before implementing any feature where the scope, users, constraints, or success criteria are ambiguous. Surfaces edge cases, resolves conflicting assumptions, and produces a clear spec before any code is written.
---

# Clarify Skill

Use this skill whenever a requirement is ambiguous, incomplete, or could be interpreted multiple ways. The goal is to produce a shared, written understanding before writing a line of code.

## Workflow

### Step 1 — State What You Know

Write out what you currently understand:

```
I understand that:
- [fact 1]
- [fact 2]
- [fact 3]
```

Be explicit about assumptions, not just stated facts.

### Step 2 — Identify What You Don't Know

Group unknowns by category. Work through each category:

**Scope & Outcomes**
- What exactly should happen when a user does X?
- Where does this feature start and stop?
- What is explicitly out of scope?

**Users & Context**
- Who will use this? (role, technical level, device, frequency)
- What are they trying to accomplish at a higher level?
- What does failure look like from their perspective?

**Constraints**
- Are there performance requirements? (latency, throughput, load)
- Are there security or compliance requirements?
- Are there platform, browser, or environment constraints?
- Is there an existing system this must integrate with?

**Success Criteria**
- How will we know this is done?
- What does the happy path look like end-to-end?
- How will this be tested?

**Edge Cases**
- What happens with empty / null / zero / very large inputs?
- What happens if a dependency is unavailable?
- What if the user does this in an unexpected order?
- What are the concurrent access patterns?

**Technical Details**
- Is there a preferred data model or API contract?
- Are there naming conventions or patterns to follow?
- Does this need to be reversible / undoable?

### Step 3 — Ask Targeted Questions

From Step 2, pick the **5 most important** unknowns and ask them clearly.

Rules:
- One question per line
- Concrete and answerable (not "what do you want?")
- Most impactful first
- Do not ask about things you can reasonably infer

Format:
```
I need to clarify a few things before proceeding:

1. [Specific question about scope or outcome]
2. [Specific question about users or context]
3. [Specific question about a key edge case]
4. [Specific question about a constraint]
5. [Specific question about success criteria]
```

### Step 4 — Wait for Answers

Do not proceed to implementation until the critical questions are answered. If the user is unavailable, document the assumption you are making and why.

Use manage_question to record each question in the project plan:
```
manage_question(action="add", question="<question text>")
```

When answered:
```
manage_question(action="answer", question="<partial match>", answer="<answer>")
```

### Step 5 — Confirm Understanding

Once the important questions are answered, write a confirmation using **BDD (Behaviour-Driven Development) format** for acceptance criteria — this makes them directly usable as test descriptions:

```
Based on your answers, here’s my understanding:

**Feature:** [name]

**Job to be done:** When [situation], I want to [action], so I can [outcome].

**Inputs:** [what goes in]

**Outputs / Effects:** [what comes out or changes in the world]

**Happy path:** [step-by-step]

**Edge cases we handle:**
- [case 1] → [behaviour]
- [case 2] → [behaviour]

**Out of scope:**
- [thing 1]
- [thing 2]

**Acceptance criteria (BDD / Gherkin-style):**
1. Given [initial context], when [action taken], then [expected observable outcome]
2. Given [error condition], when [action taken], then [system behaves gracefully by ...]
3. ...

**Error cases return (not throw):**
For functional-style code, note which outcomes return a failure Result rather than throwing.
E.g.: “Given an invalid email, when the user submits, the function returns { ok: false, error: 'invalid-email' }”

Does this match your intent? Any corrections before we start?
```

### Step 6 — Update the Plan

If new acceptance criteria or open questions emerged, update the project plan:
- Call `save_project_plan` if the feature definition changed significantly
- Call `manage_question` to record any remaining open questions

## Tips

- Requirements emerge through conversation — first answers are rarely final
- "Simple" features often hide complex edge cases
- Disagreements in words often mean agreement in intent — dig for the actual goal
- If a question is blocking, make an explicit, reversible assumption and flag it
- Done is better than perfect: clarify enough to start, not everything upfront
