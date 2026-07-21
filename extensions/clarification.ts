import { complete } from "@earendil-works/pi-ai/compat";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { randomUUID } from "node:crypto";
import { loadAllSearchEntries } from "./shared/web-search-store";
import type { SearchEntry } from "./shared/web-search-types";
import {
  analyzeClarificationRequest,
  buildClarificationResearchPrompt,
  buildClarificationSynthesisPrompt,
  collectClarificationDocuments,
  deterministicClarificationDraft,
  parseClarificationDraft,
  recommendClarificationResearch,
  retrieveClarificationEvidence,
  retrieveClarificationWebEvidence,
  type ClarificationDocument,
  type ClarificationDraft,
  type ClarificationPacket,
} from "./shared/clarification";

export type StoredClarification = ClarificationDraft & {
  id: string;
  request: string;
  evidencePaths: string[];
  createdAt: string;
};

type ClarificationExtensionOptions = {
  collectDocuments?: (cwd: string) => Promise<ClarificationDocument[]>;
  loadWebResearch?: () => Promise<SearchEntry[]>;
  synthesize?: (packet: ClarificationPacket, ctx: any) => Promise<ClarificationDraft>;
};

export function clarificationGenerationMode(value = process.env.KEYLIME_CLARIFICATION_MODE): "semantic" | "deterministic" {
  return value === "deterministic" ? "deterministic" : "semantic";
}

function storedDraftFromEntries(entries: any[]): StoredClarification | undefined {
  return entries
    .filter(entry => entry?.type === "custom" && entry.customType === "clarification-draft")
    .map(entry => entry.data as StoredClarification)
    .filter(draft => draft && typeof draft.prompt === "string" && typeof draft.id === "string")
    .at(-1);
}

async function synthesizeClarification(packet: ClarificationPacket, ctx: any): Promise<ClarificationDraft> {
  const fallback = deterministicClarificationDraft(packet);
  if (clarificationGenerationMode() === "deterministic") return fallback;
  const model = ctx.model ?? ctx.getModel?.();
  if (!model || !ctx.modelRegistry?.getApiKeyAndHeaders) return fallback;
  try {
    const auth = await ctx.modelRegistry.getApiKeyAndHeaders(model);
    if (!auth?.ok) return fallback;
    const response = await complete(model, {
      messages: [{
        role: "user",
        content: [{ type: "text", text: buildClarificationSynthesisPrompt(packet) }],
        timestamp: Date.now(),
      }],
    }, {
      apiKey: auth.apiKey,
      headers: auth.headers,
      env: auth.env,
      maxTokens: 1_600,
      signal: AbortSignal.timeout(30_000),
    });
    const text = response.content
      .filter((part): part is { type: "text"; text: string } => part.type === "text")
      .map(part => part.text)
      .join("\n");
    return parseClarificationDraft(text) ?? fallback;
  } catch {
    return fallback;
  }
}

export function registerClarificationExtension(pi: ExtensionAPI, options: ClarificationExtensionOptions = {}): void {
  const collectDocuments = options.collectDocuments ?? ((cwd: string) => collectClarificationDocuments(cwd));
  const loadWebResearch = options.loadWebResearch ?? (() => loadAllSearchEntries());
  const synthesize = options.synthesize ?? synthesizeClarification;
  let latestDraft: StoredClarification | undefined;

  const restore = (ctx: any): StoredClarification | undefined => {
    latestDraft ??= storedDraftFromEntries(ctx.sessionManager?.getEntries?.() ?? []);
    return latestDraft;
  };

  pi.on("session_start", async (_event, ctx) => {
    const restored = restore(ctx);
    if (restored) ctx.ui.setStatus?.("clarification", `clarified:${restored.title}`);
  });

  pi.registerCommand("clarify", {
    description: "Compile a rough task into a grounded prompt using deterministic repository retrieval and one synthesis pass",
    handler: async (args, ctx) => {
      const request = String(args ?? "").trim();
      if (!request) {
        ctx.ui.notify("Usage: /clarify <rough repository task>", "warning");
        return;
      }
      ctx.ui.setStatus?.("clarification", "clarifying: indexing repository and saved research…");
      const [documents, webResearch] = await Promise.all([
        collectDocuments(ctx.cwd),
        loadWebResearch().catch(() => []),
      ]);
      const preliminaryEvidence = retrieveClarificationEvidence(request, documents, { topK: 5 });
      const preliminaryWebEvidence = retrieveClarificationWebEvidence(request, webResearch, { topK: 3 });
      const supportingTexts = [
        ...preliminaryWebEvidence.flatMap(item => [item.query, item.summary]),
        ...preliminaryEvidence.map(item => item.excerpt),
      ];
      const analysis = analyzeClarificationRequest(request, supportingTexts);
      const evidence = retrieveClarificationEvidence(request, documents, { topK: 8, analysis });
      const webEvidence = retrieveClarificationWebEvidence(request, webResearch, { topK: 3, analysis });
      const research = recommendClarificationResearch(request, analysis, webEvidence);
      if (research && ctx.hasUI && ctx.mode === "tui" && typeof ctx.ui.confirm === "function") {
        const approved = await ctx.ui.confirm("Research before clarifying?", `${research.reason}\n\nRun fresh research now and defer the clarified prompt?`);
        if (approved) {
          pi.appendEntry("clarification-research-requested", {
            request,
            themes: research.themes,
            evidenceIds: webEvidence.map(item => item.id),
            requestedAt: new Date().toISOString(),
          });
          ctx.ui.setStatus?.("clarification", "clarification deferred · research queued");
          pi.sendUserMessage(buildClarificationResearchPrompt(request, research, webEvidence), { deliverAs: "followUp" });
          ctx.ui.notify("Fresh research queued. After it is saved, rerun /clarify with the original request.", "info");
          return;
        }
      }
      ctx.ui.setStatus?.("clarification", `clarifying: synthesizing ${evidence.length} anchors and ${webEvidence.length} research memories…`);
      let draft = await synthesize({ request, evidence, webEvidence, concepts: analysis.concepts.map(concept => concept.id) }, ctx);

      if (ctx.hasUI && ctx.mode === "tui" && typeof ctx.ui.editor === "function") {
        const edited = await ctx.ui.editor("Review clarified prompt (save and close to keep edits)", draft.prompt);
        if (typeof edited === "string" && edited.trim()) draft = { ...draft, prompt: edited.trim(), source: "edited" };
      }

      latestDraft = {
        ...draft,
        id: randomUUID(),
        request,
        evidencePaths: evidence.map(item => item.path),
        createdAt: new Date().toISOString(),
      };
      pi.appendEntry("clarification-draft", latestDraft);
      ctx.ui.setStatus?.("clarification", `clarified:${latestDraft.title}`);
      const anchors = latestDraft.evidencePaths.slice(0, 3).join(", ");
      ctx.ui.notify(
        `Clarified prompt ready (${latestDraft.source}): ${latestDraft.title}${anchors ? `\nAnchors: ${anchors}` : ""}\nRun /submit-clarified to use it.`,
        "info",
      );
    },
  });

  pi.registerCommand("submit-clarified", {
    description: "Submit the latest stored clarified prompt as the next user task",
    handler: async (_args, ctx) => {
      const draft = restore(ctx);
      if (!draft) {
        ctx.ui.notify("No clarified prompt is available. Run /clarify <task> first.", "warning");
        return;
      }
      pi.appendEntry("clarification-submitted", { id: draft.id, submittedAt: new Date().toISOString() });
      ctx.ui.setStatus?.("clarification", `submitted:${draft.title}`);
      pi.sendUserMessage(draft.prompt, { deliverAs: "followUp" });
    },
  });
}

export default function clarificationExtension(pi: ExtensionAPI): void {
  registerClarificationExtension(pi);
}
