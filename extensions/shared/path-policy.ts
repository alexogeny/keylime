import { isAbsolute, relative, resolve } from "node:path";

export function toPosixPath(path: string): string {
  return path.replace(/\\/g, "/");
}

export function repoRelativePath(cwd: string, path: string): string {
  return toPosixPath(relative(cwd, path));
}

export function resolveSafePath(cwd: string, inputPath: string): string {
  const root = resolve(cwd);
  const candidate = isAbsolute(inputPath) ? resolve(inputPath) : resolve(root, inputPath);
  const rel = relative(root, candidate);
  if (rel === "" || (!rel.startsWith("..") && !isAbsolute(rel))) return candidate;
  throw new Error(`Path is outside cwd: ${inputPath}`);
}
