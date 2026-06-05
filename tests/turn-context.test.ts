import { describe, expect, test, beforeEach } from "bun:test";
import { classifyIntent, setCurrentRoute } from "../extensions/shared/intent";
import { clearContextProviders, composeTurnContext, registerContextProvider } from "../extensions/shared/turn-context";

const ctx = (percent = 10) => ({
  getContextUsage: () => ({ percent }),
}) as any;

const messages = (text: string) => [{ role: "user", content: text }];

beforeEach(() => {
  clearContextProviders();
  setCurrentRoute(classifyIntent(""));
});

describe("turn context composer", () => {
  test("composes providers into one reminder in priority order", async () => {
    setCurrentRoute(classifyIntent("please implement this"));
    registerContextProvider({ id: "low", priority: 1, maxChars: 100, build: () => "low priority" });
    registerContextProvider({ id: "high", priority: 10, maxChars: 100, build: () => "high priority" });

    const result = await composeTurnContext(ctx(), messages("please implement this"));
    const text = result.messages[0].content;

    expect(result.providerIds).toEqual(["high", "low"]);
    expect(text).toContain("<system-reminder>");
    expect(text.indexOf("high priority")).toBeLessThan(text.indexOf("low priority"));
    expect(text.match(/<system-reminder>/g)?.length).toBe(1);
  });

  test("orders equal-priority providers by stability then id for cache-friendly output", async () => {
    registerContextProvider({ id: "turn-z", priority: 5, maxChars: 100, stability: "turn", build: () => "turn-changing-1" });
    registerContextProvider({ id: "static-b", priority: 5, maxChars: 100, stability: "static", build: () => "static b" });
    registerContextProvider({ id: "static-a", priority: 5, maxChars: 100, stability: "static", build: () => "static a" });
    registerContextProvider({ id: "session-a", priority: 5, maxChars: 100, stability: "session", build: () => "session a" });

    const result = await composeTurnContext(ctx(), messages("hello"));
    const text = result.messages[0].content;

    expect(result.providerIds).toEqual(["static-a", "static-b", "session-a", "turn-z"]);
    expect(text.indexOf("static a")).toBeLessThan(text.indexOf("static b"));
    expect(text.indexOf("static b")).toBeLessThan(text.indexOf("session a"));
    expect(text.indexOf("session a")).toBeLessThan(text.indexOf("turn-changing-1"));
  });

  test("skips providers that do not apply", async () => {
    registerContextProvider({ id: "skip", priority: 10, maxChars: 100, applies: () => false, build: () => "skip me" });
    registerContextProvider({ id: "keep", priority: 1, maxChars: 100, build: () => "keep me" });

    const result = await composeTurnContext(ctx(), messages("hello"));

    expect(result.providerIds).toEqual(["keep"]);
    expect(result.messages[0].content).toContain("keep me");
    expect(result.messages[0].content).not.toContain("skip me");
  });

  test("dedupes exact duplicate provider output and reports provider diagnostics", async () => {
    registerContextProvider({ id: "high", priority: 10, maxChars: 100, stability: "turn", build: () => "same reminder" } as any);
    registerContextProvider({ id: "low", priority: 1, maxChars: 100, stability: "session", build: () => "same reminder" } as any);

    const result = await composeTurnContext(ctx(), messages("hello"));

    expect(result.providerIds).toEqual(["high"]);
    expect(result.messages[0].content.match(/same reminder/g)).toHaveLength(1);
    expect(result.diagnostics.providers).toEqual([
      expect.objectContaining({ id: "high", included: true, stability: "turn", rawChars: 13, finalChars: 13, trimmed: false }),
      expect.objectContaining({ id: "low", included: false, skippedReason: "duplicate", stability: "session" }),
    ]);
  });

  test("trims provider output to its budget", async () => {
    registerContextProvider({ id: "big", priority: 1, maxChars: 30, build: () => "x".repeat(200) });

    const result = await composeTurnContext(ctx(), messages("hello"));

    expect(result.providerIds).toEqual(["big"]);
    expect(result.messages[0].content).toContain("[trimmed]");
  });
});

test("uses a tighter total budget under high context pressure and drops lowest-priority providers first", async () => {
  clearContextProviders();
  registerContextProvider({ id: "a", priority: 3, maxChars: 800, build: () => "a".repeat(800) });
  registerContextProvider({ id: "b", priority: 2, maxChars: 800, build: () => "b".repeat(800) });
  registerContextProvider({ id: "c", priority: 1, maxChars: 800, build: () => "c".repeat(800) });

  const result = await composeTurnContext(ctx(90), messages("hello"));

  expect(result.diagnostics.pressure).toBe("high");
  expect(result.diagnostics.totalBudget).toBe(900);
  expect(result.providerIds).toEqual(["a", "b"]);
  expect(result.diagnostics.providers.find(p => p.id === "b")).toMatchObject({ included: true, trimmed: true });
  expect(result.diagnostics.providers.find(p => p.id === "c")).toMatchObject({ included: false, skippedReason: "budget" });
  expect(result.messages[0].content.length).toBeLessThan(1_100);
});

test("provider prompt extraction strips existing system reminders", async () => {
  clearContextProviders();
  let seenPrompt = "";
  registerContextProvider({
    id: "capture",
    priority: 1,
    maxChars: 200,
    build: ({ prompt }) => { seenPrompt = prompt; return "ok"; },
  });

  await composeTurnContext(ctx(), messages("hello\n\n<system-reminder>secret routing text</system-reminder>"));

  expect(seenPrompt).toBe("hello\n\n ");
});
