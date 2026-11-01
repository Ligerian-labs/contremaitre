import { expect, test } from "bun:test";
import { serviceRuntime } from "@contremaitre/projects/model";

test("Linux defaults native services to Docker", () => {
  expect(serviceRuntime({}, "linux")).toBe("docker");
});
