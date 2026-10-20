import { expect, test } from "bun:test";
import { context, HubError } from "@contremaitre/execution/context";
import { detachDiskImage } from "./disk-images.js";

const busy = () =>
  new HubError({
    message: "hdiutil: couldn't eject disk - Resource busy",
    exitCode: 16,
    classification: "permanent",
  });

test("disk image cleanup waits for transient busy handles and detaches the same owned mount", async () => {
  const commands: (readonly string[])[] = [];
  await detachDiskImage(
    "/owned/test-volume",
    context(AbortSignal.timeout(3000)),
    async (_ctx, argv) => {
      commands.push(argv);
      if (commands.length < 3) throw busy();
      return Buffer.alloc(0);
    },
  );
  expect(commands).toEqual(
    Array.from({ length: 3 }, () => ["hdiutil", "detach", "-force", "/owned/test-volume"]),
  );
});

test("disk image cleanup preserves non-busy failures without retrying", async () => {
  const denied = new HubError({
    message: "not permitted",
    exitCode: 1,
    classification: "permanent",
  });
  let attempts = 0;
  await expect(
    detachDiskImage("/owned/test-volume", context(), async () => {
      attempts++;
      throw denied;
    }),
  ).rejects.toBe(denied);
  expect(attempts).toBe(1);
});

test("a persistently busy image fails at the cleanup deadline instead of being ignored", async () => {
  const controller = new AbortController();
  const deadline = new Error("cleanup deadline");
  let attempts = 0;
  const result = detachDiskImage("/owned/test-volume", context(controller.signal), async () => {
    attempts++;
    controller.abort(deadline);
    throw busy();
  });
  await expect(result).rejects.toBe(deadline);
  expect(attempts).toBe(1);
});
