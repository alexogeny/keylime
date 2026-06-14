import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { commandAvailable, requireApproved, runCommand, sudoPrefix, textResult } from "./shared/linux-safety";

const pkgArray = Type.Array(Type.String(), { minItems: 1, maxItems: 50 });
const inspectGuidelines = ["Use package inspection before install/remove.", "Keep package queries narrow; do not run broad upgrades from these tools."];
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

  pi.registerTool({ name: "apt_search", label: "APT Search", description: "Search Debian/Ubuntu APT package metadata.", promptGuidelines: inspectGuidelines, parameters: Type.Object({ query: Type.String() }), async execute(params: any) {
    const r = await runCommand({ command: "apt-cache", args: ["search", params.query] });
    return textResult(r.stdout || "No matches", { query: params.query });
  }});
  pi.registerTool({ name: "apt_policy", label: "APT Policy", description: "Inspect installed/candidate versions for APT packages.", promptGuidelines: inspectGuidelines, parameters: Type.Object({ packages: pkgArray }), async execute(params: any) {
    const r = await runCommand({ command: "apt-cache", args: ["policy", ...params.packages] });
    return textResult(r.stdout, { packages: params.packages });
  }});
  pi.registerTool({ name: "apt_plan_install", label: "APT Plan Install", description: "Dry-run an APT install transaction.", promptGuidelines: inspectGuidelines, parameters: Type.Object({ packages: pkgArray }), async execute(params: any) {
    const r = await runCommand({ command: "apt-get", args: ["-s", "install", ...params.packages] });
    return textResult(r.stdout || r.stderr, { command: "apt-get -s install", packages: params.packages });
  }});
  pi.registerTool({ name: "apt_install", label: "APT Install", description: "Install packages with apt-get after prior dry-run review and sudo approval.", promptGuidelines: mutationGuidelines, parameters: Type.Object({ packages: pkgArray, assume_yes: Type.Optional(Type.Boolean()) }), async execute(params: any, ctx: any) {
    await requireApproved(ctx, "Review APT install", `sudo apt-get install ${params.assume_yes ? "-y " : ""}${params.packages.join(" ")}`);
    const spec = await sudoPrefix(ctx, { command: "apt-get", args: ["install", ...(params.assume_yes ? ["-y"] : []), ...params.packages], sudo: true });
    const r = await runCommand(spec, { timeoutMs: 120_000, maxBuffer: 2 * 1024 * 1024 });
    return textResult([r.stdout, r.stderr].filter(Boolean).join("\n"), { packages: params.packages });
  }});
  pi.registerTool({ name: "apt_plan_remove", label: "APT Plan Remove", description: "Dry-run an APT remove transaction.", promptGuidelines: inspectGuidelines, parameters: Type.Object({ packages: pkgArray }), async execute(params: any) {
    const r = await runCommand({ command: "apt-get", args: ["-s", "remove", ...params.packages] });
    return textResult(r.stdout || r.stderr, { packages: params.packages });
  }});

  pi.registerTool({ name: "pacman_search", label: "Pacman Search", description: "Search Arch/Cachy pacman repositories.", promptGuidelines: inspectGuidelines, parameters: Type.Object({ query: Type.String() }), async execute(params: any) {
    const r = await runCommand({ command: "pacman", args: ["-Ss", params.query] });
    return textResult(r.stdout || "No matches", { query: params.query });
  }});
  pi.registerTool({ name: "pacman_query", label: "Pacman Query", description: "Inspect installed Arch packages.", promptGuidelines: inspectGuidelines, parameters: Type.Object({ packages: Type.Optional(Type.Array(Type.String(), { maxItems: 50 })) }), async execute(params: any) {
    const args = params.packages?.length ? ["-Qi", ...params.packages] : ["-Q"];
    const r = await runCommand({ command: "pacman", args });
    return textResult(r.stdout, { packages: params.packages ?? [] });
  }});
  pi.registerTool({ name: "pacman_plan_install", label: "Pacman Plan Install", description: "Preview a pacman install transaction without applying it.", promptGuidelines: inspectGuidelines, parameters: Type.Object({ packages: pkgArray }), async execute(params: any) {
    const r = await runCommand({ command: "pacman", args: ["-S", "--print", "--needed", ...params.packages] });
    return textResult(r.stdout || r.stderr, { packages: params.packages });
  }});
  pi.registerTool({ name: "pacman_install", label: "Pacman Install", description: "Install Arch packages after transaction review and sudo approval.", promptGuidelines: mutationGuidelines, parameters: Type.Object({ packages: pkgArray }), async execute(params: any, ctx: any) {
    await requireApproved(ctx, "Review pacman install", `sudo pacman -S --needed ${params.packages.join(" ")}`);
    const spec = await sudoPrefix(ctx, { command: "pacman", args: ["-S", "--needed", ...params.packages], sudo: true });
    const r = await runCommand(spec, { timeoutMs: 120_000, maxBuffer: 2 * 1024 * 1024 });
    return textResult([r.stdout, r.stderr].filter(Boolean).join("\n"), { packages: params.packages });
  }});
}
