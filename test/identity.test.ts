import { expect, test } from "bun:test";
import { newIdentity } from "../src/model.js";

test("preserves a deployed Go environment identity", () => {
  const i = newIdentity(
    "bigatelier",
    "/Users/valentindosimont/workspace/bigatelier-contremaitre-fix",
    "main",
  );
  expect(i.ID).toBe("553deea3cede0216");
  expect(i.Host).toBe("main-bigatelier-contremaitre-fix-553deea3.bigatelier.localhost");
  expect(newIdentity("bigatelier", "/tmp/another-workspace", "main").ID).not.toBe(i.ID);
});
