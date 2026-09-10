import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import * as fs from "node:fs/promises";
import { join } from "node:path";
import { driverProcess, invokeDriver } from "@contremaitre/environments/driver";
import type { Manager } from "@contremaitre/environments/manager";
import type { Environment, Request } from "@contremaitre/environments/model";
import { type Context, fail, HubError, message } from "@contremaitre/execution/context";
import { run } from "@contremaitre/execution/process";
import type { Operations } from "@contremaitre/operations/operations";
import { inside, loadManifest, validName } from "@contremaitre/projects/config";
import type { VerificationConfig } from "@contremaitre/projects/model";
import { clean, Evidence, type VerificationRun } from "./records.js";
import { sourceIdentity } from "./source.js";

export class AgentWorkflow {
  readonly evidence: Evidence;
  reviewURL = "";
  constructor(
    readonly manager: Manager,
    readonly operations: Operations,
  ) {
    this.evidence = new Evidence(manager.store.home);
  }
  async environment(ctx: Context, req: Request) {
    return this.manager.resolve(
      req.env || (await this.manager.current(ctx, req.root ?? process.cwd(), req.branch)).ID,
    );
  }
  urls(env: Environment) {
    return Object.fromEntries(
      Object.entries(env.Services)
        .filter(([, s]) => s.HTTP)
        .map(([name]) => [name, this.manager.localURL(env, name)]),
    );
  }
  async ready(ctx: Context, env: Environment) {
    const caller = ctx.signal;
    ctx = { ...ctx, signal: AbortSignal.any([ctx.signal, AbortSignal.timeout(10_000)]) };
    if (env.Status !== "running" || !Object.keys(env.Services).length) return false;
    if (env.driver) {
      try {
        return (await invokeDriver(ctx, env, "status")).status === "running";
      } catch {
        caller.throwIfAborted();
        return false;
      }
    }
    for (const s of Object.values(env.Services)) {
      if (s.development_error || s.dependencies_changed || s.ready === false) return false;
      try {
        const current = await this.manager.runtime.inspect(ctx, s.Container);
        if (!current?.Running || current.IP !== s.IP) return false;
      } catch {
        caller.throwIfAborted();
        return false;
      }
    }
    return true;
  }
  async ensure(ctx: Context, req: Request) {
    const p = await this.manager.prepare(ctx, req);
    const id = p.identity.ID,
      source = p.sourceId;
    const active = this.operations.current(id);
    if (active?.kind === "ensure") return active;
    return this.operations.submit(
      id,
      "ensure",
      [
        id,
        ...(source && source !== id && !this.manager.state.Environments[id]?.CloneComplete
          ? [source]
          : []),
      ],
      async (operation, id) => {
        const before = await sourceIdentity(operation, p.root);
        const prepared = await this.manager.prepare(operation, req);
        if (prepared.identity.ID !== p.identity.ID || prepared.sourceId !== p.sourceId)
          fail("Workspace or clone source changed while ensure was queued; retry ensure");
        let env = this.manager.state.Environments[p.identity.ID];
        const reused =
          !!env &&
          env.source?.fingerprint === before.fingerprint &&
          (await this.ready(operation, env)) &&
          !req.rebuild;
        if (!reused) {
          await this.manager.deploy(operation, prepared);
          env = this.manager.resolve(p.identity.ID);
        }
        const after = await sourceIdentity(operation, p.root);
        if (before.fingerprint !== after.fingerprint)
          fail("Source changed during ensure; run contremaitre ensure again");
        if (!env) fail("Environment missing after ensure");
        env.source = after;
        this.manager.save();
        const result = {
          environment_id: env.Identity.ID,
          ready: true,
          reused,
          source: after.fingerprint,
          urls: Object.fromEntries(Object.entries(this.urls(env)).slice(0, 8)),
          additional_services: Math.max(0, Object.keys(this.urls(env)).length - 8),
          review_url: this.reviewURLFor(env.Identity.ID),
        };
        // Operation results are owned by verification and disappear with operation retention.
        writeFileSync(
          join(this.operations.directory, `${id}.result.json`),
          JSON.stringify(result),
          { mode: 0o600 },
        );
      },
    );
  }
  diagnose(id: string, offset = 0, check?: string) {
    if (existsSync(join(this.evidence.path(id), "run.json")))
      return this.evidence.diagnose(id, offset, check);
    const op = this.operations.get(id);
    if (check) fail("No check evidence exists for this operation");
    const chunk = this.operations.read(id, offset, 3000, { failure: true });
    return {
      run_id: id,
      status: op.status,
      error: clean(op.error ?? ""),
      output: clean(Buffer.from(chunk.output, "base64").toString(), 3000),
      offset: chunk.offset,
      truncated: chunk.offset < chunk.size,
    };
  }
  ensureResult(id: string) {
    const op = this.operations.get(id);
    if (op.kind !== "ensure") fail("Not an ensure operation");
    const result = JSON.parse(
      readFileSync(join(this.operations.directory, `${id}.result.json`), "utf8"),
    );
    return { ...result, review_url: this.reviewURLFor(op.environmentId) };
  }
  async verify(ctx: Context, req: Request, profile = "smoke") {
    if (!validName.test(profile)) fail("Invalid profile name");
    const env = await this.environment(ctx, req);
    const config = loadManifest(env.Root).verification;
    const checks = config?.profiles[profile];
    if (!checks?.length)
      return {
        status: "not-configured",
        profile,
        next: "Configure verification.profiles in .contremaitre.yaml",
      };
    return this.operations.submit(
      env.Identity.ID,
      "verify",
      [env.Identity.ID],
      async (operation, id) => {
        const signal = AbortSignal.any([operation.signal, AbortSignal.timeout(1800_000)]);
        const scoped = { ...operation, signal };
        const before = await sourceIdentity(scoped, env.Root);
        if (
          !env.source ||
          before.fingerprint !== env.source.fingerprint ||
          !(await this.ready(scoped, env))
        )
          fail("Environment is stale or not ready; run contremaitre ensure");
        const selected = loadManifest(env.Root).verification?.profiles[profile];
        if (!selected?.length) fail("Verification profile changed; retry ensure");
        const record: VerificationRun = {
          version: 1,
          id,
          environment_id: env.Identity.ID,
          generation: env.generation,
          profile,
          source: before,
          status: "running",
          started_at: new Date().toISOString(),
          stale: false,
          checks: selected.map((c) => ({ name: c.name, status: "skipped", artifacts: [] })),
        };
        this.evidence.save(record);
        let artifactBytes = 0,
          artifactCount = 0;
        try {
          for (const [index, check] of selected.entries()) {
            scoped.signal.throwIfAborted();
            const result = record.checks[index];
            result.status = "running";
            this.evidence.save(record);
            const start = Date.now(),
              logger = this.evidence.logger(id, check.name);
            const artifacts = join(this.evidence.path(id), check.name);
            mkdirSync(artifacts, { recursive: true, mode: 0o700 });
            try {
              await this.execute(scoped, env, check, artifacts, logger.write, id);
              result.status = "passed";
              result.exit_code = 0;
            } catch (error) {
              result.status = signal.aborted ? "interrupted" : "failed";
              result.exit_code = error instanceof HubError ? error.exitCode : undefined;
              result.error =
                error instanceof HubError && error.exitCode !== undefined
                  ? `Check exited with code ${error.exitCode}`
                  : clean(message(error));
            } finally {
              result.duration_ms = Date.now() - start;
              result.log_truncated = logger.close();
            }
            try {
              const collected = await this.artifacts(
                scoped,
                env,
                check,
                artifacts,
                id,
                64 * 1048576 - artifactBytes,
                128 - artifactCount,
              );
              result.artifacts = collected.files;
              artifactBytes += collected.bytes;
              artifactCount += collected.files.length;
            } catch (error) {
              await fs.rm(artifacts, { recursive: true, force: true });
              result.status = signal.aborted ? "interrupted" : "failed";
              result.error = clean(`Artifact collection: ${message(error)}`);
            }
            if (check.service) {
              const cleanup = { ...operation, signal: AbortSignal.timeout(6000) };
              const argv = ["rm", "-rf", `/tmp/contremaitre-${id}/${check.name}`];
              const quiet = { stdout: () => {}, stderr: () => {}, timeout: 6000 };
              try {
                if (env.driver)
                  await driverProcess(cleanup, env, "exec", undefined, check.service, argv, quiet);
                else
                  await this.manager.runtime.exec(
                    cleanup,
                    env.Services[check.service].Container,
                    argv,
                    quiet,
                  );
              } catch (error) {
                result.status = "failed";
                result.error = clean(`Check cleanup: ${message(error)}`);
              }
            }
            this.evidence.save(record);
          }
          const after = await sourceIdentity(scoped, env.Root);
          record.stale =
            before.fingerprint !== after.fingerprint || record.generation !== env.generation;
          record.status =
            record.checks.every((c) => c.status === "passed") && !record.stale
              ? "passed"
              : "failed";
        } catch (error) {
          record.status = signal.aborted ? "interrupted" : "failed";
          for (const check of record.checks)
            if (check.status === "running") check.status = "interrupted";
          operation.log(`${clean(message(error))}\n`);
        } finally {
          record.finished_at = new Date().toISOString();
          this.evidence.save(record);
          this.evidence.trim();
        }
        if (record.status !== "passed")
          fail(`Verification ${record.status}; run contremaitre diagnose --run ${id}`);
      },
    );
  }
  private async execute(
    ctx: Context,
    env: Environment,
    check: VerificationConfig["profiles"][string][number],
    artifacts: string,
    write: (data: Buffer) => void,
    id: string,
  ) {
    const urls =
      check.service && !env.driver
        ? Object.fromEntries(
            Object.entries(env.Services)
              .filter(([, s]) => s.HTTP)
              .map(([name, s]) => [
                name,
                `http://${s.IP.includes(":") ? `[${s.IP}]` : s.IP}:${s.Port}`,
              ]),
          )
        : this.urls(env);
    const base = (check.service ? urls[check.service] : undefined) ?? Object.values(urls)[0] ?? "";
    const values = {
      CONTREMAITRE_ENVIRONMENT: env.Identity.ID,
      CONTREMAITRE_URLS: JSON.stringify(urls),
      CONTREMAITRE_BASE_URL: base,
      CONTREMAITRE_ARTIFACTS: check.service ? `/tmp/contremaitre-${id}/${check.name}` : artifacts,
    };
    const options = {
      stdout: write,
      stderr: write,
      timeout: ((check.timeout_seconds ?? 300) + (check.service ? 6 : 0)) * 1000,
    };
    if (check.service) {
      const service = env.Services[check.service];
      if (!service) fail(`Unknown service ${check.service}`);
      const exec = async (args: readonly string[]) =>
        env.driver
          ? driverProcess(ctx, env, "exec", undefined, check.service, [...args], options)
          : this.manager.runtime.exec(ctx, service.Container, args, options);
      await exec(["mkdir", "-p", values.CONTREMAITRE_ARTIFACTS]);
      // The remote process needs its own deadline even if the exec client disconnects.
      try {
        await exec([
          "setsid",
          "sh",
          "-c",
          'printf "%s" "$$" > "$1/.pid"; shift; exec timeout -k 4 "$@"',
          "contremaitre-check",
          values.CONTREMAITRE_ARTIFACTS,
          String(check.timeout_seconds ?? 300),
          "env",
          ...Object.entries(values).map(([k, v]) => `${k}=${v}`),
          ...check.command,
        ]);
      } finally {
        const cleanup = { ...ctx, signal: AbortSignal.timeout(6000) };
        const command = [
          "sh",
          "-c",
          'if [ -r "$1/.pid" ]; then pid=$(cat "$1/.pid"); case "$pid" in ""|*[!0-9]*) exit 1;; esac; kill -TERM "-$pid" 2>/dev/null || true; sleep 0.1; kill -KILL "-$pid" 2>/dev/null || true; fi',
          "contremaitre-cleanup",
          values.CONTREMAITRE_ARTIFACTS,
        ];
        const quiet = { stdout: () => {}, stderr: () => {}, timeout: 6000 };
        if (env.driver)
          await driverProcess(cleanup, env, "exec", undefined, check.service, command, quiet);
        else await this.manager.runtime.exec(cleanup, service.Container, command, quiet);
      }
    } else
      await run(ctx, check.command, {
        ...options,
        cwd: env.Root,
        env: { ...process.env, ...values },
      });
  }
  private async artifacts(
    ctx: Context,
    env: Environment,
    check: VerificationConfig["profiles"][string][number],
    directory: string,
    id: string,
    budget: number,
    count: number,
  ) {
    if (check.service) {
      for (const path of check.artifacts ?? []) {
        const service = env.Services[check.service],
          chunks: Buffer[] = [];
        let size = 0;
        const options = {
          timeout: 10_000,
          stdout: (data: Buffer) => {
            size += data.length;
            if (size > 16 * 1048576) fail("Artifact exceeds 16 MiB");
            chunks.push(data);
          },
          stderr: () => {},
        };
        const args = ["cat", `/tmp/contremaitre-${id}/${check.name}/${path}`];
        if (env.driver)
          await driverProcess(ctx, env, "exec", undefined, check.service, args, options);
        else await this.manager.runtime.exec(ctx, service.Container, args, options);
        await fs.mkdir(join(directory, path, ".."), { recursive: true, mode: 0o700 });
        await fs.writeFile(join(directory, path), Buffer.concat(chunks), { mode: 0o600 });
      }
    }
    const files: string[] = [];
    let bytes = 0;
    const walk = async (dir: string): Promise<void> => {
      for (const entry of await fs.readdir(dir, { withFileTypes: true })) {
        const path = join(dir, entry.name),
          stat = await fs.lstat(path);
        if (stat.isSymbolicLink() || !inside(directory, await fs.realpath(path)))
          fail("Artifact symlinks are not allowed");
        if (stat.isDirectory()) await walk(path);
        else {
          bytes += stat.size;
          if (!stat.isFile() || files.length >= count || stat.size > 16 * 1048576 || bytes > budget)
            fail("Artifacts exceed 128 files, 16 MiB per file or 64 MiB per run");
          files.push(path.slice(directory.length + 1));
          await fs.chmod(path, 0o600);
        }
      }
    };
    await walk(directory);
    return { files, bytes };
  }
  reviewURLFor(id: string) {
    return `${this.reviewURL}/${id}`;
  }
  async report(ctx: Context, req: Request) {
    const env = await this.environment(ctx, req),
      record = this.evidence.latest(env.Identity.ID);
    let fingerprint: string | undefined;
    try {
      fingerprint = (await sourceIdentity(ctx, env.Root)).fingerprint;
    } catch {
      ctx.signal.throwIfAborted();
    }
    const ready = await this.ready(ctx, env);
    const current = !!fingerprint && env.source?.fingerprint === fingerprint;
    const stale =
      !!record &&
      (record.stale ||
        record.source.fingerprint !== fingerprint ||
        record.generation !== env.generation);
    return {
      environment_id: env.Identity.ID,
      ready,
      source: env.source?.fingerprint ?? null,
      source_current: current,
      verification: record?.status ?? "not-run",
      profile: record?.profile,
      stale,
      run_id: record?.id,
      counts: record ? this.counts(record) : undefined,
      urls: Object.fromEntries(Object.entries(this.urls(env)).slice(0, 8)),
      additional_services: Math.max(0, Object.keys(this.urls(env)).length - 8),
      review_url: this.reviewURLFor(env.Identity.ID),
    };
  }
  counts(record: VerificationRun) {
    return {
      passed: record.checks.filter((c) => c.status === "passed").length,
      failed: record.checks.filter((c) => c.status === "failed" || c.status === "interrupted")
        .length,
      skipped: record.checks.filter((c) => c.status === "skipped").length,
    };
  }
  result(id: string) {
    const record = this.evidence.get(id);
    return {
      run_id: id,
      status: record.status,
      stale: record.stale,
      counts: this.counts(record),
      review_url: this.reviewURLFor(record.environment_id),
      ...(record.status !== "passed" ? { next: `contremaitre diagnose --run ${id}` } : {}),
    };
  }
}
