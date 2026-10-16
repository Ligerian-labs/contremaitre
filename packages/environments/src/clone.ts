import { constants, existsSync, readdirSync, readFileSync } from "node:fs";
import * as fs from "node:fs/promises";
import { join } from "node:path";
import {
  type Context,
  decode,
  fail,
  message,
  phase,
  progress,
  serviceContext,
} from "@contremaitre/execution/context";
import { atomicWrite, removeFile } from "@contremaitre/execution/files";
import { order } from "@contremaitre/projects/config";
import { Schema } from "effect";
import { invokeDriver } from "./driver.js";
import type { Manager } from "./manager.js";
import type { Environment, ServiceState } from "./model.js";

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
// Main shares service names with the target; its restarts must not update the target's rows.
const withoutProgress = (ctx: Context): Context => ({ ...ctx, progress: undefined });
async function recover(m: Manager, ctx: Context, r: Recovery) {
  const source = m.state.Environments[r.source];
  if (!source) fail(`Clone recovery source ${r.source} is missing`);
  try {
    if (r.driver) await invokeDriver(ctx, source, "recover");
    else {
      // A confirmed local stop supersedes the earlier request to resume writers.
      if (source.Status === "stopped") {
        r.writers = [];
        r.originalStatus = "stopped";
        save(m, r);
      }
      const names = order(
        Object.fromEntries(Object.entries(source.Services).map(([name, s]) => [name, s.Spec])),
      );
      for (const name of names)
        if (r.writers.includes(name)) {
          const s = source.Services[name];
          phase(ctx, `Resuming main ${name}`);
          await m.backend(s).remove(ctx, s.Container);
          await m.startService(withoutProgress(ctx), source, s, false);
          r.writers = r.writers.filter((n) => n !== name);
          save(m, r);
        }
      for (const name of [...r.temporary]) {
        const s = source.Services[name];
        if (!s) fail(`Unknown recovery service ${name}`);
        await m.backend(s).stop(ctx, s.Container);
        await m.backend(s).remove(ctx, s.Container);
        s.Host = "";
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
  const blocked = new Set<string>();
  if (!existsSync(dir)) return blocked;
  const recovery = { ...ctx, signal: AbortSignal.any([ctx.signal, AbortSignal.timeout(120_000)]) };
  for (const file of readdirSync(dir).sort()) {
    if (!/^[a-f0-9]{16}\.json$/.test(file)) continue;
    const data = decode(
      recoverySchema,
      JSON.parse(readFileSync(join(dir, file), "utf8")),
      "clone recovery journal",
    );
    if (file !== `${data.target}.json`) fail("Invalid clone recovery journal filename");
    try {
      recovery.signal.throwIfAborted();
      await recover(m, recovery, {
        ...data,
        writers: [...data.writers],
        temporary: [...data.temporary],
      });
    } catch (error) {
      ctx.signal.throwIfAborted();
      const detail = `Clone recovery failed: ${message(error)}`;
      for (const id of [data.source, data.target]) {
        blocked.add(id);
        const env = m.state.Environments[id];
        if (env) {
          if (env.Status !== "stopped") env.Status = "failed";
          env.Error = detail;
        }
      }
      m.save();
      phase(ctx, `${data.source}/${data.target}: ${detail}; journal retained`);
    }
  }
  return blocked;
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
    fail([failure && message(failure), message(e)].filter(Boolean).join("; "));
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
    const quiesce = async (name: string) => {
      const s = source.Services[name];
      if (!(await m.backend(s).inspect(ctx, s.Container))?.Running) return;
      r.writers.push(name);
      save(m, r);
      await m.backend(s).stop(ctx, s.Container);
      s.Host = "";
      m.save();
    };
    for (const [name, s] of Object.entries(source.Services))
      if (s.Spec.kind === "app") await quiesce(name);
    if (source.Status === "stopped") {
      for (const s of Object.values(source.Services)) await m.backend(s).remove(ctx, s.Container);
      if (
        Object.values(source.Services).some(
          (s) => m.backend(s).capabilities.network === "container",
        )
      ) {
        await m.runtime.removeNetwork(ctx, source.Network);
        await m.runtime.network(ctx, source.Network);
      }
    }
    for (const [name, to] of Object.entries(target.Services)) {
      if (to.Spec.kind !== "postgres") continue;
      const from = source.Services[name];
      if (!from) continue;
      const runtime = m.backend(to),
        fromRuntime = from.Runtime ?? "apple",
        toRuntime = to.Runtime ?? "apple";
      if (fromRuntime !== toRuntime)
        fail(
          `Clone ${name}: main uses runtime ${fromRuntime} and this environment uses ${toRuntime}; give both environments the same runtime for ${name}`,
        );
      if (from.Spec.kind !== "postgres" || from.Image !== to.Image)
        fail(`Clone ${name}: main database image must match target`);
      if (!runtime.clone) fail(`Clone ${name}: runtime ${toRuntime} cannot copy Postgres data`);
      const side = (env: Environment, s: ServiceState) => ({
        name: s.Container,
        data: m.dataDirectory(env, s),
        service: s,
      });
      if (runtime.capabilities.clone === "files") {
        // File copies need both servers stopped; recovery restarts the source.
        await quiesce(name);
        // Leaves the row pending if the copy fails, so the deploy does not report it ready.
        phase(serviceContext(ctx, name), "copying data from main");
        await runtime.stop(ctx, to.Container);
        to.Host = "";
        m.save();
        await runtime.clone(ctx, side(source, from), side(target, to));
        await runtime.remove(ctx, to.Container);
        await m.startService(ctx, target, to, false);
        // The restart reported progress after this database's first ready.
        progress(serviceContext(ctx, name), "ready", "ready");
        continue;
      }
      const inspection = await runtime.inspect(ctx, from.Container);
      if (!inspection?.Running) {
        r.temporary.push(name);
        save(m, r);
        if (inspection) {
          await runtime.start(ctx, from.Container);
          await m.waitReady(withoutProgress(ctx), from);
        } else await m.startService(withoutProgress(ctx), source, from, false);
      }
      await runtime.clone(ctx, side(source, from), side(target, to));
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
      // Read the owned handle directly; Bun can leak a duplicate fd for FileHandle streams.
      const buffer = Buffer.allocUnsafe(64 * 1024);
      while (true) {
        ctx.signal.throwIfAborted();
        const { bytesRead } = await input.read(buffer, 0, buffer.length, null);
        if (!bytesRead) break;
        const bytes = buffer.subarray(0, bytesRead);
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
