import { expect, test } from "bun:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { defineCommand, Options, runCliForTest } from "@structure-ai/cli";
import { Effect } from "effect";
import { commands, deployLogsHelp } from "../apps/cli/src/help.js";
import { optionsFor } from "../apps/cli/src/options.js";

const home = process.env.CONTREMAITRE_HOME || join(homedir(), ".local", "share", "contremaitre");

function helpText(doc: unknown): string[] {
  if (Array.isArray(doc)) return doc.flatMap(helpText);
  if (!doc || typeof doc !== "object") return [];
  return Object.entries(doc).flatMap(([key, value]) =>
    key === "value" && typeof value === "string" ? [value] : helpText(value),
  );
}

async function optionSurface() {
  const definitions = new Map<string, string>(),
    surfaces: string[] = [];
  let keys: string[] | undefined;
  for (const command of [...commands, deployLogsHelp]) {
    const options = optionsFor(command);
    keys ??= Object.keys(options);
    assert.deepEqual(Object.keys(options), keys);
    let defaults: Record<string, unknown> | undefined;
    const result = await Effect.runPromise(
      runCliForTest(
        defineCommand({
          name: "options-contract",
          options,
          handler: (values) =>
            Effect.sync(() => {
              defaults = values;
            }),
        }),
        [],
      ),
    );
    assert.equal(result.exitCode, 0, result.errorMessage ?? "defaults were rejected");
    assert.ok(defaults);
    const selected: string[] = [];
    for (const [key, option] of Object.entries(options)) {
      const help = helpText(Options.getHelp<unknown>(option)).join(" ").replace(/\s+/g, " ").trim();
      if (!help) continue;
      selected.push(key);
      let fallback: unknown = defaults[key];
      if (key === "home") {
        assert.equal(fallback, home);
        fallback = "<hub home>";
      }
      const definition = `${JSON.stringify(fallback)} | ${help}`;
      if (definitions.has(key)) assert.equal(definitions.get(key), definition, key);
      definitions.set(key, definition);
    }
    for (const name of [
      command === deployLogsHelp ? "deploy logs" : command.name,
      ...(command.aliases ?? []),
    ])
      surfaces.push(`${name}: ${selected.join(" ")}`);
  }
  return [
    `Parser keys: ${keys?.join(" ")}`,
    "",
    "Defaults | framework help (names, aliases, types, choices and descriptions)",
    ...[...definitions].map(([key, definition]) => `${key}: ${definition}`),
    "",
    "Commands (parser order)",
    ...surfaces,
    "",
  ].join("\n");
}

test("every command preserves its option surface", async () => {
  expect(await optionSurface()).toBe(
    readFileSync(new URL("./fixtures/cli-options.txt", import.meta.url), "utf8"),
  );
});
