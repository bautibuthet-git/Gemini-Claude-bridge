import type { ChildProcess, SpawnOptions } from "node:child_process";
import { EventEmitter } from "node:events";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { PassThrough } from "node:stream";
import type { KillFn, SpawnFn } from "../src/gemini/invoke.js";

/** Stand-in for a spawned Gemini process: real streams, scripted exit. */
export class FakeChild extends EventEmitter {
  readonly stdin = new PassThrough();
  readonly stdout = new PassThrough();
  readonly stderr = new PassThrough();
  pid: number | undefined = 4242;
  stdinText = "";

  constructor() {
    super();
    this.stdin.on("data", (chunk: Buffer) => {
      this.stdinText += chunk.toString("utf8");
    });
  }

  exit(code: number | null, stdout = "", stderr = ""): void {
    this.stdout.end(stdout);
    this.stderr.end(stderr);
    setTimeout(() => this.emit("close", code, null), 5);
  }
}

export interface SpawnCall {
  command: string;
  args: readonly string[];
  options: SpawnOptions;
}

/** A SpawnFn whose child behaves as scripted (the script runs after runProcess attaches its listeners). */
export function fakeSpawn(script: (child: FakeChild, call: SpawnCall) => void) {
  const calls: SpawnCall[] = [];
  const children: FakeChild[] = [];
  const spawn: SpawnFn = (command, args, options) => {
    const child = new FakeChild();
    const call = { command, args, options };
    calls.push(call);
    children.push(child);
    setImmediate(() => script(child, call));
    return child as unknown as ChildProcess;
  };
  return { spawn, calls, children };
}

export function fakeKill(onKill: (pid: number, signal: string) => void = () => undefined) {
  const kills: { pid: number; signal: string }[] = [];
  const kill: KillFn = (pid, signal, callback) => {
    kills.push({ pid, signal });
    onKill(pid, signal);
    callback?.();
  };
  return { kill, kills };
}

export function tempDir(prefix = "gcb-"): Promise<string> {
  return fs.mkdtemp(path.join(os.tmpdir(), prefix));
}

/** Creates `gemini` and `gemini.cmd` in `dir` so PATH lookups succeed on any OS. */
export async function fakeGeminiOnPath(dir: string): Promise<NodeJS.ProcessEnv> {
  await fs.writeFile(path.join(dir, "gemini"), "");
  await fs.writeFile(path.join(dir, "gemini.cmd"), "");
  return { PATH: dir, PATHEXT: ".CMD" };
}
