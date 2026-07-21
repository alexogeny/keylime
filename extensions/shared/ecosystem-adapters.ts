import { createHash } from "node:crypto";
import { storeContextObject } from "../context-object-store";

const sha = (value: string): string => createHash("sha256").update(value).digest("hex");

export type EcosystemToolKind = "mcp" | "lsp" | "subagent" | "external_context" | "router" | "native";
export function classifyEcosystemTool(toolName: string): EcosystemToolKind {
  const name = toolName.toLowerCase();
  if (/(?:^|[_-])mcp(?:[_-]|$)|^mcp__/.test(name)) return "mcp";
  if (/(?:^|[_-])lsp(?:[_-]|$)|language.?server/.test(name)) return "lsp";
  if (/subagent|sub_agent|workflow|delegate/.test(name)) return "subagent";
  if (/context.?mode|\bvcc\b|external.?context/.test(name)) return "external_context";
  if (/router|route_model|model_route/.test(name)) return "router";
  return "native";
}

export function createEcosystemAdapters(options: { cwd?: string; lspOwnership?: "external" | "keylime" } = {}) {
  const externalObjects = new Map<string, string>();
  let processesSpawned = 0;
  return {
    ingestMcpCatalog(serverId: string, tools: any[]) {
      const names = tools.slice(0, 10_000).map(tool => String(tool.name ?? "tool").slice(0, 200)).sort();
      const bootstrapTools = [{ name: "discover_mcp_tools", serverId: String(serverId).slice(0, 200), description: "Search the deferred MCP tool catalog by name and capability." }];
      return { serverId: String(serverId).slice(0, 200), bootstrapTools, bootstrapChars: JSON.stringify(bootstrapTools).length, deferredTools: names.length, catalogFingerprint: sha(names.join("\n")) };
    },
    ingestLspResult(result: any) {
      const rawLocations = (Array.isArray(result?.locations) ? result.locations : result?.location ? [result.location] : []).slice(0, 1_000);
      let rejectedLocations = 0;
      const locations = rawLocations.flatMap((location: any) => {
        const raw = String(location?.uri ?? location?.path ?? "").replace(/^file:\/\//, "").replace(/\\/g, "/");
        const marker = raw.lastIndexOf("/src/");
        if (marker < 0 && !raw.startsWith("src/")) { rejectedLocations++; return []; }
        const path = marker >= 0 ? raw.slice(marker + 1) : raw;
        if (!path || path === ".." || path.startsWith("../") || path.includes("/../")) { rejectedLocations++; return []; }
        return [{ path, line: Number(location?.range?.start?.line ?? 0) + 1 }];
      });
      const queryPath = String(result?.query?.path ?? "").replace(/\\/g, "/").replace(/^\.\//, "");
      const edges = result?.operation === "findReferences" && queryPath
        ? locations.filter((location: any) => location.path !== queryPath).map((location: any) => ({ kind: "lsp", from: location.path, to: queryPath }))
        : [];
      return {
        kind: result?.operation === "findReferences" ? "reference" : String(result?.operation ?? "lsp_signal"),
        path: locations[0]?.path ?? "", line: locations[0]?.line ?? 0, locations, edges, rejectedLocations,
      };
    },
    ingestSubagentResult(result: any) {
      return {
        provider: String(result?.provider ?? "unknown").slice(0, 100), contractId: String(result?.contractId ?? "").slice(0, 200),
        summary: String(result?.summary ?? "").slice(0, 2_000), evidenceObjectIds: (result?.evidenceObjectIds ?? []).map(String).slice(0, 1_000),
        verification: (result?.verification ?? []).slice(0, 100).map((item: any) => ({ command: String(item.command ?? "").slice(0, 500), passed: Boolean(item.passed) })),
        requiresContractValidation: true,
      };
    },
    async ingestExternalContext(input: { provider: string; id: string; payload: string }) {
      if (!options.cwd) throw new Error("cwd is required for external context ingestion");
      const contentHash = sha(String(input.payload));
      const existing = externalObjects.get(contentHash);
      if (existing) return { objectId: existing, contentHash, deduplicated: true };
      const objectId = `external-${contentHash.slice(0, 40)}`;
      const stored = await storeContextObject(options.cwd, {
        id: objectId, kind: "generic", sourceTool: `adapter:${String(input.provider).slice(0, 80)}`,
        content: String(input.payload), summary: `External context (${String(input.provider).slice(0, 80)})`, retention: "foldable",
      });
      externalObjects.set(contentHash, stored.object.id);
      return { objectId: stored.object.id, contentHash, deduplicated: false };
    },
    stats() { return { processesSpawned, externalObjects: externalObjects.size, lspOwnership: options.lspOwnership ?? "external" }; },
  };
}
