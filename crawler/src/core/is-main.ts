import { fileURLToPath } from "node:url";

/**
 * Returns true when the calling module is the entry-point script.
 *
 * The naïve `import.meta.url === \`file://${process.argv[1]}\`` pattern
 * breaks on Windows because:
 *   - import.meta.url  → "file:///D:/path/file.ts"  (3 slashes)
 *   - file://${argv1}  → "file://D:\path\file.ts"   (2 slashes + backslash)
 *
 * Usage:
 *   import { isMain } from "../src/core/is-main.js";
 *   if (isMain(import.meta.url)) { main(); }
 */
export function isMain(metaUrl: string): boolean {
  try {
    const norm = (p: string) => p.replace(/\\/g, "/");
    const file  = norm(fileURLToPath(metaUrl));
    const argv1 = norm(process.argv[1] ?? "");
    return file === argv1;
  } catch {
    return false;
  }
}
