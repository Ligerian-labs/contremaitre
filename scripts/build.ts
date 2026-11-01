import { context, fail } from "@contremaitre/execution/context";
import { run } from "@contremaitre/execution/process";

if (!["darwin", "linux"].includes(process.platform) || !["arm64", "x64"].includes(process.arch))
  fail(`Unsupported build host ${process.platform}-${process.arch}`);
const ctx = context();
await run(ctx, [process.execPath, "scripts/package-agents.ts"], {
  stdout: ctx.log,
  stderr: ctx.log,
});
await run(
  ctx,
  [
    process.execPath,
    "build",
    "apps/cli/src/cli.ts",
    "packages/environments/src/pglite-worker.ts",
    "--compile",
    "--bytecode",
    "--format=esm",
    "--no-compile-autoload-dotenv",
    "--no-compile-autoload-bunfig",
    "--outfile",
    "bin/contremaitre",
  ],
  { stdout: ctx.log, stderr: ctx.log },
);
