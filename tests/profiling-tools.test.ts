import { describe, expect, test } from "bun:test";
import profilingTools, { buildPythonProfilePlan, buildRustProfilePlan, buildTypescriptProfilePlan } from "../extensions/profiling-tools";
import { classifyIntent } from "../extensions/shared/intent";
import { classifyToolMutation } from "../extensions/shared/safety-policy";
import { mockPiFixture } from "./helpers/mock-pi";

describe("profiling tools", () => {
  test("registers profiling orchestration tools", () => {
    const harness = mockPiFixture();
    profilingTools(harness.pi);
    expect(Object.keys(harness.tools)).toEqual(expect.arrayContaining([
      "inspect_profiler_availability",
      "plan_python_profile",
      "run_python_profile",
      "plan_typescript_profile",
      "run_typescript_profile",
      "plan_rust_profile",
      "run_rust_profile",
      "inspect_profile_artifact",
    ]));
  });

  test("builds safe preset profiler command plans", () => {
    expect(buildPythonProfilePlan({ mode: "script", path: "scripts/slow.py", args: ["--n", "10"], output: ".pi/profiles/python/slow.prof" }, "/repo")).toMatchObject({
      command: "python3",
      args: ["-m", "cProfile", "-s", "cumtime", "-o", ".pi/profiles/python/slow.prof", "scripts/slow.py", "--n", "10"],
    });
    expect(buildTypescriptProfilePlan({ runtime: "bun", mode: "file", path: "src/slow.ts", args: ["--n", "10"] }, "/repo")).toMatchObject({
      command: "bun",
      args: ["src/slow.ts", "--n", "10"],
    });
    expect(buildRustProfilePlan({ mode: "run", bin: "server", args: ["--once"] }, "/repo")).toMatchObject({
      command: "cargo",
      args: ["run", "--release", "--bin", "server", "--", "--once"],
    });
  });

  test("rejects unsafe profile paths", () => {
    expect(() => buildPythonProfilePlan({ mode: "script", path: "../slow.py" }, "/repo")).toThrow("Unsafe script");
    expect(() => buildTypescriptProfilePlan({ runtime: "bun", mode: "file", path: "/tmp/slow.ts" }, "/repo")).toThrow("Unsafe file");
    expect(() => buildRustProfilePlan({ mode: "run", bin: "../server" }, "/repo")).toThrow("Unsafe bin");
  });

  test("routes profiling intent and classifies profile runs as guarded execution", () => {
    const route = classifyIntent("profile this python bottleneck and make a flamegraph");
    expect(route.primaryIntent).toBe("profiling");
    expect(route.capabilityGroups).toContain("profiling");
    expect(classifyToolMutation("run_python_profile", {})).toMatchObject({ mutates: true, score: 8, checkpointScore: "major" });
  });
});
