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

  test("skips providers that do not apply", async () => {
    registerContextProvider({ id: "skip", priority: 10, maxChars: 100, applies: () => false, build: () => "skip me" });
    registerContextProvider({ id: "keep", priority: 1, maxChars: 100, build: () => "keep me" });

    const result = await composeTurnContext(ctx(), messages("hello"));

    expect(result.providerIds).toEqual(["keep"]);
    expect(result.messages[0].content).toContain("keep me");
    expect(result.messages[0].content).not.toContain("skip me");
  });

  test("trims provider output to its budget", async () => {
    registerContextProvider({ id: "big", priority: 1, maxChars: 30, build: () => "x".repeat(200) });

    const result = await composeTurnContext(ctx(), messages("hello"));

    expect(result.providerIds).toEqual(["big"]);
    expect(result.messages[0].content).toContain("[trimmed]");
  });
});
