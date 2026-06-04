import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { getSettingsListTheme } from "@earendil-works/pi-coding-agent";
import { Container, SettingsList, type SettingItem } from "@earendil-works/pi-tui";
import { readFile, writeFile, mkdir } from "node:fs/promises";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { homedir } from "node:os";

type Memory = {
	id: string;
	content: string;
	category: "preference" | "fact" | "event" | "goal" | "skill" | "context";
	tags?: string[];
	updated_at: number;
	expires_at?: number;
};

type MemoryStore = { version: number; memories: Memory[] };

const DATA_DIR = join(homedir(), ".pi", "data", "user-memory");
const MEMORY_FILE = join(DATA_DIR, "memories.json");

function short(text: string, n = 64) {
	return text.length <= n ? text : `${text.slice(0, n - 1)}…`;
}

function age(ts: number) {
	const d = Math.floor((Date.now() - ts) / 86_400_000);
	if (d <= 0) return "today";
	if (d === 1) return "1d";
	if (d < 30) return `${d}d`;
	return `${Math.round(d / 30)}mo`;
}

async function loadStore(): Promise<MemoryStore> {
	if (!existsSync(MEMORY_FILE)) return { version: 1, memories: [] };
	const raw = await readFile(MEMORY_FILE, "utf8");
	const parsed = JSON.parse(raw) as MemoryStore;
	parsed.memories ||= [];
	return parsed;
}

async function saveStore(store: MemoryStore) {
	await mkdir(DATA_DIR, { recursive: true });
	await writeFile(MEMORY_FILE, JSON.stringify(store, null, 2), "utf8");
}

export default function memoryManager(_pi: ExtensionAPI) {
	// Retired: /memories duplicated user-memory's command and exposed the old
	// unstructured browse/forget UI. Structured profile editing now lives in
	// /memory-wizard; freeform memory management remains available through the
	// existing list/update/forget memory tools.
}

