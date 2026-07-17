import { afterEach, describe, expect, test } from "bun:test";
import { mkdtemp, readFile, rm, stat, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { assertSafeDirectTarget, readResponseTextBounded } from "../extensions/fetch";
import { resolveSafeExistingPath } from "../extensions/shared/path-policy";
import { requireApproved } from "../extensions/shared/linux-safety";
import { setJsonPathForTest } from "../extensions/policy-tools";
import { parsePageSpecForTest } from "../extensions/document-primitives";
import { isSafeRegexPattern } from "../extensions/shared/code-primitives";
import { collectRequestBodyBounded, createControlPlaneState } from "../extensions/control-plane-api/server";
import { parseCheckpointMessage } from "../extensions/shared/checkpoint-message";
import { resetToolResultManifestCacheForTest, storeResultForTest } from "../extensions/tool-result-compactor";

const dirs: string[] = [];
afterEach(async () => {
  resetToolResultManifestCacheForTest();
  delete (Object.prototype as any).polluted;
  await Promise.all(dirs.splice(0).map(path => rm(path, { recursive: true, force: true })));
});

describe("red-team security boundaries", () => {
  test("direct fetch rejects local, metadata, credential-bearing, and non-http targets", async () => {
    const lookup = async () => [{ address: "127.0.0.1", family: 4 } as any];
    await expect(assertSafeDirectTarget("http://localhost/admin", lookup)).rejects.toThrow("private");
    await expect(assertSafeDirectTarget("http://169.254.169.254/latest/meta-data", lookup)).rejects.toThrow("private");
    await expect(assertSafeDirectTarget("file:///etc/passwd", lookup)).rejects.toThrow("HTTP");
    await expect(assertSafeDirectTarget("https://user:pass@example.com", lookup)).rejects.toThrow("Credential");
    await expect(assertSafeDirectTarget("https://rebind.example", lookup)).rejects.toThrow("private");
  });

  test("response decoding aborts above its byte budget", async () => {
    const response = new Response("x".repeat(1025));
    await expect(readResponseTextBounded(response, 1024)).rejects.toThrow("exceeds");
  });

  test("repository containment rejects symlinks escaping the root", async () => {
    const root = await mkdtemp(join(tmpdir(), "keylime-root-")); dirs.push(root);
    const outside = await mkdtemp(join(tmpdir(), "keylime-outside-")); dirs.push(outside);
    await writeFile(join(outside, "secret.txt"), "secret");
    await symlink(join(outside, "secret.txt"), join(root, "link.txt"));
    await expect(resolveSafeExistingPath(root, "link.txt")).rejects.toThrow("symlink");
  });

  test("required approval fails closed without an interactive confirmer", async () => {
    await expect(requireApproved({}, "Danger", "Do it?")).rejects.toThrow("confirmation UI");
  });

  test("JSON paths reject prototype-pollution segments", () => {
    const target = {};
    expect(() => setJsonPathForTest(target, "__proto__.polluted", true)).toThrow("unsafe JSON path");
    expect((Object.prototype as any).polluted).toBeUndefined();
  });

  test("page specifications reject pathological ranges before iteration", () => {
    expect(() => parsePageSpecForTest("1-999999999999", 1)).toThrow("range");
    expect([...parsePageSpecForTest("1-3", 3)!]).toEqual([1, 2, 3]);
  });

  test("regex policy rejects catastrophic nested quantifiers", () => {
    expect(isSafeRegexPattern("(a+)+$")).toBe(false);
    expect(isSafeRegexPattern("error\\s+message")).toBe(true);
  });

  test("control-plane request bodies are rejected above the hard limit", async () => {
    async function* chunks() { yield Buffer.alloc(700); yield Buffer.alloc(400); }
    await expect(collectRequestBodyBounded(chunks(), 1000)).rejects.toThrow("exceeds");
  });

  test("control-plane state generates authentication when none is configured", () => {
    const previous = process.env.KEYLIME_CONTROL_PLANE_TOKEN;
    delete process.env.KEYLIME_CONTROL_PLANE_TOKEN;
    try {
      const state = createControlPlaneState({} as any, { cwd: "/tmp", sessionManager: {} });
      expect(state.token).toMatch(/^[a-f0-9]{64}$/);
    } finally {
      if (previous === undefined) delete process.env.KEYLIME_CONTROL_PLANE_TOKEN;
      else process.env.KEYLIME_CONTROL_PLANE_TOKEN = previous;
    }
  });

  test("model-generated checkpoint text is secret-redacted before commit", () => {
    const parsed = parseCheckpointMessage('{"subject":"fix(auth): rotate leaked credential","body":["token=super-secret-value"]}');
    expect(parsed?.body).not.toContain("super-secret-value");
    expect(parsed?.body).toContain("[REDACTED]");
  });

  test("persisted tool results are owner-readable only", async () => {
    const cwd = await mkdtemp(join(tmpdir(), "keylime-tool-result-mode-")); dirs.push(cwd);
    const stored = await storeResultForTest(cwd, "sensitive");
    const mode = (await stat(join(cwd, stored.path))).mode & 0o777;
    expect(mode).toBe(0o600);
  });

  test("UI runtime no longer depends on remote Babel execution", async () => {
    const source = await readFile(join(process.cwd(), "ui", "support.js"), "utf8");
    expect(source).not.toContain("https://unpkg.com/@babel/standalone");
  });
});
