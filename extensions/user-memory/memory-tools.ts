import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import type { MemoryToolDeps } from "./memory-tool-types.js";
import { registerMemoryMutationTools } from "./mutation-tools.js";
import { registerRecallMemoryTools } from "./recall-tools.js";
import { registerRememberTools } from "./remember-tools.js";

export function registerUserMemoryTools(pi: ExtensionAPI, deps: MemoryToolDeps): void {
  registerRememberTools(pi, deps);
  registerRecallMemoryTools(pi, deps);
  registerMemoryMutationTools(pi, deps);
}
