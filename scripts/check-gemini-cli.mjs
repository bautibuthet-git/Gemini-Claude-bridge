// Postinstall sanity check for maintainers running `npm install`. Informational only:
// it never fails the install. (Plugin users never run this — the plugin ships pre-built.)
import { spawnSync } from "node:child_process";

const tag = "[gemini-claude-bridge]";

try {
  const major = Number(process.versions.node.split(".")[0]);
  if (major < 20) {
    console.warn(`${tag} Node ${process.versions.node} detected; Node 20 or newer is required by the Gemini CLI.`);
  }

  // Fixed command string, no user input: shell is needed so Windows resolves gemini.cmd.
  const result = spawnSync("gemini --version", { shell: true, encoding: "utf8", timeout: 30_000 });
  const version = result.status === 0 ? result.stdout.trim().split(/\r?\n/).pop() : "";
  if (version) {
    console.log(`${tag} Gemini CLI ${version} found on PATH.`);
  } else {
    console.warn(
      `${tag} Gemini CLI not found on PATH. The bridge needs it at runtime:\n` +
        `${tag}   npm install -g @google/gemini-cli\n` +
        `${tag}   gemini        (run once and sign in with Google)`,
    );
  }
} catch {
  // Never fail the install.
}

process.exit(0);
