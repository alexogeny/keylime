import { createHash } from "node:crypto";
import { spawn } from "node:child_process";
import { isAbsolute, relative, resolve, sep } from "node:path";
import { realpath } from "node:fs/promises";

export type ProcessSandboxMode = "observe" | "enforce";
export type ProcessNetworkPolicy = "allow" | "deny";

export type ProcessExecutorOptions = {
  cwd: string;
  mode?: ProcessSandboxMode;
  backend?: "native" | "bubblewrap" | string;
  network?: ProcessNetworkPolicy;
  maxOutputChars?: number;
  timeoutMs?: number;
  environment?: NodeJS.ProcessEnv;
  environmentAllowlist?: string[];
};

type ProcessRequest = {
  command: string;
  args?: string[];
  cwd?: string;
  timeoutMs?: number;
  environment?: NodeJS.ProcessEnv;
};

const DEFAULT_ENVIRONMENT_ALLOWLIST = ["PATH", "HOME", "TMPDIR", "TEMP", "TMP", "LANG", "LC_ALL", "SYSTEMROOT", "SystemRoot"];

function sha(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

function bounded(text: string, max: number): { text: string; truncated: boolean } {
  if (text.length <= max) return { text, truncated: false };
  const head = Math.max(0, Math.floor(max * .7));
  const marker = "\n[output truncated]\n";
  const tail = Math.max(0, max - head - marker.length);
  return { text: `${text.slice(0, head)}${marker}${text.slice(-tail)}`.slice(0, max), truncated: true };
}

function filteredEnvironment(source: NodeJS.ProcessEnv, allowlist: string[]): NodeJS.ProcessEnv {
  const allowed = new Set(allowlist);
  return Object.fromEntries(Object.entries(source).filter(([key, value]) => allowed.has(key) && typeof value === "string"));
}

async function repositoryCwd(root: string, requested?: string): Promise<string> {
  const canonicalRoot = await realpath(root);
  const candidate = requested ? (isAbsolute(requested) ? requested : resolve(canonicalRoot, requested)) : canonicalRoot;
  const canonicalCandidate = await realpath(candidate);
  const rel = relative(canonicalRoot, canonicalCandidate);
  if (rel === ".." || rel.startsWith(`..${sep}`) || isAbsolute(rel)) throw new Error("Process cwd is outside the repository");
  return canonicalCandidate;
}

export function createProcessExecutor(options: ProcessExecutorOptions) {
  const mode = options.mode ?? "observe";
  const backend = options.backend ?? "native";
  const network = options.network ?? "deny";
  const maxOutputChars = Math.max(1, Math.min(1_000_000, Math.floor(options.maxOutputChars ?? 10_000)));
  const defaultTimeoutMs = Math.max(1, Math.min(600_000, Math.floor(options.timeoutMs ?? 120_000)));
  const allowlist = [...new Set(options.environmentAllowlist ?? DEFAULT_ENVIRONMENT_ALLOWLIST)];

  const plan = (request: ProcessRequest) => {
    const args = (request.args ?? []).map(String);
    const wouldSandbox = backend !== "native";
    if (backend === "bubblewrap") {
      const argv = [
        "bwrap", "--die-with-parent",
        ...(network === "deny" ? ["--unshare-net"] : []),
        "--bind", options.cwd, options.cwd,
        "--chdir", request.cwd ?? options.cwd,
        "--", request.command, ...args,
      ];
      return { applied: mode === "enforce", backend, network, wouldSandbox, argv };
    }
    return { applied: mode === "enforce" && backend !== "native", backend, network, wouldSandbox, argv: [request.command, ...args] };
  };

  return {
    plan,
    async run(request: ProcessRequest) {
      const startedAt = Date.now();
      const cwd = await repositoryCwd(options.cwd, request.cwd);
      if (mode === "enforce" && backend !== "native" && backend !== "bubblewrap") throw new Error(`Configured sandbox backend is unavailable in enforce mode: ${backend}`);
      const executionPlan = plan({ ...request, cwd });
      const argv = mode === "enforce" && backend === "bubblewrap" ? executionPlan.argv : [request.command, ...(request.args ?? [])];
      const command = argv[0]!;
      const args = argv.slice(1);
      const timeoutMs = Math.max(1, Math.min(600_000, Math.floor(request.timeoutMs ?? defaultTimeoutMs)));
      const sourceEnvironment = { ...(options.environment ?? process.env), ...(request.environment ?? {}) };
      const environment = filteredEnvironment(sourceEnvironment, allowlist);
      const commandFingerprint = sha(JSON.stringify({ command: request.command, args: request.args ?? [], backend, network }));

      return new Promise<any>((resolveResult) => {
        let stdout = "";
        let stderr = "";
        let timedOut = false;
        let settled = false;
        const child = spawn(command, args, { cwd, env: environment, shell: false, stdio: ["ignore", "pipe", "pipe"], windowsHide: true });
        const timer = setTimeout(() => {
          timedOut = true;
          child.kill("SIGKILL");
        }, timeoutMs);
        child.stdout?.on("data", chunk => { if (stdout.length <= maxOutputChars * 2) stdout += String(chunk); });
        child.stderr?.on("data", chunk => { if (stderr.length <= maxOutputChars * 2) stderr += String(chunk); });
        const finish = (code: number | null, launchError?: Error) => {
          if (settled) return;
          settled = true;
          clearTimeout(timer);
          const boundedStdout = bounded(stdout, maxOutputChars);
          const boundedStderr = bounded(launchError ? `${stderr}${stderr ? "\n" : ""}${launchError.message}` : stderr, maxOutputChars);
          resolveResult({
            ok: !launchError && !timedOut && code === 0,
            stdout: boundedStdout.text,
            stderr: boundedStderr.text,
            exitCode: code,
            shellUsed: false,
            sandboxMode: mode,
            audit: {
              commandFingerprint,
              durationMs: Date.now() - startedAt,
              reason: timedOut ? "timeout" : launchError ? "launch_error" : code === 0 ? "completed" : "nonzero_exit",
              outputTruncated: boundedStdout.truncated || boundedStderr.truncated,
              backend,
              network,
            },
          });
        };
        child.once("error", error => finish(null, error));
        child.once("close", code => finish(code));
      });
    },
  };
}
