import { homedir } from "node:os";
import { join, resolve } from "node:path";
import { installBinary } from "@contremaitre/cli/install";
import { context, message } from "@contremaitre/execution/context";

if (import.meta.main) {
  const userHome = process.env.HOME || homedir();
  try {
    await installBinary(
      context(AbortSignal.timeout(400_000), (data) => process.stdout.write(data)),
      resolve("bin/contremaitre"),
      join(userHome, ".local", "bin", "contremaitre"),
      resolve(process.env.CONTREMAITRE_HOME || join(userHome, ".local", "share", "contremaitre")),
    );
  } catch (error) {
    process.stderr.write(`make install: ${message(error)}\n`);
    process.exitCode = 1;
  }
}
