import { readFileSync } from "node:fs";
import fs from "node:fs/promises";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { defaultState } from "../../src/state/schema.js";
import { StateStore } from "../../src/state/store.js";
import { tempDir } from "../helpers.js";

let dir: string;
let file: string;

beforeEach(async () => {
  dir = await tempDir("gcb-store-");
  file = path.join(dir, "nested", "state.json");
});

afterEach(async () => {
  await fs.rm(dir, { recursive: true, force: true });
});

describe("StateStore", () => {
  it("returns defaults for a missing file without creating it", async () => {
    const store = new StateStore(file);
    expect(await store.read()).toEqual(defaultState());
    expect(defaultState().enabled).toBe(true);
    await expect(fs.access(file)).rejects.toThrow();
  });

  it("round-trips updates through the file, creating parent folders", async () => {
    await new StateStore(file).update((s) => {
      s.enabled = false;
      s.preferences.model = "some-model";
      s.usage.callsByMode.review = 2;
    });
    const reread = await new StateStore(file).read();
    expect(reread.enabled).toBe(false);
    expect(reread.preferences.model).toBe("some-model");
    expect(reread.usage.callsByMode).toEqual({ review: 2 });
  });

  it("fills in sections missing from a partial or older file", async () => {
    await fs.mkdir(path.dirname(file), { recursive: true });
    await fs.writeFile(file, JSON.stringify({ enabled: false }));
    const state = await new StateStore(file).read();
    expect(state.enabled).toBe(false);
    expect(state.usage).toEqual(defaultState().usage);
    expect(state.preferences.timeoutMs).toBe(120_000);
  });

  it("backs up and resets a corrupt file, and warns exactly once", async () => {
    await fs.mkdir(path.dirname(file), { recursive: true });
    await fs.writeFile(file, "{ not json");
    const store = new StateStore(file);

    expect(await store.read()).toEqual(defaultState());
    const warning = store.takeWarning();
    expect(warning).toMatch(/reset to defaults/);
    expect(store.takeWarning()).toBeNull();

    const backups = (await fs.readdir(path.dirname(file))).filter((f) => f.includes(".corrupt-"));
    expect(backups).toHaveLength(1);
    expect(await fs.readFile(path.join(path.dirname(file), backups[0]!), "utf8")).toBe("{ not json");
    expect(JSON.parse(await fs.readFile(file, "utf8"))).toEqual(defaultState());
  });

  it("treats valid JSON with invalid values as corrupt", async () => {
    await fs.mkdir(path.dirname(file), { recursive: true });
    await fs.writeFile(file, JSON.stringify({ enabled: "yes" }));
    const store = new StateStore(file);
    expect((await store.read()).enabled).toBe(true);
    expect(store.takeWarning()).not.toBeNull();
  });

  it("serializes concurrent updates without losing any", async () => {
    const store = new StateStore(file);
    await Promise.all(
      Array.from({ length: 25 }, () =>
        store.update((s) => {
          s.usage.totalCalls += 1;
        }),
      ),
    );
    expect((await store.read()).usage.totalCalls).toBe(25);
  });

  it("writes atomically: no temp files left behind and the file always parses", async () => {
    const store = new StateStore(file);
    for (let i = 0; i < 5; i++) {
      await store.update((s) => {
        s.usage.totalErrors = i;
      });
      expect(() => JSON.parse(readFileSync(file, "utf8"))).not.toThrow();
    }
    expect(await fs.readdir(path.dirname(file))).toEqual(["state.json"]);
  });

  it("keeps working after a failed mutation", async () => {
    const store = new StateStore(file);
    await expect(
      store.update(() => {
        throw new Error("boom");
      }),
    ).rejects.toThrow("boom");
    await store.update((s) => {
      s.enabled = false;
    });
    expect((await store.read()).enabled).toBe(false);
  });
});
