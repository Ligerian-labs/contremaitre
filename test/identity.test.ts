import { expect, test } from "bun:test";
import { newIdentity } from "@contremaitre/projects/model";

test("preserves internal environment IDs and uses a readable hostname", () => {
  const i = newIdentity(
    "bigatelier",
    "/Users/valentindosimont/workspace/bigatelier-contremaitre-fix",
    "main",
  );
  expect(i.ID).toBe("553deea3cede0216");
  expect(i.Host).toBe("main-bigatelier-contremaitre-fix.bigatelier.localhost");
  expect(newIdentity("bigatelier", "/tmp/another-workspace", "main").ID).not.toBe(i.ID);
});

test("normalized, truncated and project-slug collisions receive a hash", () => {
  for (const [project, workspace, branch, otherProject, otherWorkspace, otherBranch] of [
    ["shop", "/tmp/a/app", "feature/a", "shop", "/tmp/b/app", "feature-a"],
    ["shop", "/tmp/a/app", "x".repeat(41), "shop", "/tmp/b/app", `${"x".repeat(40)}y`],
    ["shop", `/tmp/${"a".repeat(40)}-one`, "main", "shop", `/tmp/${"a".repeat(40)}-two`, "main"],
    ["shop-one", "/tmp/a/app", "main", "SHOP-ONE", "/tmp/b/app", "main"],
  ]) {
    const first = newIdentity(project, workspace, branch);
    const second = newIdentity(otherProject, otherWorkspace, otherBranch, [first]);
    expect(second.Host).not.toBe(first.Host);
    expect(second.Host.split(".")[0]).toEndWith(`-${second.ID.slice(0, 8)}`);
    expect(newIdentity(project, workspace, branch, [first, second])).toEqual(first);
  }
});

test("occupied hash fallbacks are checked and all DNS labels fit", () => {
  const first = newIdentity("shop", "/tmp/one/app", "x".repeat(40));
  const second = newIdentity("shop", "/tmp/two/app", "x".repeat(40), [first]);
  const occupied = { ...second, ID: "0000000000000000" };
  const extended = newIdentity("shop", "/tmp/two/app", "x".repeat(40), [first, occupied]);
  expect(extended.Host).not.toBe(second.Host);
  const occupiedFull = { ...extended, ID: "1111111111111111" };
  const further = newIdentity("shop", "/tmp/two/app", "x".repeat(40), [
    first,
    occupied,
    occupiedFull,
  ]);
  expect(new Set([first.Host, second.Host, extended.Host, further.Host]).size).toBe(4);
  expect(further.Host.split(".")[0].length).toBeLessThanOrEqual(63);
});
