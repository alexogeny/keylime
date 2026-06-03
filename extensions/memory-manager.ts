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

export default function memoryManager(pi: ExtensionAPI) {
	pi.registerCommand("memories", {
		description: "Interactive memory manager (browse + forget)",
		handler: async (_args, ctx) => {
			const store = await loadStore();
			if (store.memories.length === 0) {
				ctx.ui.notify("No stored memories found", "info");
				return;
			}

			const sorted = [...store.memories].sort((a, b) => b.updated_at - a.updated_at);
			const pendingForget = new Set<string>();

			await ctx.ui.custom((tui, theme, _kb, done) => {
				const items: SettingItem[] = sorted.map((m) => {
					const tags = (m.tags || []).slice(0, 2).join(",");
					const label = `[${m.category}] ${short(m.content)} ${tags ? `#${tags} ` : ""}(${age(m.updated_at)})`;
					return {
						id: m.id,
						label,
						currentValue: "keep",
						values: ["keep", "forget"],
					};
				});

				const container = new Container();
				container.addChild(
					new (class {
						render() {
							return [
								theme.fg("accent", theme.bold("Memory Manager")),
								theme.fg("dim", "↑/↓ navigate · ←/→ toggle keep/forget · Esc save+exit"),
								"",
							];
						}
						invalidate() {}
					})(),
				);

				const settings = new SettingsList(
					items,
					Math.min(items.length + 2, 20),
					getSettingsListTheme(),
					(id, value) => {
						if (value === "forget") pendingForget.add(id);
						else pendingForget.delete(id);
					},
					() => done(undefined),
				);
				container.addChild(settings);

				return {
					render(width: number) {
						return container.render(width);
					},
					invalidate() {
						container.invalidate();
					},
					handleInput(data: string) {
						settings.handleInput?.(data);
						tui.requestRender();
					},
				};
			});

			if (pendingForget.size === 0) {
				ctx.ui.notify("No changes", "info");
				return;
			}

			const before = store.memories.length;
			store.memories = store.memories.filter((m) => !pendingForget.has(m.id));
			await saveStore(store);
			ctx.ui.notify(`Forgot ${before - store.memories.length} memories`, "success");
		},
	});
}
