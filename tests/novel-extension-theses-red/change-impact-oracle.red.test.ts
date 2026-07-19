import { performance } from "node:perf_hooks";
import { describe, expect, test } from "bun:test";
import { fixtureRoot, productionModule, removeFixture, writeFixture } from "./helpers";

async function repository() {
  const cwd = await fixtureRoot("impact-oracle");
  await writeFixture(cwd, "src/config.ts", `export const timeout = 1000;`);
  await writeFixture(cwd, "src/parser.ts", `import {timeout} from "./config"; export function parse(){ return timeout; }`);
  await writeFixture(cwd, "src/service.ts", `import {parse} from "./parser"; export function service(){ return parse(); }`);
  await writeFixture(cwd, "src/lazy.ts", `export async function lazy(){ return import("./parser"); }`);
  await writeFixture(cwd, "src/cycle-a.ts", `import "./cycle-b"; export const a = 1;`);
  await writeFixture(cwd, "src/cycle-b.ts", `import "./cycle-a"; export const b = 1;`);
  await writeFixture(cwd, "tests/parser.test.ts", `import {parse} from "../src/parser"; test("parse",()=>parse());`);
  await writeFixture(cwd, "tests/service.test.ts", `import {service} from "../src/service"; test("service",()=>service());`);
  await writeFixture(cwd, "package.json", JSON.stringify({ scripts: { test: "bun test", typecheck: "tsc --noEmit" } }));
  await writeFixture(cwd, "tsconfig.json", JSON.stringify({ compilerOptions: { strict: true } }));
  await writeFixture(cwd, "bun.lock", "lockfile");
  return cwd;
}

describe("RED: change-impact oracle and adaptive verification", () => {
  test("computes reverse dependency impact from real source imports", async () => {
    const cwd = await repository();
    try {
      const { buildChangeImpactPlan } = await productionModule("change-impact-oracle");
      const plan = await buildChangeImpactPlan({ cwd, changedPaths: ["src/parser.ts"] });
      expect(plan.affectedFiles).toEqual(expect.arrayContaining(["src/parser.ts", "src/service.ts", "src/lazy.ts"]));
      expect(plan.edges).toContainEqual(expect.objectContaining({ from: "src/service.ts", to: "src/parser.ts", kind: "imports" }));
    } finally { await removeFixture(cwd); }
  });

  test("selects directly and transitively affected behavioral tests", async () => {
    const cwd = await repository();
    try {
      const { buildChangeImpactPlan } = await productionModule("change-impact-oracle");
      const plan = await buildChangeImpactPlan({ cwd, changedPaths: ["src/parser.ts"] });
      expect(plan.selectedTests).toEqual(expect.arrayContaining(["tests/parser.test.ts", "tests/service.test.ts"]));
      expect(plan.verificationCommands[0]).toMatch(/bun test/);
    } finally { await removeFixture(cwd); }
  });

  test("handles dynamic imports and dependency cycles without recursion failure", async () => {
    const cwd = await repository();
    try {
      const { buildChangeImpactPlan } = await productionModule("change-impact-oracle");
      const dynamic = await buildChangeImpactPlan({ cwd, changedPaths: ["src/parser.ts"] });
      expect(dynamic.affectedFiles).toContain("src/lazy.ts");
      const cyclic = await buildChangeImpactPlan({ cwd, changedPaths: ["src/cycle-a.ts"] });
      expect(cyclic.affectedFiles).toEqual(expect.arrayContaining(["src/cycle-a.ts", "src/cycle-b.ts"]));
      expect(new Set(cyclic.affectedFiles).size).toBe(cyclic.affectedFiles.length);
    } finally { await removeFixture(cwd); }
  });

  test("escalates configuration and lockfile changes to repository-wide verification", async () => {
    const cwd = await repository();
    try {
      const { buildChangeImpactPlan } = await productionModule("change-impact-oracle");
      const config = await buildChangeImpactPlan({ cwd, changedPaths: ["tsconfig.json"] });
      const lock = await buildChangeImpactPlan({ cwd, changedPaths: ["bun.lock"] });
      expect(config.risk.level).toBe("high");
      expect(config.verificationCommands).toEqual(expect.arrayContaining(["bun run typecheck", "bun test"]));
      expect(lock.scope).toBe("repository");
    } finally { await removeFixture(cwd); }
  });

  test("retains impact evidence for deleted files", async () => {
    const cwd = await repository();
    try {
      const { buildChangeImpactPlan } = await productionModule("change-impact-oracle");
      const plan = await buildChangeImpactPlan({ cwd, changedPaths: ["src/parser.ts"], deletedPaths: ["src/parser.ts"] });
      expect(plan.affectedFiles).toContain("src/service.ts");
      expect(plan.risk.reasons).toContain("deleted_dependency");
    } finally { await removeFixture(cwd); }
  });

  test("explains every test selection through an import or symbol path", async () => {
    const cwd = await repository();
    try {
      const { buildChangeImpactPlan, explainImpactSelection } = await productionModule("change-impact-oracle");
      const plan = await buildChangeImpactPlan({ cwd, changedPaths: ["src/config.ts"] });
      const explanation = explainImpactSelection(plan, "tests/service.test.ts");
      expect(explanation.path).toEqual(["tests/service.test.ts", "src/service.ts", "src/parser.ts", "src/config.ts"]);
      expect(explanation.reason).toMatch(/transitive|import/i);
    } finally { await removeFixture(cwd); }
  });

  test("expands verification after a targeted failure instead of repeating the same set", async () => {
    const cwd = await repository();
    try {
      const { buildChangeImpactPlan, expandImpactPlan } = await productionModule("change-impact-oracle");
      const plan = await buildChangeImpactPlan({ cwd, changedPaths: ["src/service.ts"] });
      const expanded = expandImpactPlan(plan, { command: "bun test tests/service.test.ts", passed: false, diagnosticPaths: ["src/config.ts"] });
      expect(expanded.selectedTests.length).toBeGreaterThan(plan.selectedTests.length);
      expect(expanded.risk.level).toBe("high");
      expect(expanded.escalationHistory).toHaveLength(1);
    } finally { await removeFixture(cwd); }
  });

  test("accepts optional LSP signals without requiring an LSP process", async () => {
    const cwd = await repository();
    try {
      const { buildChangeImpactPlan } = await productionModule("change-impact-oracle");
      const plan = await buildChangeImpactPlan({
        cwd,
        changedPaths: ["src/parser.ts"],
        lspSignals: [{ kind: "incoming_call", from: "src/service.ts", to: "src/parser.ts" }],
        lspEnabled: false,
      });
      expect(plan.stats.lspProcessesSpawned).toBe(0);
      expect(plan.affectedFiles).toContain("src/service.ts");
    } finally { await removeFixture(cwd); }
  });

  test("uses one repository scan for impact, evidence, and test discovery", async () => {
    const cwd = await repository();
    try {
      const { buildChangeImpactPlan } = await productionModule("change-impact-oracle");
      const plan = await buildChangeImpactPlan({ cwd, changedPaths: ["src/parser.ts"] });
      expect(plan.stats.repositoryScans).toBe(1);
      expect(plan.stats.filesParsed).toBeLessThanOrEqual(10);
      expect(plan.stats.duplicateFileReads).toBe(0);
    } finally { await removeFixture(cwd); }
  });

  test("stays bounded on a thousand-file repository", async () => {
    const cwd = await fixtureRoot("impact-volume");
    try {
      for (let index = 0; index < 1_000; index++) await writeFixture(cwd, `src/file-${index}.ts`, index ? `import "./file-${index - 1}"; export const value${index}=${index};` : "export const value0=0;");
      await writeFixture(cwd, "tests/tail.test.ts", `import "../src/file-999"; test("tail",()=>{});`);
      const { buildChangeImpactPlan } = await productionModule("change-impact-oracle");
      const started = performance.now();
      const plan = await buildChangeImpactPlan({ cwd, changedPaths: ["src/file-500.ts"], maxFiles: 2_000, maxEdges: 5_000 });
      expect(plan.stats.filesParsed).toBeLessThanOrEqual(1_001);
      expect(plan.edges.length).toBeLessThanOrEqual(5_000);
      expect(performance.now() - started).toBeLessThan(2_000);
    } finally { await removeFixture(cwd); }
  });
});
