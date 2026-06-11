import { execFile } from "node:child_process";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

type ToolCheck = {
  command: string;
  args: string[];
  packageNames: string[];
};

const checks: ToolCheck[] = [
  { command: "pdftoppm", args: ["-v"], packageNames: ["poppler-utils", "poppler"] },
  { command: "tesseract", args: ["--version"], packageNames: ["tesseract-ocr", "tesseract"] },
];

async function versionLine(check: ToolCheck): Promise<string> {
  try {
    const { stdout, stderr } = await execFileAsync(check.command, check.args, { timeout: 10_000 });
    return (stdout || stderr).split(/\r?\n/).find(Boolean)?.trim() || `${check.command} found`;
  } catch (error: any) {
    const installHint = check.packageNames.join(" / ");
    throw new Error(`${check.command} is required for PDF OCR fallback but was not found. Install ${installHint}.`);
  }
}

const lines: string[] = [];
for (const check of checks) {
  lines.push(await versionLine(check));
}

console.log(`OCR dependencies OK:\n${lines.map(line => `- ${line}`).join("\n")}`);
