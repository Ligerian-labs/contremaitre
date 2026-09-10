import { randomUUID } from "node:crypto";
import {
  appendFileSync,
  closeSync,
  existsSync,
  mkdirSync,
  openSync,
  readdirSync,
  readFileSync,
  readSync,
  rmSync,
  statSync,
  unlinkSync,
} from "node:fs";
import { join } from "node:path";
import {
  type Context,
  context,
  fail,
  hash,
  message,
  now,
  phase,
  serviceProgressSchema,
} from "@contremaitre/execution/context";
import { atomicWrite } from "@contremaitre/execution/files";
import { EnvironmentLocks, Semaphore } from "@contremaitre/execution/locks";
import { Schema } from "effect";

export const operationSchema = Schema.Struct({
  version: Schema.Literal(1),
  id: Schema.String,
  environmentId: Schema.String,
  kind: Schema.String,
  status: Schema.Literal("queued", "running", "succeeded", "failed", "cancelled", "interrupted"),
  createdAt: Schema.String,
  updatedAt: Schema.String,
  error: Schema.optional(Schema.String),
  name: Schema.optional(Schema.String),
  services: Schema.optional(Schema.Record({ key: Schema.String, value: serviceProgressSchema })),
});
export type Operation = Schema.Schema.Type<typeof operationSchema>;
export const terminal = (op: Operation): boolean => !["queued", "running"].includes(op.status);
interface Active {
  controller: AbortController;
  done: Promise<void>;
}
/** Owns operations independently of any client connection. State is committed before work starts. */
export class Operations {
  private readonly records = new Map<string, Operation>();
  private readonly active = new Map<string, Active>();
  private readonly byEnvironment = new Map<string, string>();
  private readonly slots: Semaphore;
  private accepting = true;
  onTransition: (op: Operation) => void = () => {};
  readonly locks = new EnvironmentLocks();
  readonly directory: string;
  constructor(
    home: string,
    readonly concurrency = 2,
    readonly maxQueue = 64,
    readonly retention = 100,
  ) {
    this.slots = new Semaphore(concurrency);
    this.directory = join(home, "operations");
    mkdirSync(this.directory, { recursive: true, mode: 0o700 });
    for (const file of readdirSync(this.directory).filter((f) => /^[a-f0-9-]{36}\.json$/.test(f))) {
      const op = Schema.decodeUnknownSync(operationSchema)(
        JSON.parse(readFileSync(join(this.directory, file), "utf8")),
      );
      if (file !== `${op.id}.json`) fail("Invalid operation filename");
      this.records.set(op.id, op);
      if (!existsSync(join(this.directory, `${op.id}.log`)))
        atomicWrite(join(this.directory, `${op.id}.log`), "");
      if (!terminal(op))
        this.save({
          ...op,
          status: "interrupted",
          ...(op.services
            ? {
                services: Object.fromEntries(
                  Object.entries(op.services).map(([name, value]) => [
                    name,
                    ["waiting", "running"].includes(value.status)
                      ? { status: "blocked" as const, detail: "hub interrupted deployment" }
                      : value,
                  ]),
                ),
              }
            : {}),
          updatedAt: now(),
          error: "Hub exited during this operation; inspect environment state before redeploying",
        });
    }
    this.trim();
  }
  private save(op: Operation): void {
    atomicWrite(join(this.directory, `${op.id}.json`), JSON.stringify(op));
    const previous = this.records.get(op.id);
    this.records.set(op.id, op);
    if (previous?.status !== op.status) this.onTransition(op);
  }
  private trim(): void {
    const completed = this.list().filter(terminal);
    for (const op of completed.slice(this.retention)) {
      for (const suffix of ["json", "log", "result.json"]) {
        try {
          unlinkSync(join(this.directory, `${op.id}.${suffix}`));
        } catch (e) {
          if (!(e instanceof Error && "code" in e && e.code === "ENOENT")) throw e;
        }
      }
      rmSync(join(this.directory, `${op.id}.logs`), { recursive: true, force: true });
      this.records.delete(op.id);
    }
  }
  get(id: string): Operation {
    const op = this.records.get(id);
    if (!op) fail(`Unknown operation ${id}`);
    return { ...op };
  }
  list(): Operation[] {
    return [...this.records.values()]
      .sort((a, b) => b.createdAt.localeCompare(a.createdAt))
      .map((op) => ({ ...op }));
  }
  current(environmentId: string): Operation | undefined {
    const id = this.byEnvironment.get(environmentId);
    return id ? this.get(id) : undefined;
  }
  submit(
    environmentId: string,
    kind: string,
    lockIds: string[],
    work: (ctx: Context, id: string) => Promise<void>,
    deployment?: { name: string; services: string[] },
  ): Operation {
    if (!this.accepting) fail("Hub is shutting down", "transient");
    const previous = this.current(environmentId);
    if (previous) {
      if (kind === "deploy" && previous.kind === kind) return previous;
      fail(`Environment is busy with operation ${previous.id}`, "conflict");
    }
    if (this.active.size >= this.maxQueue)
      fail("Deployment queue is full; retry later", "transient");
    const id = randomUUID(),
      createdAt = new Date(
        Math.max(Date.now(), ...this.list().map((op) => Date.parse(op.createdAt) + 1)),
      ).toISOString(),
      op: Operation = {
        version: 1,
        id,
        environmentId,
        kind,
        status: "queued",
        createdAt,
        updatedAt: createdAt,
        ...(deployment
          ? {
              name: deployment.name,
              services: Object.fromEntries(
                deployment.services.map((name) => [
                  name,
                  { status: "waiting" as const, detail: "queued" },
                ]),
              ),
            }
          : {}),
      };
    this.save(op);
    atomicWrite(join(this.directory, `${id}.log`), "");
    this.byEnvironment.set(environmentId, id);
    const controller = new AbortController();
    const logs = join(this.directory, `${id}.logs`);
    mkdirSync(logs, { mode: 0o700 });
    const ctx = context(controller.signal, (data, service) => {
      appendFileSync(join(this.directory, `${id}.log`), data);
      appendFileSync(join(logs, service ? `${hash(service)}.log` : "shared.log"), data, {
        mode: 0o600,
      });
    });
    ctx.progress = (service, value) => {
      const current = this.get(id);
      this.save({
        ...current,
        services: { ...current.services, [service]: value },
        updatedAt: now(),
      });
    };
    const finish = (status: Operation["status"], error?: string) => {
      const current = this.get(id);
      const services =
        current.services &&
        Object.fromEntries(
          Object.entries(current.services).map(([name, value]) => [
            name,
            ["waiting", "running"].includes(value.status)
              ? {
                  status: status === "cancelled" ? ("cancelled" as const) : ("blocked" as const),
                  detail: error ?? status,
                }
              : value,
          ]),
        );
      this.save({ ...current, status, error, ...(services ? { services } : {}), updatedAt: now() });
    };
    ctx.processDirectory = join(this.directory, "..", "processes");
    // Start in a microtask so the active index is installed before any work completes.
    const done = Promise.resolve().then(async () => {
      try {
        phase(ctx, `Operation ${id} queued`);
        await this.locks.use(lockIds, controller.signal, () =>
          this.slots.use(controller.signal, async () => {
            this.save({ ...this.get(id), status: "running", updatedAt: now() });
            phase(ctx, `Operation ${id} started`);
            await work(ctx, id);
            controller.signal.throwIfAborted();
          }),
        );
        finish("succeeded");
        phase(ctx, "Operation succeeded");
      } catch (e) {
        const error = message(e),
          status = controller.signal.aborted ? "cancelled" : "failed";
        finish(status, error);
        phase(ctx, `Operation ${status}: ${error}`);
      } finally {
        this.active.delete(id);
        this.byEnvironment.delete(environmentId);
        this.trim();
      }
    });
    this.active.set(id, { controller, done });
    return { ...op };
  }
  async cancel(id: string): Promise<Operation> {
    this.get(id);
    const active = this.active.get(id);
    if (active) {
      active.controller.abort(new Error("Cancelled explicitly"));
      await active.done;
    }
    return this.get(id);
  }
  async wait(id: string): Promise<Operation> {
    this.get(id);
    await this.active.get(id)?.done;
    return this.get(id);
  }
  latestDeployment(environmentId: string): Operation {
    const op = this.list().find((op) => op.kind === "deploy" && op.environmentId === environmentId);
    if (!op) fail("No deployment found for this environment");
    return op;
  }
  read(
    id: string,
    offset = 0,
    limit = 65536,
    options: { failure?: boolean; end?: number; summary?: boolean } = {},
  ): { operation: Operation; offset: number; output: string; size: number } {
    const operation = this.get(id);
    if (!Number.isSafeInteger(offset) || offset < 0) fail("Invalid log cursor");
    if (options.end !== undefined && (!Number.isSafeInteger(options.end) || options.end < 0))
      fail("Invalid log end");
    if (
      options.summary ||
      (options.failure && (!terminal(operation) || operation.status === "succeeded"))
    )
      return { operation, offset: 0, output: "", size: 0 };
    const directory = join(this.directory, `${id}.logs`);
    const failed = Object.entries(operation.services ?? {})
      .filter(([, value]) => value.status === "failed")
      .map(([name]) => name)
      .sort();
    const paths =
      options.failure && failed.length && existsSync(directory)
        ? [
            join(directory, "shared.log"),
            ...failed.map((name) => join(directory, `${hash(name)}.log`)),
          ].filter(existsSync)
        : [join(this.directory, `${id}.log`)];
    const sizes = paths.map((path) => statSync(path).size);
    const size = sizes.reduce((a, b) => a + b, 0);
    const end = Math.min(size, options.end ?? size);
    const data = Buffer.alloc(Math.min(65536, Math.max(0, limit), Math.max(0, end - offset)));
    let base = 0,
      count = 0;
    for (let i = 0; i < paths.length && count < data.length; i++) {
      if (offset + count < base + sizes[i]) {
        const local = Math.max(0, offset + count - base);
        const fd = openSync(paths[i], "r");
        try {
          count += readSync(
            fd,
            data,
            count,
            Math.min(data.length - count, sizes[i] - local),
            local,
          );
        } finally {
          closeSync(fd);
        }
      }
      base += sizes[i];
    }
    return {
      operation,
      offset: offset + count,
      output: data.subarray(0, count).toString("base64"),
      size: end,
    };
  }
  async shutdown(): Promise<void> {
    this.accepting = false;
    for (const a of this.active.values()) a.controller.abort(new Error("Hub shutting down"));
    await Promise.all([...this.active.values()].map((a) => a.done));
  }
}
