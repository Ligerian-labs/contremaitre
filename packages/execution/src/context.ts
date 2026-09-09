import { createHash } from "node:crypto";
import { Data, Schema } from "effect";
export class HubError extends Data.TaggedError("HubError")<{
  readonly message: string;
  readonly exitCode?: number;
  readonly classification: "permanent" | "transient" | "conflict";
}> {}
export function fail(
  message: string,
  classification: HubError["classification"] = "permanent",
): never {
  throw new HubError({ message, classification });
}
export const message = (error: unknown): string =>
  error instanceof Error ? error.message : String(error);
export const keys = <T>(value: Record<string, T> | null | undefined): string[] =>
  Object.keys(value ?? {}).sort();
export const own = (value: object, key: string): boolean => Object.hasOwn(value, key);
export const now = (): string => new Date().toISOString();
export const strings = Schema.Record({ key: Schema.String, value: Schema.String });
export const serviceProgressSchema = Schema.Struct({
  status: Schema.Literal("waiting", "running", "ready", "failed", "blocked", "cancelled"),
  detail: Schema.String,
  url: Schema.optional(Schema.String),
});
export type ServiceProgress = Schema.Schema.Type<typeof serviceProgressSchema>;
export interface Context {
  processDirectory?: string;
  signal: AbortSignal;
  log: (data: Uint8Array | string, service?: string) => void;
  service?: string;
  progress?: (service: string, value: ServiceProgress) => void;
}
export const context = (
  signal = new AbortController().signal,
  log: Context["log"] = () => {},
): Context => ({ signal, log });
export function serviceContext(parent: Context, service: string): Context {
  return { ...parent, service, log: (data) => parent.log(data, service) };
}
export function progress(
  ctx: Context,
  status: ServiceProgress["status"],
  detail: string,
  url?: string,
) {
  if (ctx.service) ctx.progress?.(ctx.service, { status, detail, ...(url ? { url } : {}) });
}
export function phase(ctx: Context, text: string): void {
  ctx.log(`[contremaitre] ${ctx.service ? `${ctx.service}: ` : ""}${text}\n`);
  progress(ctx, "running", text);
}
export function decode<A, I>(schema: Schema.Schema<A, I>, value: unknown, label: string): A {
  try {
    return Schema.decodeUnknownSync(schema, { onExcessProperty: "error" })(value);
  } catch {
    return fail(`Invalid ${label}`);
  }
}
export const hash = (value: string | Uint8Array): string =>
  createHash("sha256").update(value).digest("hex");
export const isCode = (e: unknown, code: string): boolean =>
  e instanceof Error && "code" in e && e.code === code;
