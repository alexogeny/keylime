import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { commandAvailable, requireApproved, runCommand, sudoPrefix, textResult } from "./shared/linux-safety";

const pkgArray = Type.Array(Type.String(), { minItems: 1, maxItems: 50 });
const PACKAGE_NAME_RE = /^[A-Za-z0-9][A-Za-z0-9+._:@-]*$/;
const inspectGuidelines = ["Use package inspection before install/remove.", "Keep package queries narrow; do not run broad upgrades from these tools."];
function validatePackageNames(packages: string[]): string[] {
  for (const pkg of packages) {
    if (!PACKAGE_NAME_RE.test(pkg) || pkg.startsWith("-")) throw new Error(`Invalid package name: ${pkg}`);
  }
  return packages;
}
const mutationGuidelines = ["Run the matching plan tool first and show the transaction.", "Ask for command review and sudo approval before mutation.", "Never use this for broad distro upgrades."];

async function distroPm() {
  if (await commandAvailable("apt-get")) return "apt";
  if (await commandAvailable("pacman")) return "pacman";
  return "unknown";
}

export default function (pi: ExtensionAPI) {
  pi.registerTool({ name: "inspect_os_release", label: "Inspect OS Release", description: "Inspect Linux distribution metadata from /etc/os-release.", promptGuidelines: inspectGuidelines, parameters: Type.Object({}), async execute() {
    const r = await runCommand({ command: "cat", args: ["/etc/os-release"] });
    return textResult(r.stdout, { package_manager: await distroPm() });
  }});

  pi.registerTool({ name: "apt_search", label: "APT Search", description: "Search Debian/Ubuntu APT package metadata.", promptGuidelines: inspectGuidelines, parameters: Type.Object({ query: Type.String() }), async execute(_id: string, params: any) {
    const r = await runCommand({ command: "apt-cache", args: ["search", params.query] });
    return textResult(r.stdout || "No matches", { query: params.query });
  }});
  pi.registerTool({ name: "apt_policy", label: "APT Policy", description: "Inspect installed/candidate versions for APT packages.", promptGuidelines: inspectGuidelines, parameters: Type.Object({ packages: pkgArray }), async execute(_id: string, params: any) {
    const packages = validatePackageNames(params.packages);
    const r = await runCommand({ command: "apt-cache", args: ["policy", ...packages] });
    return textResult(r.stdout, { packages });
  }});
  pi.registerTool({ name: "apt_plan_install", label: "APT Plan Install", description: "Dry-run an APT install transaction.", promptGuidelines: inspectGuidelines, parameters: Type.Object({ packages: pkgArray }), async execute(_id: string, params: any) {
    const packages = validatePackageNames(params.packages);
    const r = await runCommand({ command: "apt-get", args: ["-s", "install", ...packages] });
    return textResult(r.stdout || r.stderr, { command: "apt-get -s install", packages });
  }});
  pi.registerTool({ name: "apt_install", label: "APT Install", description: "Install packages with apt-get after prior dry-run review and sudo approval.", promptGuidelines: mutationGuidelines, parameters: Type.Object({ packages: pkgArray, assume_yes: Type.Optional(Type.Boolean()) }), async execute(_id: string, params: any, _signal: any, _onUpdate: any, ctx: any) {
    const packages = validatePackageNames(params.packages);
    await requireApproved(ctx, "Review APT install", `sudo apt-get install ${params.assume_yes ? "-y " : ""}${packages.join(" ")}`);
    const spec = await sudoPrefix(ctx, { command: "apt-get", args: ["install", ...(params.assume_yes ? ["-y"] : []), ...packages], sudo: true });
    const r = await runCommand(spec, { timeoutMs: 120_000, maxBuffer: 2 * 1024 * 1024 });
    return textResult([r.stdout, r.stderr].filter(Boolean).join("\n"), { packages });
  }});
  pi.registerTool({ name: "apt_plan_remove", label: "APT Plan Remove", description: "Dry-run an APT remove transaction.", promptGuidelines: inspectGuidelines, parameters: Type.Object({ packages: pkgArray }), async execute(_id: string, params: any) {
    const packages = validatePackageNames(params.packages);
    const r = await runCommand({ command: "apt-get", args: ["-s", "remove", ...packages] });
    return textResult(r.stdout || r.stderr, { packages });
  }});

  pi.registerTool({ name: "pacman_search", label: "Pacman Search", description: "Search Arch/Cachy pacman repositories.", promptGuidelines: inspectGuidelines, parameters: Type.Object({ query: Type.String() }), async execute(_id: string, params: any) {
    const r = await runCommand({ command: "pacman", args: ["-Ss", params.query] });
    return textResult(r.stdout || "No matches", { query: params.query });
  }});
  pi.registerTool({ name: "pacman_query", label: "Pacman Query", description: "Inspect installed Arch packages.", promptGuidelines: inspectGuidelines, parameters: Type.Object({ packages: Type.Optional(Type.Array(Type.String(), { maxItems: 50 })) }), async execute(_id: string, params: any) {
    const packages = params.packages?.length ? validatePackageNames(params.packages) : [];
    const args = packages.length ? ["-Qi", ...packages] : ["-Q"];
    const r = await runCommand({ command: "pacman", args });
    return textResult(r.stdout, { packages });
  }});
  pi.registerTool({ name: "pacman_plan_install", label: "Pacman Plan Install", description: "Preview a pacman install transaction without applying it.", promptGuidelines: inspectGuidelines, parameters: Type.Object({ packages: pkgArray }), async execute(_id: string, params: any) {
    const packages = validatePackageNames(params.packages);
    const r = await runCommand({ command: "pacman", args: ["-S", "--print", "--needed", ...packages] });
    return textResult(r.stdout || r.stderr, { packages });
  }});
  pi.registerTool({ name: "pacman_install", label: "Pacman Install", description: "Install Arch packages after transaction review and sudo approval.", promptGuidelines: mutationGuidelines, parameters: Type.Object({ packages: pkgArray }), async execute(_id: string, params: any, _signal: any, _onUpdate: any, ctx: any) {
    const packages = validatePackageNames(params.packages);
    await requireApproved(ctx, "Review pacman install", `sudo pacman -S --needed ${packages.join(" ")}`);
    const spec = await sudoPrefix(ctx, { command: "pacman", args: ["-S", "--needed", ...packages], sudo: true });
    const r = await runCommand(spec, { timeoutMs: 120_000, maxBuffer: 2 * 1024 * 1024 });
    return textResult([r.stdout, r.stderr].filter(Boolean).join("\n"), { packages });
  }});
}
