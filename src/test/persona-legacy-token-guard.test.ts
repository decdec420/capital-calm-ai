import { describe, it, expect } from "vitest";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative } from "node:path";

const REPO_ROOT = join(__dirname, "../..");
const FRONTEND_DIRS = ["src/components", "src/pages", "src/lib", "src/hooks", "src/contexts"];
const UI_FILE_EXTENSIONS = new Set([".ts", ".tsx"]);

const BANNED_TOKENS = ["Jessica", "Harvey", "Mike", "Louis", "Suits"];

const TECHNICAL_ALLOWLIST_PATTERNS: RegExp[] = [
  /jessica_autonomous/gi,
  /harvey_chat/gi,
  /lastJessicaDecision/g,
  /jessica_heartbeat/gi,
  /agentHealth\["jessica"\]/g,
  /healthDot\([^)]*jessica[^)]*\)/gi,
  /\bjessica\b(?=\s*[:=])/gi,
  /\bharvey\b(?=\s*[:=])/gi,
  /\b(migration|migrations|supabase|edge\s*(function|fn)|db\s*field|column)\b/gi,
];

function walk(dirPath: string): string[] {
  const entries = readdirSync(dirPath);
  return entries.flatMap((entry) => {
    const fullPath = join(dirPath, entry);
    const stats = statSync(fullPath);
    if (stats.isDirectory()) return walk(fullPath);
    return [fullPath];
  });
}

function isUiFacingFile(filePath: string): boolean {
  if (!UI_FILE_EXTENSIONS.has(filePath.slice(filePath.lastIndexOf(".")))) return false;
  const relPath = relative(REPO_ROOT, filePath).replace(/\\/g, "/");
  return FRONTEND_DIRS.some((dir) => relPath.startsWith(`${dir}/`));
}

function isAllowedTechnicalContext(line: string): boolean {
  return TECHNICAL_ALLOWLIST_PATTERNS.some((pattern) => pattern.test(line));
}

describe("persona legacy token guard", () => {
  it("blocks banned legacy persona names in UI-facing source files", () => {
    const violations: string[] = [];

    for (const dir of FRONTEND_DIRS) {
      const absoluteDir = join(REPO_ROOT, dir);
      const files = walk(absoluteDir).filter(isUiFacingFile);

      for (const file of files) {
        const relPath = relative(REPO_ROOT, file).replace(/\\/g, "/");
        const lines = readFileSync(file, "utf8").split(/\r?\n/);

        lines.forEach((line, lineIdx) => {
          for (const token of BANNED_TOKENS) {
            const tokenRegex = new RegExp(`\\b${token}\\b`, "i");
            if (tokenRegex.test(line) && !isAllowedTechnicalContext(line)) {
              violations.push(`${relPath}:${lineIdx + 1} contains banned token \"${token}\"`);
            }
          }
        });
      }
    }

    expect(violations, violations.join("\n")).toEqual([]);
  });
});
