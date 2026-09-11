import fs from "node:fs/promises";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { numberLines, prepareAttachments } from "../../src/gemini/attachments.js";
import type { ResolvedPath } from "../../src/util/paths.js";
import { tempDir } from "../helpers.js";

let dir: string;

beforeEach(async () => {
  dir = await tempDir("gcb-attach-");
});

afterEach(async () => {
  await fs.rm(dir, { recursive: true, force: true });
});

const target = (absolute: string, isDirectory = false): ResolvedPath => ({ input: absolute, absolute, isDirectory });

describe("numberLines", () => {
  it("numbers lines, handles CRLF, drops the trailing newline and escapes at-signs", () => {
    expect(numberLines("a\r\nb@c\n")).toEqual({ text: "1: a\n2: b\\@c", lines: 2, raw: ["a", "b@c"] });
  });

  it("treats an empty file as zero lines", () => {
    expect(numberLines("")).toEqual({ text: "", lines: 0, raw: [] });
  });
});

describe("prepareAttachments", () => {
  it("inlines a text file completely — nothing is cut at 2000 lines", async () => {
    const file = path.join(dir, "build.log");
    await fs.writeFile(file, Array.from({ length: 4000 }, (_, i) => `line ${i + 1}`).join("\n"));

    const result = await prepareAttachments([target(file)]);

    expect(result.referenced).toEqual([]);
    expect(result.inline).toHaveLength(1);
    expect(result.inline[0]).toMatchObject({ path: file, lines: 4000 });
    expect(result.inline[0]!.text.split("\n").at(-1)).toBe("4000: line 4000");
  });

  it("leaves folders, binaries and files over the budget to the CLI's own @path handling", async () => {
    const binary = path.join(dir, "image.png");
    const big = path.join(dir, "big.log");
    const small = path.join(dir, "small.txt");
    await fs.writeFile(binary, Buffer.from([0x89, 0x50, 0x00, 0x01]));
    await fs.writeFile(big, "x\n".repeat(1000));
    await fs.writeFile(small, "hi\n");

    const result = await prepareAttachments([target(dir, true), target(binary), target(big), target(small)], 1500);

    expect(result.inline.map((f) => f.path)).toEqual([small]);
    expect(result.referenced).toEqual([
      { path: dir, lines: null, isDirectory: true },
      { path: binary, lines: null, isDirectory: false },
      { path: big, lines: 1000, isDirectory: false },
    ]);
  });

  it("strips a UTF-8 byte order mark", async () => {
    const file = path.join(dir, "bom.txt");
    await fs.writeFile(file, "﻿hello");
    expect((await prepareAttachments([target(file)])).inline[0]!.text).toBe("1: hello");
  });
});
