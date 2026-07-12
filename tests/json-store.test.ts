import { afterEach, describe, expect, test } from "bun:test";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { readJsonDir, readJsonFile, writeJsonFile } from "../extensions/shared/json-store";

const temporaryDirectories: string[] = [];

async function temporaryDirectory(): Promise<string> {
  const directory = await mkdtemp(join(tmpdir(), "keylime-json-store-"));
  temporaryDirectories.push(directory);
  return directory;
}

afterEach(async () => {
  await Promise.all(temporaryDirectories.splice(0).map(directory => rm(directory, { recursive: true, force: true })));
});

describe("shared JSON store", () => {
  test("returns fallbacks and supports strict parse errors", async () => {
    const directory = await temporaryDirectory();
    const path = join(directory, "value.json");
    expect(await readJsonFile(path, { ok: false })).toEqual({ ok: false });
    await writeFile(path, "not json", "utf8");
    expect(await readJsonFile(path, { ok: false })).toEqual({ ok: false });
    await expect(readJsonFile(path, null, { onError: "throw" })).rejects.toBeTruthy();
  });

  test("atomically replaces JSON and honors final newlines", async () => {
    const directory = await temporaryDirectory();
    const path = join(directory, "nested", "value.json");
    await writeJsonFile(path, { version: 1 });
    await writeJsonFile(path, { version: 2 }, { finalNewline: true });
    expect(JSON.parse(await readFile(path, "utf8"))).toEqual({ version: 2 });
    expect((await readFile(path, "utf8")).endsWith("\n")).toBe(true);
  });

  test("loads directory entries concurrently in deterministic order", async () => {
    const directory = await temporaryDirectory();
    await Promise.all([
      writeJsonFile(join(directory, "b.json"), { id: "b" }),
      writeJsonFile(join(directory, "a.json"), { id: "a" }),
      writeFile(join(directory, "broken.json"), "{", "utf8"),
    ]);
    expect(await readJsonDir<{ id: string }>(directory, { concurrency: 2 })).toEqual([{ id: "a" }, { id: "b" }]);
  });
});
