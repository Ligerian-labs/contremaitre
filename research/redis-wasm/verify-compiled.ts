import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

const temporary = await mkdtemp(join(tmpdir(), "contremaitre-redis-wasm-"));
async function run(args: string[], cwd: string) {
  const child = Bun.spawn(args, { cwd, stdout: "pipe", stderr: "pipe" });
  const timer = setTimeout(() => child.kill(), 30000);
  try {
    const [stdout, stderr, code] = await Promise.all([
      new Response(child.stdout).text(),
      new Response(child.stderr).text(),
      child.exited,
    ]);
    assert.equal(code, 0, `${args[0]} failed (${code}):\n${stdout}\n${stderr}`);
    return stdout;
  } finally {
    clearTimeout(timer);
  }
}
try {
  const binary = join(temporary, "redis-spike");
  await run(
    [
      process.execPath,
      "build",
      "compiled.ts",
      "worker.ts",
      "--compile",
      "--bytecode",
      "--format=esm",
      "--asset-naming=[name].[ext]",
      "--no-compile-autoload-dotenv",
      "--no-compile-autoload-bunfig",
      "--outfile",
      binary,
    ],
    import.meta.dir,
  );
  const isolated = join(temporary, "empty");
  await mkdir(isolated);
  // Only the binary is launched, from an empty directory. Its loader resolves
  // the engine asset in Bun's embedded filesystem, rather than node_modules.
  const output = await run([binary], isolated);
  assert.match(output, /Redis Wasm standalone probe passed/);
  console.log(output.trim());
} finally {
  await rm(temporary, { recursive: true, force: true });
}
