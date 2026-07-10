import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { commandAvailable, consumeOperationPlan, createOperationPlan, operationTarget, registerLinuxTool, requireApproved, runCommand, sudoPrefix, textResult, validateOperand } from "./shared/linux-safety";

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
  registerLinuxTool(pi, { name: "inspect_os_release", label: "Inspect OS Release", description: "Inspect Linux distribution metadata from /etc/os-release.", promptGuidelines: inspectGuidelines, parameters: Type.Object({}), async execute() {
    const r = await runCommand({ command: "cat", args: ["/etc/os-release"] });
    return textResult(r.stdout, { package_manager: await distroPm() });
  }});

  registerLinuxTool(pi, { name: "apt_search", label: "APT Search", description: "Search Debian/Ubuntu APT package metadata.", promptGuidelines: inspectGuidelines, parameters: Type.Object({ query: Type.String() }), async execute(_id: string, params: any) {
    const r = await runCommand({ command: "apt-cache", args: ["search", validateOperand(params.query, "APT query")] });
    return textResult(r.stdout || "No matches", { query: params.query });
  }});
  registerLinuxTool(pi, { name: "apt_policy", label: "APT Policy", description: "Inspect installed/candidate versions for APT packages.", promptGuidelines: inspectGuidelines, parameters: Type.Object({ packages: pkgArray }), async execute(_id: string, params: any) {
    const packages = validatePackageNames(params.packages);
    const r = await runCommand({ command: "apt-cache", args: ["policy", ...packages] });
    return textResult(r.stdout, { packages });
  }});
  registerLinuxTool(pi, { name: "apt_plan_install", label: "APT Plan Install", description: "Dry-run an APT install transaction.", promptGuidelines: inspectGuidelines, parameters: Type.Object({ packages: pkgArray }), async execute(_id: string, params: any) {
    const packages = validatePackageNames(params.packages);
    const r = await runCommand({ command: "apt-get", args: ["-s", "install", ...packages] });
    const plan = createOperationPlan("apt-install", operationTarget(packages));
    return textResult(r.stdout || r.stderr, { command: "apt-get -s install", packages, plan_token: plan.planToken, expires_at: plan.expiresAt });
  }});
  registerLinuxTool(pi, { name: "apt_install", label: "APT Install", description: "Install packages with apt-get after prior dry-run review and sudo approval.", promptGuidelines: mutationGuidelines, parameters: Type.Object({ packages: pkgArray, plan_token: Type.String(), assume_yes: Type.Optional(Type.Boolean()) }), async execute(_id: string, params: any, _signal: any, _onUpdate: any, ctx: any) {
    const packages = validatePackageNames(params.packages);
    consumeOperationPlan(params.plan_token, "apt-install", operationTarget(packages));
    await requireApproved(ctx, "Review APT install", `sudo apt-get install ${params.assume_yes ? "-y " : ""}${packages.join(" ")}`);
    const spec = await sudoPrefix(ctx, { command: "apt-get", args: ["install", ...(params.assume_yes ? ["-y"] : []), ...packages], sudo: true });
    const r = await runCommand(spec, { timeoutMs: 120_000, maxBuffer: 2 * 1024 * 1024 });
    return textResult([r.stdout, r.stderr].filter(Boolean).join("\n"), { packages });
  }});
  registerLinuxTool(pi, { name: "apt_plan_remove", label: "APT Plan Remove", description: "Dry-run an APT remove transaction.", promptGuidelines: inspectGuidelines, parameters: Type.Object({ packages: pkgArray }), async execute(_id: string, params: any) {
    const packages = validatePackageNames(params.packages);
    const r = await runCommand({ command: "apt-get", args: ["-s", "remove", ...packages] });
    const plan = createOperationPlan("apt-remove", operationTarget(packages));
    return textResult(r.stdout || r.stderr, { packages, plan_token: plan.planToken, expires_at: plan.expiresAt });
  }});

  registerLinuxTool(pi, { name: "pacman_search", label: "Pacman Search", description: "Search Arch/Cachy pacman repositories.", promptGuidelines: inspectGuidelines, parameters: Type.Object({ query: Type.String() }), async execute(_id: string, params: any) {
    const r = await runCommand({ command: "pacman", args: ["-Ss", "--", validateOperand(params.query, "Pacman query")] });
    return textResult(r.stdout || "No matches", { query: params.query });
  }});
  registerLinuxTool(pi, { name: "pacman_query", label: "Pacman Query", description: "Inspect installed Arch packages.", promptGuidelines: inspectGuidelines, parameters: Type.Object({ packages: Type.Optional(Type.Array(Type.String(), { maxItems: 50 })) }), async execute(_id: string, params: any) {
    const packages = params.packages?.length ? validatePackageNames(params.packages) : [];
    const args = packages.length ? ["-Qi", ...packages] : ["-Q"];
    const r = await runCommand({ command: "pacman", args });
    return textResult(r.stdout, { packages });
  }});
  registerLinuxTool(pi, { name: "pacman_plan_install", label: "Pacman Plan Install", description: "Preview a pacman install transaction without applying it.", promptGuidelines: inspectGuidelines, parameters: Type.Object({ packages: pkgArray }), async execute(_id: string, params: any) {
    const packages = validatePackageNames(params.packages);
    const r = await runCommand({ command: "pacman", args: ["-S", "--print", "--needed", ...packages] });
    const plan = createOperationPlan("pacman-install", operationTarget(packages));
    return textResult(r.stdout || r.stderr, { packages, plan_token: plan.planToken, expires_at: plan.expiresAt });
  }});
  registerLinuxTool(pi, { name: "pacman_install", label: "Pacman Install", description: "Install Arch packages after transaction review and sudo approval.", promptGuidelines: mutationGuidelines, parameters: Type.Object({ packages: pkgArray, plan_token: Type.String() }), async execute(_id: string, params: any, _signal: any, _onUpdate: any, ctx: any) {
    const packages = validatePackageNames(params.packages);
    consumeOperationPlan(params.plan_token, "pacman-install", operationTarget(packages));
    await requireApproved(ctx, "Review pacman install", `sudo pacman -S --needed ${packages.join(" ")}`);
    const spec = await sudoPrefix(ctx, { command: "pacman", args: ["-S", "--needed", ...packages], sudo: true });
    const r = await runCommand(spec, { timeoutMs: 120_000, maxBuffer: 2 * 1024 * 1024 });
    return textResult([r.stdout, r.stderr].filter(Boolean).join("\n"), { packages });
  }});

  registerLinuxTool(pi, { name: "apt_remove", label: "APT Remove", description: "Remove packages after a matching dry-run plan and sudo approval.", promptGuidelines: mutationGuidelines, parameters: Type.Object({ packages: pkgArray, plan_token: Type.String() }), async execute(_id: string, params: any, _signal: any, _onUpdate: any, ctx: any) {
    const packages = validatePackageNames(params.packages);
    consumeOperationPlan(params.plan_token, "apt-remove", operationTarget(packages));
    await requireApproved(ctx, "Review APT remove", `sudo apt-get remove ${packages.join(" ")}`);
    const spec = await sudoPrefix(ctx, { command: "apt-get", args: ["remove", ...packages], sudo: true });
    const r = await runCommand(spec, { timeoutMs: 120_000, maxBuffer: 2 * 1024 * 1024 });
    return textResult([r.stdout, r.stderr].filter(Boolean).join("\n"), { packages });
  }});

  registerLinuxTool(pi, { name: "pacman_plan_remove", label: "Pacman Plan Remove", description: "Preview removal of Arch packages without applying it.", promptGuidelines: inspectGuidelines, parameters: Type.Object({ packages: pkgArray }), async execute(_id: string, params: any) {
    const packages = validatePackageNames(params.packages);
    const r = await runCommand({ command: "pacman", args: ["-R", "--print", ...packages] });
    const plan = createOperationPlan("pacman-remove", operationTarget(packages));
    return textResult(r.stdout || r.stderr, { packages, plan_token: plan.planToken, expires_at: plan.expiresAt });
  }});

  registerLinuxTool(pi, { name: "pacman_remove", label: "Pacman Remove", description: "Remove Arch packages after a matching plan and sudo approval.", promptGuidelines: mutationGuidelines, parameters: Type.Object({ packages: pkgArray, plan_token: Type.String() }), async execute(_id: string, params: any, _signal: any, _onUpdate: any, ctx: any) {
    const packages = validatePackageNames(params.packages);
    consumeOperationPlan(params.plan_token, "pacman-remove", operationTarget(packages));
    await requireApproved(ctx, "Review pacman remove", `sudo pacman -R ${packages.join(" ")}`);
    const spec = await sudoPrefix(ctx, { command: "pacman", args: ["-R", ...packages], sudo: true });
    const r = await runCommand(spec, { timeoutMs: 120_000, maxBuffer: 2 * 1024 * 1024 });
    return textResult([r.stdout, r.stderr].filter(Boolean).join("\n"), { packages });
  }});
}
