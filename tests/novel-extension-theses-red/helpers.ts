import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";

export async function productionModule(name: string): Promise<any> {
  return import(new URL(`../../extensions/shared/${name}.ts`, import.meta.url).href);
}

export async function fixtureRoot(prefix: string): Promise<string> {
  return mkdtemp(join(tmpdir(), `keylime-${prefix}-`));
}

export async function writeFixture(root: string, path: string, content: string): Promise<void> {
  const target = join(root, path);
  await mkdir(dirname(target), { recursive: true });
  await writeFile(target, content, "utf8");
}

export async function removeFixture(root: string): Promise<void> {
  await rm(root, { recursive: true, force: true });
}

export function shaPattern(): RegExp { return /^[a-f0-9]{64}$/; }
