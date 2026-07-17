import { dirname, isAbsolute, relative, resolve } from "node:path";
import { realpath } from "node:fs/promises";

export function toPosixPath(path: string): string {
  return path.replace(/\\/g, "/");
}

export function repoRelativePath(cwd: string, path: string): string {
  return toPosixPath(relative(cwd, path));
}

export function isPathWithin(rootPath: string, candidatePath: string, options: { allowRoot?: boolean } = {}): boolean {
  const root = resolve(rootPath);
  const candidate = resolve(candidatePath);
  const rel = relative(root, candidate);
  return (options.allowRoot === true && rel === "") || (rel !== "" && !rel.startsWith("..") && !isAbsolute(rel));
}

export function resolveSafePath(cwd: string, inputPath: string): string {
  const root = resolve(cwd);
  const candidate = isAbsolute(inputPath) ? resolve(inputPath) : resolve(root, inputPath);
  if (isPathWithin(root, candidate, { allowRoot: true })) return candidate;
  throw new Error(`Path is outside cwd: ${inputPath}`);
}

export async function resolveSafeExistingPath(cwd: string, inputPath: string): Promise<string> {
  const root = resolve(cwd);
  const candidate = resolveSafePath(root, inputPath);
  const [realRoot, realCandidate] = await Promise.all([realpath(root), realpath(candidate)]);
  if (!isPathWithin(realRoot, realCandidate, { allowRoot: true })) throw new Error(`Path escapes cwd through a symlink: ${inputPath}`);
  const expected = resolve(realRoot, relative(root, candidate));
  if (realCandidate !== expected) throw new Error(`Symlink paths are not allowed: ${inputPath}`);
  return candidate;
}

export async function resolveSafeCreationPath(cwd: string, inputPath: string): Promise<string> {
  const root = resolve(cwd);
  const candidate = resolveSafePath(root, inputPath);
  const [realRoot, realParent] = await Promise.all([realpath(root), realpath(dirname(candidate))]);
  const expectedParent = resolve(realRoot, relative(root, dirname(candidate)));
  if (realParent !== expectedParent || !isPathWithin(realRoot, realParent, { allowRoot: true })) throw new Error(`Parent escapes cwd through a symlink: ${inputPath}`);
  return candidate;
}
