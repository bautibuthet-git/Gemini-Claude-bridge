import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { countLines, estimateChars, findOnPath, includeDirectoriesFor, resolveInputPaths } from "../../src/util/paths.js";
import { fakeGeminiOnPath, tempDir } from "../helpers.js";

let dir: string;

beforeEach(async () => {
  dir = await tempDir("gcb-paths-");
});

afterEach(async () => {
  await fs.rm(dir, { recursive: true, force: true });
});

describe("countLines", () => {
  it("counts lines with or without a trailing newline", async () => {
    await fs.writeFile(path.join(dir, "a.txt"), "one\ntwo\nthree\n");
    await fs.writeFile(path.join(dir, "b.txt"), "one\ntwo");
    expect(await countLines(path.join(dir, "a.txt"))).toBe(3);
    expect(await countLines(path.join(dir, "b.txt"))).toBe(2);
  });

  it("returns null for binary, empty, missing files and directories", async () => {
    await fs.writeFile(path.join(dir, "bin"), Buffer.from([1, 2, 0, 3]));
    await fs.writeFile(path.join(dir, "empty.txt"), "");
    expect(await countLines(path.join(dir, "bin"))).toBeNull();
    expect(await countLines(path.join(dir, "empty.txt"))).toBeNull();
    expect(await countLines(path.join(dir, "nope.txt"))).toBeNull();
    expect(await countLines(dir)).toBeNull();
  });
});

describe("resolveInputPaths", () => {
  it("resolves relative paths against the project, de-duplicates and reports what is missing", async () => {
    await fs.mkdir(path.join(dir, "src"), { recursive: true });
    const file = path.join(dir, "src", "a.ts");
    await fs.writeFile(file, "x");

    const { resolved, missing } = await resolveInputPaths([path.join("src", "a.ts"), file, "src", "nope.ts"], dir);

    expect(resolved.map((r) => r.absolute)).toEqual([file, path.join(dir, "src")]);
    expect(resolved.map((r) => r.isDirectory)).toEqual([false, true]);
    expect(missing).toHaveLength(1);
    expect(missing[0]).toContain("nope.ts");
  });
});

describe("includeDirectoriesFor", () => {
  it("uses each target's folder, adds the project and drops entries already covered by a parent", async () => {
    const project = path.join(dir, "project");
    const nested = path.join(project, "src", "deep");
    await fs.mkdir(nested, { recursive: true });
    const outside = path.join(dir, "elsewhere");
    await fs.mkdir(outside, { recursive: true });

    const dirs = includeDirectoriesFor(
      [
        { input: "a", absolute: path.join(nested, "a.ts"), isDirectory: false },
        { input: "b", absolute: outside, isDirectory: true },
      ],
      project,
    );

    expect(dirs.sort()).toEqual([outside, project].sort());
  });

  it("refuses to hand over the home folder or a filesystem root as the project", () => {
    const home = os.homedir();
    expect(includeDirectoriesFor([], home)).toEqual([]);
    expect(includeDirectoriesFor([], path.parse(home).root)).toEqual([]);
  });
});

describe("estimateChars", () => {
  it("adds up files and walks folders, skipping node_modules and .git", async () => {
    const project = path.join(dir, "p");
    await fs.mkdir(path.join(project, "node_modules"), { recursive: true });
    await fs.mkdir(path.join(project, ".git"), { recursive: true });
    await fs.writeFile(path.join(project, "a.txt"), "x".repeat(100));
    await fs.writeFile(path.join(project, "node_modules", "big.js"), "y".repeat(5_000));
    await fs.writeFile(path.join(project, ".git", "obj"), "z".repeat(5_000));

    expect(await estimateChars([{ input: "p", absolute: project, isDirectory: true }])).toBe(100);
  });
});

describe("findOnPath", () => {
  it("finds a command on PATH and reports null when it isn't there", async () => {
    const env = await fakeGeminiOnPath(dir);
    expect(findOnPath("gemini", env)).not.toBeNull();
    expect(findOnPath("definitely-not-here", env)).toBeNull();
  });
});
