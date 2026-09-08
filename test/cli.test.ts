import { expect, test } from "bun:test";
import { runCliForTest } from "@structure-ai/cli";
import { Effect } from "effect";
import { makeRoot, normalizeArguments } from "../src/cli.js";

test("preserves exec passthrough and global flag ordering", async () => {
  const parsed = normalizeArguments([
    "--home",
    "/tmp/no-such-contremaitre-home",
    "exec",
    "web",
    "--",
    "node",
    "--help",
  ]);
  expect(parsed.command).toEqual(["node", "--help"]);
  expect(parsed.args[0]).toBe("exec");
  const result = await Effect.runPromise(runCliForTest(makeRoot(parsed.command), parsed.args));
  expect(result.exitCode).not.toBe(0);
  expect(result.errorMessage).toContain("ENOENT");
});
