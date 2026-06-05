import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import {
  backupLabels,
  createMemoryBackup,
  listMemoryBackups,
  loadMemoryBackup,
  pruneMemoryBackups,
  restoreEntityBackup,
} from "./backups.js";
import type { EntityStore } from "./entity.js";
import { DATA_DIR, saveStore, type MemoryStore } from "./store.js";

type MemoryCommandState = {
  getStore: () => MemoryStore;
  getEntityStore: () => EntityStore;
  ensureLoaded: () => Promise<void>;
  markUnloaded: () => void;
};

export function registerMemoryBackupCommands(pi: ExtensionAPI, state: MemoryCommandState): void {
  pi.registerCommand("backup-memory", {
    description: "Back up memory + entity store to a timestamped snapshot",
    handler: async (_args, ctx) => {
      await state.ensureLoaded();
      const store = state.getStore();
      const { timestamp: ts } = await createMemoryBackup(DATA_DIR, store, state.getEntityStore());
      ctx.ui.notify(
        `💾 Backed up ${store.memories.length} memories → backups/memories-${ts}.json`,
        "info",
      );
    },
  });

  pi.registerCommand("restore-memory", {
    description: "Restore memory store from a backup snapshot",
    handler: async (_args, ctx) => {
      const files = await listMemoryBackups(DATA_DIR);

      if (files.length === 0) {
        ctx.ui.notify("No backups found. Run /backup-memory first.", "error");
        return;
      }

      const labels = await backupLabels(DATA_DIR, files);
      const choice = await ctx.ui.select("Restore from backup:", labels);
      if (!choice) return;

      const chosen = files[labels.indexOf(choice)];
      if (!chosen) return;

      const store = state.getStore();
      const ok = await ctx.ui.confirm(
        "Restore memory store?",
        `This will REPLACE your current ${store.memories.length} memories with the backup. Continue?`,
      );
      if (!ok) return;

      const { timestamp: safetyTs } = await createMemoryBackup(DATA_DIR, store, state.getEntityStore());
      const restored = await loadMemoryBackup<MemoryStore>(DATA_DIR, chosen);
      await saveStore(restored);
      await restoreEntityBackup(DATA_DIR, chosen);

      state.markUnloaded();
      await state.ensureLoaded();

      ctx.ui.notify(
        `✅ Restored ${state.getStore().memories.length} memories from ${chosen}\n(Previous state auto-backed up as ${safetyTs})`,
        "info",
      );
    },
  });
}

export async function autoBackupMemorySession(store: MemoryStore, entityStore: EntityStore): Promise<void> {
  if (store.memories.length === 0) return;
  await createMemoryBackup(DATA_DIR, store, entityStore);
  await pruneMemoryBackups(DATA_DIR, 10);
}
