import { performance } from "node:perf_hooks";
import { describe, expect, test } from "bun:test";
import { fixtureRoot, productionModule, removeFixture, shaPattern, writeFixture } from "./helpers";

async function landscape(): Promise<{ root: string; globalDir: string; projectDir: string }> {
  const root = await fixtureRoot("extension-audit");
  const globalDir = `${root}/global`;
  const projectDir = `${root}/project`;
  await writeFixture(globalDir, "packages/safe/package.json", JSON.stringify({
    name: "safe-package", version: "1.0.0", license: "MIT", pi: { extensions: ["./index.ts"] },
  }));
  await writeFixture(globalDir, "packages/safe/index.ts", `export default function(pi:any){pi.on("context",()=>{});pi.registerTool({name:"shared_tool"});}`);
  await writeFixture(projectDir, "packages/safe/package.json", JSON.stringify({
    name: "safe-package", version: "1.1.0", license: "MIT", pi: { extensions: ["./index.ts"] },
  }));
  await writeFixture(projectDir, "packages/safe/index.ts", `export default function(pi:any){pi.on("context",()=>{});pi.registerTool({name:"shared_tool"});}`);
  await writeFixture(projectDir, "packages/risky/package.json", JSON.stringify({
    name: "risky-package", version: "0.1.0", dependencies: { floating: "github:user/repo#main" },
    pi: { extensions: ["./index.ts", "../escape.ts"] },
  }));
  await writeFixture(projectDir, "packages/risky/index.ts", `import {exec} from "node:child_process";export default function(pi:any){pi.on("context",()=>{});pi.on("session_before_compact",()=>{});pi.registerTool({name:"shared_tool"});fetch("https://example.com");exec("echo unsafe");}`);
  return { root, globalDir, projectDir };
}

describe("RED: extension supply-chain and hook-topology auditor", () => {
  test("discovers global and project packages with project precedence", async () => {
    const dirs = await landscape();
    try {
      const { auditPiExtensionLandscape } = await productionModule("extension-auditor");
      const audit = await auditPiExtensionLandscape(dirs);
      expect(audit.packages.filter((item: any) => item.name === "safe-package")).toHaveLength(1);
      expect(audit.packages.find((item: any) => item.name === "safe-package").version).toBe("1.1.0");
      expect(audit.packages.find((item: any) => item.name === "safe-package").scope).toBe("project");
    } finally { await removeFixture(dirs.root); }
  });

  test("hashes every loaded resource and produces a deterministic harness fingerprint", async () => {
    const dirs = await landscape();
    try {
      const { auditPiExtensionLandscape } = await productionModule("extension-auditor");
      const first = await auditPiExtensionLandscape(dirs);
      const second = await auditPiExtensionLandscape(dirs);
      expect(first.fingerprint).toMatch(shaPattern());
      expect(first.fingerprint).toBe(second.fingerprint);
      expect(first.resources.every((item: any) => shaPattern().test(item.contentHash))).toBe(true);
    } finally { await removeFixture(dirs.root); }
  });

  test("detects tool, command, and lifecycle-hook collisions", async () => {
    const dirs = await landscape();
    try {
      const { auditPiExtensionLandscape } = await productionModule("extension-auditor");
      const audit = await auditPiExtensionLandscape(dirs);
      expect(audit.collisions.tools).toContainEqual(expect.objectContaining({ name: "shared_tool" }));
      expect(audit.collisions.hooks).toContainEqual(expect.objectContaining({ event: "context" }));
      expect(audit.hookTopology.find((item: any) => item.event === "session_before_compact").packages).toContain("risky-package");
    } finally { await removeFixture(dirs.root); }
  });

  test("flags process, network, filesystem, and prompt/context mutation capabilities", async () => {
    const dirs = await landscape();
    try {
      const { auditPiExtensionLandscape } = await productionModule("extension-auditor");
      const risky = (await auditPiExtensionLandscape(dirs)).packages.find((item: any) => item.name === "risky-package");
      expect(risky.capabilities).toEqual(expect.arrayContaining(["process_execution", "network", "context_mutation", "compaction_interception"]));
      expect(risky.risk.level).toBe("high");
    } finally { await removeFixture(dirs.root); }
  });

  test("rejects package manifest resources that escape their package root", async () => {
    const dirs = await landscape();
    try {
      const { auditPiExtensionLandscape } = await productionModule("extension-auditor");
      const audit = await auditPiExtensionLandscape(dirs);
      expect(audit.findings).toContainEqual(expect.objectContaining({ code: "resource_path_escape", package: "risky-package" }));
    } finally { await removeFixture(dirs.root); }
  });

  test("flags unpinned git dependencies and missing license metadata", async () => {
    const dirs = await landscape();
    try {
      const { auditPiExtensionLandscape } = await productionModule("extension-auditor");
      const findings = (await auditPiExtensionLandscape(dirs)).findings;
      expect(findings).toEqual(expect.arrayContaining([
        expect.objectContaining({ code: "unpinned_git_dependency" }),
        expect.objectContaining({ code: "missing_license" }),
      ]));
    } finally { await removeFixture(dirs.root); }
  });

  test("detects package drift without storing source content", async () => {
    const dirs = await landscape();
    try {
      const { auditPiExtensionLandscape, diffExtensionAudits } = await productionModule("extension-auditor");
      const before = await auditPiExtensionLandscape(dirs);
      await writeFixture(dirs.projectDir, "packages/safe/index.ts", `export default function(pi:any){pi.on("tool_call",()=>{});}`);
      const after = await auditPiExtensionLandscape(dirs);
      const diff = diffExtensionAudits(before, after);
      expect(diff.changedPackages).toContain("safe-package");
      expect(JSON.stringify(diff)).not.toContain("export default");
    } finally { await removeFixture(dirs.root); }
  });

  test("audits the real Keylime extension tree and maps its major hooks", async () => {
    const { auditCurrentHarness } = await productionModule("extension-auditor");
    const audit = await auditCurrentHarness(process.cwd());
    expect(audit.hookTopology.find((item: any) => item.event === "session_before_compact").resources).toEqual(expect.arrayContaining([
      "extensions/structured-compaction.ts",
      "extensions/context-runtime.ts",
    ]));
    expect(audit.fingerprint).toMatch(shaPattern());
  });

  test("bounds source traversal and retained audit metadata", async () => {
    const root = await fixtureRoot("extension-audit-volume");
    try {
      for (let index = 0; index < 100; index++) {
        await writeFixture(root, `project/packages/pkg-${index}/package.json`, JSON.stringify({ name: `pkg-${index}`, version: "1.0.0", pi: { extensions: ["./index.ts"] } }));
        await writeFixture(root, `project/packages/pkg-${index}/index.ts`, `export default function(pi:any){pi.on("turn_end",()=>{});}//${"x".repeat(10_000)}`);
      }
      const { auditPiExtensionLandscape } = await productionModule("extension-auditor");
      const started = performance.now();
      const audit = await auditPiExtensionLandscape({ globalDir: `${root}/global`, projectDir: `${root}/project`, maxFiles: 500, maxSourceCharsPerFile: 20_000 });
      expect(audit.stats.filesRead).toBeLessThanOrEqual(200);
      expect(audit.stats.retainedSourceChars).toBe(0);
      expect(performance.now() - started).toBeLessThan(1_500);
    } finally { await removeFixture(root); }
  });

  test("renders a privacy-safe audit report without absolute paths or source", async () => {
    const dirs = await landscape();
    try {
      const { auditPiExtensionLandscape, renderExtensionAuditReport } = await productionModule("extension-auditor");
      const report = renderExtensionAuditReport(await auditPiExtensionLandscape(dirs));
      expect(report).toContain("risky-package");
      expect(report).not.toContain(dirs.root);
      expect(report).not.toContain("child_process");
      expect(report.length).toBeLessThan(20_000);
    } finally { await removeFixture(dirs.root); }
  });
});
