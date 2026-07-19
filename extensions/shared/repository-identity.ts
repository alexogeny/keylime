import { createHash } from "node:crypto";
import { existsSync } from "node:fs";
import { readFile, realpath } from "node:fs/promises";
import { dirname, join, parse } from "node:path";

export type RepositoryIdentity = {
  version: 1;
  canonicalRoot: string;
  marker: string;
};

export type BoundStateEnvelope<T> = {
  version: 1;
  repository: RepositoryIdentity;
  updatedAt: number;
  payload: T;
};

export type BoundStateLoad<T> =
  | { status: "ok"; value: T; envelope: BoundStateEnvelope<T> }
  | { status: "legacy"; path: string }
  | { status: "mismatch"; path: string; expected: RepositoryIdentity; actual: RepositoryIdentity };

function hash(parts: string[]): string {
  const digest = createHash("sha256");
  for (const part of parts) digest.update(part).update("\0");
  return digest.digest("hex");
}

function repositoryMarkerName(root: string): string {
  if (existsSync(join(root, ".git"))) return ".git";
  for (const marker of ["package.json", "Cargo.toml", "pyproject.toml", "go.mod"]) {
    if (existsSync(join(root, marker))) return marker;
  }
  return "directory";
}

async function findRepositoryRoot(cwd: string): Promise<string> {
  let current = await realpath(cwd);
  const filesystemRoot = parse(current).root;
  while (true) {
    if (existsSync(join(current, ".git"))) return current;
    const parent = dirname(current);
    if (current === filesystemRoot || parent === current) return await realpath(cwd);
    current = parent;
  }
}

async function packageName(root: string): Promise<string> {
  const path = join(root, "package.json");
  if (!existsSync(path)) return "";
  try {
    const parsed = JSON.parse(await readFile(path, "utf8"));
    return typeof parsed?.name === "string" ? parsed.name : "";
  } catch {
    return "";
  }
}

export async function resolveRepositoryIdentity(cwd: string): Promise<RepositoryIdentity> {
  const canonicalRoot = await findRepositoryRoot(cwd);
  const markerName = repositoryMarkerName(canonicalRoot);
  const name = await packageName(canonicalRoot);
  return {
    version: 1,
    canonicalRoot,
    marker: hash(["keylime-repository-v1", canonicalRoot, markerName, name]),
  };
}

export function bindRepositoryState<T>(repository: RepositoryIdentity, payload: T, updatedAt = Date.now()): BoundStateEnvelope<T> {
  return { version: 1, repository, updatedAt, payload };
}

function isRepositoryIdentity(value: unknown): value is RepositoryIdentity {
  const candidate = value as RepositoryIdentity | undefined;
  return candidate?.version === 1
    && typeof candidate.canonicalRoot === "string"
    && typeof candidate.marker === "string";
}

function isBoundEnvelope<T>(value: unknown): value is BoundStateEnvelope<T> {
  const candidate = value as BoundStateEnvelope<T> | undefined;
  return candidate?.version === 1
    && isRepositoryIdentity(candidate.repository)
    && typeof candidate.updatedAt === "number"
    && "payload" in candidate;
}

export function repositoryIdentitiesEqual(left: RepositoryIdentity, right: RepositoryIdentity): boolean {
  return left.version === right.version
    && left.canonicalRoot === right.canonicalRoot
    && left.marker === right.marker;
}

export function loadBoundRepositoryState<T>(value: unknown, expected: RepositoryIdentity, path: string): BoundStateLoad<T> {
  if (!isBoundEnvelope<T>(value)) return { status: "legacy", path };
  if (!repositoryIdentitiesEqual(value.repository, expected)) {
    return { status: "mismatch", path, expected, actual: value.repository };
  }
  return { status: "ok", value: value.payload, envelope: value };
}
