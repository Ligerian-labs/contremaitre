import {
  closeSync,
  constants,
  createReadStream,
  existsSync,
  openSync,
  readdirSync,
  readFileSync,
  writeSync,
} from "node:fs";
import * as fs from "node:fs/promises";
import { join } from "node:path";
import { type Context, decode, fail, message, phase } from "@contremaitre/execution/context";
import { atomicWrite, privateFile, removeFile } from "@contremaitre/execution/files";
import { order } from "@contremaitre/projects/config";
import { Schema } from "effect";
import { invokeDriver } from "./driver.js";
import type { Manager } from "./manager.js";
import type { Environment } from "./model.js";

const recoverySchema = Schema.Struct({
  version: Schema.Literal(1),
  source: Schema.String,
  target: Schema.String,
  driver: Schema.Boolean,
  writers: Schema.Array(Schema.String),
  temporary: Schema.Array(Schema.String),
  originalStatus: Schema.optional(Schema.String),
});
interface Recovery {
  version: 1;
  source: string;
  target: string;
  driver: boolean;
  writers: string[];
  temporary: string[];
  originalStatus?: string;
}
const pathFor = (m: Manager, target: string) => join(m.store.home, "recovery", `${target}.json`);
const save = (m: Manager, r: Recovery) => atomicWrite(pathFor(m, r.target), JSON.stringify(r));
async function recover(m: Manager, ctx: Context, r: Recovery) {
  const source = m.state.Environments[r.source];
  if (!source) fail(`Clone recovery source ${r.source} is missing`);
  try {
    if (r.driver) await invokeDriver(ctx, source, "recover");
    else {
      const names = order(
        Object.fromEntries(Object.entries(source.Services).map(([name, s]) => [name, s.Spec])),
      );
      for (const name of names)
        if (r.writers.includes(name)) {
          const s = source.Services[name];
          phase(ctx, `Resuming main ${name}`);
          await m.runtime.remove(ctx, s.Container);
          await m.startService(ctx, source, s, false);
          r.writers = r.writers.filter((n) => n !== name);
          save(m, r);
        }
      for (const name of [...r.temporary]) {
        const s = source.Services[name];
        if (!s) fail(`Unknown recovery service ${name}`);
        await m.runtime.stop(ctx, s.Container);
        await m.runtime.remove(ctx, s.Container);
        s.IP = "";
        r.temporary = r.temporary.filter((n) => n !== name);
        save(m, r);
      }
    }
    if (r.originalStatus) {
      source.Status = r.originalStatus;
      source.Error = "";
    }
    m.save();
    removeFile(pathFor(m, r.target));
  } catch (e) {
    source.Status = "failed";
    source.Error = `Clone recovery failed: ${message(e)}`;
    m.save();
    throw e;
  }
}
export async function recoverClones(m: Manager, ctx: Context) {
  const dir = join(m.store.home, "recovery");
  if (!existsSync(dir)) return;
  for (const file of readdirSync(dir).sort()) {
    if (!/^[a-f0-9]{16}\.json$/.test(file)) continue;
    const data = decode(
      recoverySchema,
      JSON.parse(readFileSync(join(dir, file), "utf8")),
      "clone recovery journal",
    );
    if (file !== `${data.target}.json`) fail("Invalid clone recovery journal filename");
    await recover(m, ctx, { ...data, writers: [...data.writers], temporary: [...data.temporary] });
  }
}
async function withRecovery(
  m: Manager,
  ctx: Context,
  source: Environment,
  target: Environment,
  driver: boolean,
  work: (r: Recovery) => Promise<void>,
) {
  const r: Recovery = {
    version: 1,
    source: source.Identity.ID,
    target: target.Identity.ID,
    driver,
    writers: [],
    temporary: [],
    originalStatus: source.Status,
  };
  save(m, r);
  let failure: unknown;
  try {
    await work(r);
  } catch (e) {
    failure = e;
  }
  try {
    await recover(m, { ...ctx, signal: AbortSignal.timeout(120_000) }, r);
  } catch (e) {
    throw new Error([failure && message(failure), message(e)].filter(Boolean).join("; "));
  }
  if (failure) throw failure;
}
export async function cloneDriver(
  m: Manager,
  ctx: Context,
  source: Environment,
  target: Environment,
) {
  await withRecovery(m, ctx, source, target, true, async () => {
    await invokeDriver(ctx, target, "clone", source);
  });
}
export async function cloneData(
  m: Manager,
  ctx: Context,
  source: Environment,
  target: Environment,
) {
  await withRecovery(m, ctx, source, target, false, async (r) => {
    for (const [name, s] of Object.entries(source.Services))
      if (s.Spec.kind === "app" && (await m.runtime.inspect(ctx, s.Container))?.Running) {
        r.writers.push(name);
        save(m, r);
        await m.runtime.stop(ctx, s.Container);
        s.IP = "";
        m.save();
      }
    if (source.Status === "stopped") {
      for (const s of Object.values(source.Services)) await m.runtime.remove(ctx, s.Container);
      await m.runtime.removeNetwork(ctx, source.Network);
      await m.runtime.network(ctx, source.Network);
    }
    for (const [name, to] of Object.entries(target.Services)) {
      if (to.Spec.kind !== "postgres") continue;
      const from = source.Services[name];
      if (!from) continue;
      if (from.Spec.kind !== "postgres" || from.Image !== to.Image)
        fail(`Clone ${name}: main database image must match target`);
      const inspection = await m.runtime.inspect(ctx, from.Container);
      if (!inspection?.Running) {
        r.temporary.push(name);
        save(m, r);
        if (inspection) {
          await m.runtime.start(ctx, from.Container);
          await m.waitReady(ctx, from);
        } else await m.startService(ctx, source, from, false);
      }
      const file = privateFile(join(m.store.home, "tmp"), "", "database");
      let fd: number | undefined;
      try {
        fd = openSync(file, "w", 0o600);
        const descriptor = fd;
        await m.runtime.exec(
          ctx,
          from.Container,
          ["pg_dump", "-Fc", "--no-owner", "-U", "app", "-d", "app"],
          {
            stdout: (chunk) => {
              let offset = 0;
              while (offset < chunk.length) offset += writeSync(descriptor, chunk, offset);
            },
            stderr: ctx.log,
            timeout: 1_800_000,
          },
        );
        closeSync(fd);
        fd = undefined;
        const input = createReadStream(file, { fd: openSync(file, "r"), autoClose: true });
        input.on("error", () => {});
        try {
          await m.runtime.exec(
            ctx,
            to.Container,
            [
              "pg_restore",
              "--clean",
              "--if-exists",
              "--no-owner",
              "--exit-on-error",
              "-U",
              "app",
              "-d",
              "app",
            ],
            { stdin: input, stdout: ctx.log, stderr: ctx.log, timeout: 1_800_000 },
          );
        } finally {
          input.destroy();
        }
      } finally {
        if (fd !== undefined) closeSync(fd);
        removeFile(file);
      }
    }
    const volumes = new Set(
      Object.values(target.Services).flatMap((s) => Object.keys(s.Spec.volumes ?? {})),
    );
    for (const name of volumes) {
      const sourcePath = join(m.store.home, "data", source.Identity.ID, name);
      if (!existsSync(sourcePath)) continue;
      const targetPath = join(m.store.home, "data", target.Identity.ID, name);
      await fs.rm(targetPath, { recursive: true, force: true });
      await copyTree(ctx, sourcePath, targetPath);
    }
    for (const [name, to] of Object.entries(target.Services)) {
      const from = source.Services[name];
      if (from?.Spec.kind === to.Spec.kind) to.Initialized = from.Initialized;
    }
  });
}
export async function copyTree(ctx: Context, source: string, target: string): Promise<void> {
  ctx.signal.throwIfAborted();
  const info = await fs.lstat(source);
  if (info.isSymbolicLink()) fail("Symlinks in persistent files are unsupported");
  if (info.isDirectory()) {
    await fs.mkdir(target, { recursive: true, mode: 0o700 });
    for (const name of (await fs.readdir(source)).sort())
      await copyTree(ctx, join(source, name), join(target, name));
    await fs.chmod(target, info.mode & 0o777);
    return;
  }
  if (!info.isFile()) fail("Unsupported persistent file");
  const input = await fs.open(source, constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    const out = await fs.open(target, "wx", info.mode & 0o777);
    try {
      for await (const chunk of input.createReadStream({ autoClose: false })) {
        ctx.signal.throwIfAborted();
        const bytes = Buffer.from(chunk);
        let offset = 0;
        while (offset < bytes.length) offset += (await out.write(bytes, offset)).bytesWritten;
      }
    } finally {
      await out.close();
    }
  } finally {
    await input.close();
  }
}
