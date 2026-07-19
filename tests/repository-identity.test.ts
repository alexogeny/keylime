import { describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  bindRepositoryState,
  loadBoundRepositoryState,
  resolveRepositoryIdentity,
} from "../extensions/shared/repository-identity";

async function fixtureRepo(name: string): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), `${name}-`));
  await mkdir(join(root, ".git"));
  await writeFile(join(root, ".git", "HEAD"), "ref: refs/heads/main\n", "utf8");
  await writeFile(join(root, "package.json"), JSON.stringify({ name }), "utf8");
  return root;
}

describe("repository identity", () => {
  test("rejects state bound to another repository", async () => {
    const current = await fixtureRepo("current-repo");
    const foreign = await fixtureRepo("foreign-repo");
    try {
      const expected = await resolveRepositoryIdentity(current);
      const actual = await resolveRepositoryIdentity(foreign);
      const envelope = bindRepositoryState(actual, { goal: "foreign work" }, 123);

      const loaded = loadBoundRepositoryState(envelope, expected, ".pi/project.json");

      expect(loaded.status).toBe("mismatch");
      if (loaded.status !== "mismatch") throw new Error("expected mismatch");
      expect(loaded.path).toBe(".pi/project.json");
      expect(loaded.expected.marker).toBe(expected.marker);
      expect(loaded.actual.marker).toBe(actual.marker);
      expect("value" in loaded).toBe(false);
    } finally {
      await Promise.all([rm(current, { recursive: true, force: true }), rm(foreign, { recursive: true, force: true })]);
    }
  });

  test("identity survives branch and HEAD changes", async () => {
    const root = await fixtureRepo("branch-stable");
    try {
      const before = await resolveRepositoryIdentity(root);
      await writeFile(join(root, ".git", "HEAD"), "ref: refs/heads/feature/context\n", "utf8");
      const after = await resolveRepositoryIdentity(root);
      expect(after).toEqual(before);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  test("treats an unbound legacy payload as quarantined", async () => {
    const root = await fixtureRepo("legacy-state");
    try {
      const expected = await resolveRepositoryIdentity(root);
      const loaded = loadBoundRepositoryState({ name: "legacy project" }, expected, ".pi/project.json");
      expect(loaded).toEqual({ status: "legacy", path: ".pi/project.json" });
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  test("normalizes symlinked roots before calculating identity", async () => {
    const root = await fixtureRepo("canonical-root");
    const parent = await mkdtemp(join(tmpdir(), "repo-link-"));
    const linked = join(parent, "linked");
    try {
      await symlink(root, linked, "dir");
      const direct = await resolveRepositoryIdentity(root);
      const throughLink = await resolveRepositoryIdentity(linked);
      expect(throughLink).toEqual(direct);
    } finally {
      await Promise.all([rm(parent, { recursive: true, force: true }), rm(root, { recursive: true, force: true })]);
    }
  });
});
