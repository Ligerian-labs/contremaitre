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
  statSync,
  unlinkSync,
} from "node:fs";
import { join } from "node:path";
import { type Context, context, fail, message, now, phase } from "@contremaitre/execution/context";
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
    readonly logLimit = 4 * 1024 * 1024,
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
          updatedAt: now(),
          error: "Hub exited during this operation; inspect environment state before redeploying",
        });
    }
    this.trim();
  }
  private save(op: Operation): void {
    atomicWrite(join(this.directory, `${op.id}.json`), JSON.stringify(op));
    this.records.set(op.id, op);
    this.onTransition(op);
  }
  private trim(): void {
    const completed = this.list().filter(terminal);
    for (const op of completed.slice(this.retention)) {
      for (const suffix of ["json", "log"]) {
        try {
          unlinkSync(join(this.directory, `${op.id}.${suffix}`));
        } catch (e) {
          if (!(e instanceof Error && "code" in e && e.code === "ENOENT")) throw e;
        }
      }
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
      createdAt = now(),
      op: Operation = {
        version: 1,
        id,
        environmentId,
        kind,
        status: "queued",
        createdAt,
        updatedAt: createdAt,
      };
    this.save(op);
    atomicWrite(join(this.directory, `${id}.log`), "");
    this.byEnvironment.set(environmentId, id);
    const controller = new AbortController();
    let bytes = 0,
      truncated = false;
    const ctx = context(controller.signal, (data) => {
      if (truncated) return;
      const chunk = Buffer.from(data);
      const remaining = this.logLimit - bytes;
      if (chunk.length <= remaining) {
        appendFileSync(join(this.directory, `${id}.log`), chunk);
        bytes += chunk.length;
      } else {
        if (remaining > 0)
          appendFileSync(join(this.directory, `${id}.log`), chunk.subarray(0, remaining));
        appendFileSync(
          join(this.directory, `${id}.log`),
          "\n[contremaitre] Operation log limit reached; later output is discarded\n",
        );
        truncated = true;
      }
    });
    ctx.processDirectory = join(this.directory, "..", "processes");
    // Start in a microtask so the active index is installed before any work completes.
    const done = Promise.resolve().then(async () => {
      try {
        phase(ctx, `Operation ${id} queued`);
        await this.locks.use(lockIds, controller.signal, () =>
          this.slots.use(controller.signal, async () => {
            this.save({ ...op, status: "running", updatedAt: now() });
            phase(ctx, `Operation ${id} started`);
            await work(ctx, id);
            controller.signal.throwIfAborted();
          }),
        );
        this.save({ ...op, status: "succeeded", updatedAt: now() });
        phase(ctx, "Operation succeeded");
      } catch (e) {
        const error = message(e),
          status = controller.signal.aborted ? "cancelled" : "failed";
        this.save({ ...op, status, updatedAt: now(), error });
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
  read(
    id: string,
    offset = 0,
    limit = 65536,
  ): { operation: Operation; offset: number; output: string } {
    const operation = this.get(id);
    if (!Number.isSafeInteger(offset) || offset < 0) fail("Invalid log cursor");
    const path = join(this.directory, `${id}.log`);
    let fd: number | undefined;
    try {
      fd = openSync(path, "r");
      const data = Buffer.alloc(
        Math.min(65536, Math.max(0, limit), Math.max(0, statSync(path).size - offset)),
      );
      const count = readSync(fd, data, 0, data.length, offset);
      return {
        operation,
        offset: offset + count,
        output: data.subarray(0, count).toString("base64"),
      };
    } finally {
      if (fd !== undefined) closeSync(fd);
    }
  }
  async shutdown(): Promise<void> {
    this.accepting = false;
    for (const a of this.active.values()) a.controller.abort(new Error("Hub shutting down"));
    await Promise.all([...this.active.values()].map((a) => a.done));
  }
}
