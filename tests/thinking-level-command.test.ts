import { describe, expect, test } from "bun:test";
import thinkingLevelCommand, { THINKING_LEVELS } from "../extensions/thinking-level-command";
import { mockPiFixture } from "./helpers/mock-pi";

describe("thinking level command", () => {
  test("opens a level selector and applies the selected thinking level", async () => {
    const harness = mockPiFixture();
    let level = "medium";
    let title = "";
    let options: string[] = [];
    (harness.pi as any).getThinkingLevel = () => level;
    (harness.pi as any).setThinkingLevel = (next: string) => { level = next; };
    (harness.ctx.ui as any).select = async (nextTitle: string, nextOptions: string[]) => { title = nextTitle; options = nextOptions; return "high"; };
    thinkingLevelCommand(harness.pi);

    await harness.commands["thinking-level"].handler("", harness.ctx);

    expect(title).toContain("Current: medium");
    expect(options).toEqual([...THINKING_LEVELS]);
    expect(level).toBe("high");
    expect(harness.notifications.join("\n")).toContain("high");
  });

  test("accepts a valid level argument without opening the selector", async () => {
    const harness = mockPiFixture();
    let level = "off";
    (harness.pi as any).getThinkingLevel = () => level;
    (harness.pi as any).setThinkingLevel = (next: string) => { level = next; };
    (harness.ctx.ui as any).select = async () => { throw new Error("selector should not open"); };
    thinkingLevelCommand(harness.pi);

    await harness.commands["thinking-level"].handler("xhigh", harness.ctx);
    expect(level).toBe("xhigh");
  });

  test("rejects an invalid level argument", async () => {
    const harness = mockPiFixture();
    let level = "low";
    (harness.pi as any).getThinkingLevel = () => level;
    (harness.pi as any).setThinkingLevel = (next: string) => { level = next; };
    thinkingLevelCommand(harness.pi);

    await harness.commands["thinking-level"].handler("turbo", harness.ctx);
    expect(level).toBe("low");
    expect(harness.notifications.join("\n")).toContain("Unknown thinking level");
  });
});
