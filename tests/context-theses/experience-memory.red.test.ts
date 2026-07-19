import { describe, expect, test } from "bun:test";
import { loadThesisModule, thesisFunction } from "./helpers";

type Experience = { id: string; repository: string; revision: string; problemSignature: string; symbols: string[]; approach: string; outcome: "success" | "failure"; verification: string[]; confidence: number; createdAt: number; expiresAt?: number };
type Query = { repository: string; revision: string; problemSignature: string; symbols: string[]; now: number };
type Match = { id: string; score: number; reasons: string[]; experience: Experience };

const experiences: Experience[] = [
  { id: "exact", repository: "acme/app", revision: "main", problemSignature: "cache prefix stale after model switch", symbols: ["cacheKey", "invalidatePrefix"], approach: "include model id in key", outcome: "success", verification: ["cache.test.ts passes"], confidence: .95, createdAt: 90 },
  { id: "failed", repository: "acme/app", revision: "main", problemSignature: "cache prefix stale", symbols: ["cacheKey"], approach: "clear all caches", outcome: "failure", verification: ["regression failed"], confidence: .8, createdAt: 80 },
  { id: "foreign", repository: "other/app", revision: "main", problemSignature: "cache prefix stale after model switch", symbols: ["cacheKey"], approach: "foreign patch", outcome: "success", verification: ["tests pass"], confidence: 1, createdAt: 99 },
  { id: "expired", repository: "acme/app", revision: "main", problemSignature: "cache prefix stale", symbols: ["cacheKey"], approach: "old dependency workaround", outcome: "success", verification: ["old tests pass"], confidence: .9, createdAt: 1, expiresAt: 50 },
];

async function retrieve(query: Query, input = experiences): Promise<Match[]> {
  const api = await loadThesisModule("experience-memory");
  const fn = thesisFunction<(query: Query, experiences: Experience[], options?: Record<string, unknown>) => Match[]>(api, "retrieveRepositoryExperiences");
  return fn(query, input, { maxResults: 3, minConfidence: .5 });
}

const query: Query = { repository: "acme/app", revision: "main", problemSignature: "model switch leaves stale cache prefix", symbols: ["cacheKey", "invalidatePrefix"], now: 100 };

describe("RED thesis: typed cross-task experience memory", () => {
  test("ranks repository-compatible successful experience first", async () => {
    expect((await retrieve(query))[0].id).toBe("exact");
  });

  test("quarantines experiences from a foreign repository", async () => {
    expect((await retrieve(query)).map(match => match.id)).not.toContain("foreign");
  });

  test("excludes expired experiences", async () => {
    expect((await retrieve(query)).map(match => match.id)).not.toContain("expired");
  });

  test("uses problem signature and symbol overlap rather than embeddings alone", async () => {
    const match = (await retrieve(query))[0];
    expect(match.reasons).toEqual(expect.arrayContaining(["problem_signature", "symbol_overlap", "repository_match"]));
  });

  test("retains failed approaches as negative evidence", async () => {
    const failed = (await retrieve(query)).find(match => match.id === "failed");
    expect(failed?.experience.outcome).toBe("failure");
    expect(failed?.experience.verification).toContain("regression failed");
  });

  test("requires verification evidence for successful experiences", async () => {
    const unverified: Experience = { ...experiences[0], id: "unverified", verification: [], confidence: 1 };
    expect((await retrieve(query, [unverified])).map(match => match.id)).not.toContain("unverified");
  });

  test("downranks revision-incompatible experience", async () => {
    const old = { ...experiences[0], id: "old-revision", revision: "v1" };
    const ids = (await retrieve(query, [old, experiences[0]])).map(match => match.id);
    expect(ids.indexOf("exact")).toBeLessThan(ids.indexOf("old-revision"));
  });

  test("returns bounded deterministic results", async () => {
    const many = Array.from({ length: 20 }, (_, index) => ({ ...experiences[0], id: `e-${index}`, createdAt: index }));
    const first = await retrieve(query, many);
    expect(first).toHaveLength(3);
    expect(first).toEqual(await retrieve(query, [...many].reverse()));
  });

  test("does not return arbitrary prose without typed repository identity", async () => {
    const malformed = { ...experiences[0], id: "malformed", repository: "" };
    expect((await retrieve(query, [malformed])).map(match => match.id)).not.toContain("malformed");
  });
});
