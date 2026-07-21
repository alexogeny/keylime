export type ClarificationEvalCase = {
  id: string;
  request: string;
  expectedPaths: string[];
};

export const CLARIFICATION_EVAL_CORPUS: ClarificationEvalCase[] = [
  {
    id: "fetch-challenge-firecrawl",
    request: "find where the web search does fethc url and fire crawl and make it always fall back to firecrawl if it detects a challenge",
    expectedPaths: ["extensions/fetch.ts", "tests/fetch.test.ts", "extensions/shared/firecrawl-client.ts"],
  },
  {
    id: "frozen-footer-tokens",
    request: "the token up down footer counter is frozen and never refreshes after assistant messages",
    expectedPaths: ["extensions/signal-footer.ts", "tests/signal-footer.test.ts"],
  },
  {
    id: "minor-checkpoint-commits",
    request: "checkpoint the little edits too instead of leaving them uncommitted until some big change",
    expectedPaths: ["extensions/git-checkpoint.ts", "extensions/shared/safety-policy.ts", "tests/git-checkpoint.test.ts"],
  },
  {
    id: "cross-session-input-token-overhead",
    request: "i think we are submitting too many ^ up tokens across chat sessions and i want to reduce the repeated prompt overhead",
    expectedPaths: ["extensions/usage-tracker.ts", "extensions/cache-guard.ts", "extensions/context-health.ts", "extensions/signal-footer.ts", "extensions/shared/context-ledger.ts"],
  },
  {
    id: "deferred-tool-activation",
    request: "claude searches for apply code replacements then races the activation and guesses the schema",
    expectedPaths: ["extensions/policy-tools.ts", "extensions/shared/tool-policy.ts", "tests/policy-tools.test.ts"],
  },
];
