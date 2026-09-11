// The Gemini CLI treats every "@token" in its input as a file to attach, on stdin too. These
// helpers write references it parses exactly and neutralize every other at-sign.

/**
 * Gemini CLI `@path` reference. Mirrors the CLI's own escapePath()/unescapePath(): on Windows
 * the path is wrapped in double quotes (a quoted segment is one token and backslashes stay
 * literal); elsewhere special characters are backslash-escaped. Commas are escaped too because
 * the CLI's @-token regex stops at an unescaped comma.
 */
export function toAtReference(absolutePath: string, platform: NodeJS.Platform = process.platform): string {
  if (platform === "win32") return `@"${absolutePath}"`;
  return `@${absolutePath.replace(/([ \t()[\]{};,|*?$`'"#&<>!~\\])/g, "\\$1")}`;
}

/**
 * A bare "@" ("@Component", "user@example.com", "@scope/pkg", "@param") would make the CLI try
 * to resolve and attach a file — or glob the workspace for one. The CLI does not un-escape
 * "\@" in headless mode, so the model sees the backslash; prompts say to ignore it.
 */
export function escapeAtSigns(text: string): string {
  return text.replace(/(?<!\\)@/g, "\\@");
}
