import { createHash } from "node:crypto";
import { storeContextObject } from "../context-object-store";

const sha = (value: string): string => createHash("sha256").update(value).digest("hex");

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
      const location = result?.locations?.[0] ?? result?.location;
      const raw = String(location?.uri ?? location?.path ?? "").replace(/^file:\/\//, "");
      const marker = raw.lastIndexOf("/src/");
      const path = marker >= 0 ? raw.slice(marker + 1) : raw.replace(/^\/+/, "");
      return { kind: result?.operation === "findReferences" ? "reference" : String(result?.operation ?? "lsp_signal"), path, line: Number(location?.range?.start?.line ?? 0) + 1 };
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
