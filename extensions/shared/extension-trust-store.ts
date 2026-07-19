import { chmod, realpath } from "node:fs/promises";
import { createHash } from "node:crypto";
import { join } from "node:path";
import { readJsonFile, writeJsonFile } from "./json-store";

const queues = new Map<string, Promise<unknown>>();
const sha = (value: string): string => createHash("sha256").update(value).digest("hex");
const stable = (value: unknown): string => JSON.stringify(value, (_key, item) => item && typeof item === "object" && !Array.isArray(item)
  ? Object.fromEntries(Object.entries(item).sort(([a], [b]) => a.localeCompare(b))) : item);

type TrustEntry = {
  fingerprint: string; trustedAt: string; reason: string;
  packageFingerprints: Array<{ name: string; fingerprint: string }>;
  resourceHashes: string[];
};
type TrustState = { version: 1; repositoryFingerprint: string; entries: TrustEntry[]; checksum: string };

function checksum(value: Omit<TrustState, "checksum">): string { return sha(stable(value)); }
function validHash(value: unknown): value is string { return typeof value === "string" && /^[a-f0-9]{64}$/.test(value); }

export async function createExtensionTrustStore(options: { cwd: string; maxEntries?: number }) {
  const root = await realpath(options.cwd);
  const repositoryFingerprint = sha(root);
  const path = join(root, ".pi", "extension-trust-v1.json");
  const maxEntries = Math.max(1, Math.min(1_000, Math.floor(options.maxEntries ?? 50)));
  const blank = (): TrustState => {
    const body = { version: 1 as const, repositoryFingerprint, entries: [] as TrustEntry[] };
    return { ...body, checksum: checksum(body) };
  };
  const load = async (): Promise<TrustState> => {
    const state = await readJsonFile<TrustState | null>(path, null);
    if (!state) return blank();
    const body = { version: state.version, repositoryFingerprint: state.repositoryFingerprint, entries: state.entries };
    if (state.version !== 1 || state.repositoryFingerprint !== repositoryFingerprint || checksum(body) !== state.checksum) throw new Error("Invalid extension trust state checksum or repository identity");
    return state;
  };
  const enqueue = <T>(work: () => Promise<T>): Promise<T> => {
    const previous = queues.get(path) ?? Promise.resolve();
    const task = previous.catch(() => undefined).then(work);
    queues.set(path, task);
    return task.finally(() => { if (queues.get(path) === task) queues.delete(path); });
  };
  return {
    path,
    repositoryFingerprint,
    async state() { return load(); },
    async trust(audit: any, reason = "explicit trust") {
      if (!validHash(audit?.fingerprint)) throw new Error("Cannot trust an audit without a valid fingerprint");
      return enqueue(async () => {
        const current = await load();
        const entry: TrustEntry = {
          fingerprint: audit.fingerprint,
          trustedAt: new Date().toISOString(),
          reason: String(reason).replace(/[\r\n\t]+/g, " ").slice(0, 300),
          packageFingerprints: (audit.packages ?? []).filter((item: any) => validHash(item.fingerprint)).map((item: any) => ({ name: String(item.name).slice(0, 200), fingerprint: item.fingerprint })).sort((a: any, b: any) => a.name.localeCompare(b.name)).slice(0, 2_000),
          resourceHashes: [...new Set<string>((audit.resources ?? []).map((item: any) => String(item.contentHash)).filter((value: string) => validHash(value)))].sort().slice(0, 10_000),
        };
        const entries = [...current.entries, entry].slice(-maxEntries);
        const body = { version: 1 as const, repositoryFingerprint, entries };
        const next = { ...body, checksum: checksum(body) };
        await writeJsonFile(path, next, { atomic: true, finalNewline: true });
        await chmod(path, 0o600).catch(() => undefined);
        return entry;
      });
    },
    async compare(audit: any) {
      const state = await load();
      const trusted = state.entries.at(-1);
      if (!trusted) return { status: "untrusted" as const, afterFingerprint: audit.fingerprint };
      if (trusted.fingerprint === audit.fingerprint) return { status: "trusted" as const, beforeFingerprint: trusted.fingerprint, afterFingerprint: audit.fingerprint };
      const currentPackages = new Map<string, string>((audit.packages ?? []).map((item: any) => [String(item.name), String(item.fingerprint)]));
      const trustedPackages = new Map<string, string>(trusted.packageFingerprints.map(item => [item.name, item.fingerprint]));
      return {
        status: "drifted" as const, beforeFingerprint: trusted.fingerprint, afterFingerprint: audit.fingerprint,
        changedPackages: [...currentPackages.keys()].filter(name => trustedPackages.has(name) && trustedPackages.get(name) !== currentPackages.get(name)).sort(),
        addedPackages: [...currentPackages.keys()].filter(name => !trustedPackages.has(name)).sort(),
        removedPackages: [...trustedPackages.keys()].filter(name => !currentPackages.has(name)).sort(),
      };
    },
  };
}
