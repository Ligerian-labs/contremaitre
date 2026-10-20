import { createHash, randomUUID } from "node:crypto";
import { appendFile, mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

const hash = "812c1d8078e47291e1f024588d818aed4fedeaa3b8db03e411b5ea3a540ab124";
const root = resolve(
  process.env.CONTREMAITRE_WASIX_CACHE ?? join(tmpdir(), "contremaitre-wasix-tests"),
);
await mkdir(root, { recursive: true });
const archive = join(root, "edgejs-quickjs-0.2.5.webc");
let bytes = await readFile(archive).catch(() => undefined);
if (!bytes || createHash("sha256").update(bytes).digest("hex") !== hash) {
  const response = await fetch(`https://cdn.wasmer.io/webcimages/${hash}.webc`, {
    signal: AbortSignal.timeout(120000),
  });
  if (!response.ok) throw Error(`Cannot fetch WASIX test runtime: ${response.status}`);
  bytes = Buffer.from(await response.arrayBuffer());
  if (createHash("sha256").update(bytes).digest("hex") !== hash)
    throw Error("WASIX runtime checksum mismatch");
  const staging = `${archive}.${randomUUID()}`;
  await writeFile(staging, bytes);
  await rename(staging, archive);
}
const runtime = join(root, "runtime");
await rm(runtime, { recursive: true, force: true });
const unpack = Bun.spawn(["wasmer", "package", "unpack", archive, "--out-dir", runtime], {
  stdout: "inherit",
  stderr: "inherit",
});
if ((await unpack.exited) !== 0) throw Error("Cannot unpack WASIX test runtime");
if (process.env.GITHUB_ENV)
  await appendFile(process.env.GITHUB_ENV, `CONTREMAITRE_WASIX_RUNTIME=${runtime}\n`);
console.log(`CONTREMAITRE_WASIX_RUNTIME=${runtime}`);
