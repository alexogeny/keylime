import { isAbsolute, relative, resolve } from "node:path";

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
