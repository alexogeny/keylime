import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { homedir } from "node:os";

const API_KEY_NAMES = ["TAVILY_API_KEY", "SERPER_API_KEY", "BING_API_KEY"] as const;

export function webSearchConfigFile(): string {
  return process.env.KEYLIME_WEB_SEARCH_CONFIG ?? join(homedir(), ".pi", "data", "web-search", "config.json");
}

function configuredKeys(): Record<string, unknown> {
  const file = webSearchConfigFile();
  if (!existsSync(file)) return {};

  try {
    return JSON.parse(readFileSync(file, "utf8")) as Record<string, unknown>;
  } catch {
    return {};
  }
}

export function researchKeyConfigured(): boolean {
  if (API_KEY_NAMES.some(name => Boolean(process.env[name]))) return true;

  const config = configuredKeys();
  return API_KEY_NAMES.some(name => typeof config[name] === "string" && config[name].trim().length > 0);
}

export function researchEnabled(): boolean {
  if (process.env.KEYLIME_DISABLE_RESEARCH === "1") return false;
  if (process.env.KEYLIME_ENABLE_RESEARCH === "1") return true;
  return researchKeyConfigured();
}
