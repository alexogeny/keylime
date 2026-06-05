import type { CapabilityGroup } from "./intent";

export type ToolRisk = "safe" | "guarded" | "stateful" | "dangerous" | "domain";

export interface ToolPolicy {
  name: string;
  group?: CapabilityGroup;
  alwaysOn?: boolean;
  domain?: boolean;
  risk: ToolRisk;
}

export const TOOL_POLICIES: ToolPolicy[] = [
  { name: "code_search", alwaysOn: true, domain: true, risk: "safe" },
  { name: "list_files", alwaysOn: true, domain: true, risk: "safe" },
  { name: "inspect_json", alwaysOn: true, domain: true, risk: "safe" },
  { name: "inspect_text_matches", alwaysOn: true, domain: true, risk: "safe" },
  { name: "inspect_code_structure", alwaysOn: true, domain: true, risk: "safe" },
  { name: "inspect_lines", alwaysOn: true, domain: true, risk: "safe" },
  { name: "plan_code_replacements", alwaysOn: true, domain: true, risk: "safe" },
  { name: "apply_code_replacements", alwaysOn: true, domain: true, risk: "safe" },
  { name: "create_file", alwaysOn: true, domain: true, risk: "safe" },
  { name: "create_directory", alwaysOn: true, domain: true, risk: "safe" },
  { name: "run_checks", alwaysOn: true, domain: true, risk: "safe" },
  { name: "retrieve_policy", alwaysOn: true, domain: true, risk: "safe" },
  { name: "suggest_checks", alwaysOn: true, domain: true, risk: "safe" },
  { name: "codemod_plan", alwaysOn: true, domain: true, risk: "safe" },
  { name: "codemod_update_json", alwaysOn: true, domain: true, risk: "safe" },
  { name: "codemod_add_import", alwaysOn: true, domain: true, risk: "safe" },
  { name: "codemod_insert_test_case", alwaysOn: true, domain: true, risk: "safe" },
  { name: "inspect_tool_result", alwaysOn: true, domain: true, risk: "safe" },
  { name: "list_tool_results", alwaysOn: true, domain: true, risk: "safe" },
  { name: "commit_history", alwaysOn: true, domain: true, risk: "safe" },
  { name: "see_file_commit_history", alwaysOn: true, domain: true, risk: "safe" },
  { name: "git_status", alwaysOn: true, domain: true, risk: "safe" },
  { name: "git_diff", alwaysOn: true, domain: true, risk: "safe" },
  { name: "inspect_at_checkpoint", alwaysOn: true, domain: true, risk: "safe" },

  { name: "bash", group: "core", alwaysOn: false, domain: true, risk: "guarded" },
  { name: "read", group: "readonly", alwaysOn: false, domain: true, risk: "guarded" },
  { name: "fetch_url", group: "fetch", alwaysOn: false, domain: true, risk: "guarded" },
  { name: "edit", alwaysOn: false, domain: true, risk: "dangerous" },
  { name: "write", alwaysOn: false, domain: true, risk: "dangerous" },

  { name: "save_project_plan", group: "project", domain: true, risk: "stateful" },
  { name: "update_feature_tdd", group: "project", domain: true, risk: "stateful" },
  { name: "log_decision", group: "project", domain: true, risk: "stateful" },
  { name: "manage_question", group: "project", domain: true, risk: "stateful" },

  { name: "remember", group: "memory", domain: true, risk: "stateful" },
  { name: "recall_memories", group: "memory", domain: true, risk: "stateful" },
  { name: "update_memory", group: "memory", domain: true, risk: "stateful" },
  { name: "forget_memory", group: "memory", domain: true, risk: "stateful" },
  { name: "list_memories", group: "memory", domain: true, risk: "stateful" },
  { name: "recall_entity", group: "memory", domain: true, risk: "stateful" },
  { name: "list_entities", group: "memory", domain: true, risk: "stateful" },

  { name: "recall_web_knowledge", group: "research", domain: true, risk: "stateful" },
  { name: "list_search_history", group: "research", domain: true, risk: "stateful" },
  { name: "get_search_entry", group: "research", domain: true, risk: "stateful" },
  { name: "web_search", group: "research", domain: true, risk: "guarded" },
  { name: "save_search_knowledge", group: "research", domain: true, risk: "stateful" },
  { name: "research_topic", group: "research", domain: true, risk: "guarded" },

  { name: "lookup_shoe", group: "shoes", domain: true, risk: "domain" },
  { name: "find_shoes_by_spec", group: "shoes", domain: true, risk: "domain" },
  { name: "compare_shoes", group: "shoes", domain: true, risk: "domain" },
  { name: "shoe_catalog_stats", group: "shoes", domain: true, risk: "domain" },
  { name: "add_shoe", group: "shoes", domain: true, risk: "stateful" },
  { name: "query_shoes", group: "shoes", domain: true, risk: "domain" },
];

export function toolPolicyFor(name: string): ToolPolicy | undefined {
  return TOOL_POLICIES.find(policy => policy.name === name);
}

export function knownToolNames(): Set<string> {
  return new Set(TOOL_POLICIES.map(policy => policy.name));
}

export function alwaysOnToolNames(): string[] {
  return TOOL_POLICIES.filter(policy => policy.alwaysOn).map(policy => policy.name);
}

export function domainToolNames(): string[] {
  return TOOL_POLICIES.filter(policy => policy.domain).map(policy => policy.name);
}

export function capabilityToolMap(): Record<CapabilityGroup, string[]> {
  const groups: Record<CapabilityGroup, string[]> = {
    core: [], readonly: [], coding: [], repo: [], project: [], memory: [], "memory-lite": [], research: [], fetch: [], shoes: [], personal: [], safety: [],
  };
  for (const policy of TOOL_POLICIES) {
    if (policy.group) groups[policy.group].push(policy.name);
  }
  groups.core = ["bash"];
  groups.readonly = ["read", "bash", "fetch_url"];
  groups.coding = ["bash"];
  groups["memory-lite"] = ["remember", "recall_memories", "recall_entity"];
  groups.personal = ["remember", "recall_memories", "recall_entity"];
  return groups;
}
