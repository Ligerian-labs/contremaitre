import { createHash } from "node:crypto";
import { basename } from "node:path";
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
export const serviceSchema = Schema.Struct({
  kind: Schema.optional(Schema.String),
  image: Schema.optional(Schema.String),
  build: Schema.optional(Schema.String),
  dockerfile: Schema.optional(Schema.String),
  command: Schema.optional(Schema.Array(Schema.String)),
  port: Schema.optional(Schema.Int),
  http: Schema.optional(Schema.Boolean),
  depends_on: Schema.optional(Schema.Array(Schema.String)),
  environment: Schema.optional(strings),
  env_file: Schema.optional(Schema.String),
  volumes: Schema.optional(strings),
  init: Schema.optional(Schema.Array(Schema.String)),
  migrate: Schema.optional(Schema.Array(Schema.String)),
  ready: Schema.optional(Schema.Array(Schema.String)),
  cpus: Schema.optional(Schema.Int),
  memory: Schema.optional(Schema.String),
});
export type Service = Schema.Schema.Type<typeof serviceSchema>;
export const driverSchema = Schema.Struct({
  executable: Schema.String,
  timeout_seconds: Schema.optional(Schema.Int),
});
export type Driver = Schema.Schema.Type<typeof driverSchema>;
export interface Manifest {
  version: 1;
  project: string;
  services: Record<string, Service>;
  driver?: Driver;
}
export interface Identity {
  Project: string;
  Workspace: string;
  Branch: string;
  ID: string;
  Name: string;
  Host: string;
}
export interface BuildRecord {
  digest: string;
  image: string;
}
export interface TunnelReservation {
  Provider: string;
  ID: string;
  URL: string;
  Desired: boolean;
  Connected: boolean;
}
export interface ServiceState {
  Name: string;
  Container: string;
  Image: string;
  IP: string;
  Volume: string;
  Port: number;
  HTTP: boolean;
  Spec: Service;
  Initialized: boolean;
  url?: string;
  raw_environment?: Record<string, string>;
}
export interface Environment {
  Identity: Identity;
  Root: string;
  Status: string;
  Error: string;
  Network: string;
  Services: Record<string, ServiceState>;
  credentials?: Record<string, string>;
  Volumes: string[];
  Images: string[];
  CloneComplete: boolean;
  CreatedAt: string;
  UpdatedAt: string;
  tunnels?: Record<string, TunnelReservation>;
  driver?: Driver;
  driver_directory?: string;
  builds?: Record<string, BuildRecord>;
}
export interface State {
  Version: 1;
  Environments: Record<string, Environment>;
  Main: Record<string, string>;
}
export const requestSchema = Schema.Struct({
  root: Schema.optional(Schema.String),
  branch: Schema.optional(Schema.String),
  env: Schema.optional(Schema.String),
  service: Schema.optional(Schema.String),
  delete_data: Schema.optional(Schema.Boolean),
  main: Schema.optional(Schema.Boolean),
  rebuild: Schema.optional(Schema.Boolean),
});
export type Request = Schema.Schema.Type<typeof requestSchema>;
export interface Context {
  processDirectory?: string;
  signal: AbortSignal;
  log: (data: Uint8Array | string) => void;
}
export const context = (
  signal = new AbortController().signal,
  log: Context["log"] = () => {},
): Context => ({ signal, log });
export const phase = (ctx: Context, text: string): void => ctx.log(`[contremaitre] ${text}\n`);
export function decode<A, I>(schema: Schema.Schema<A, I>, value: unknown, label: string): A {
  try {
    return Schema.decodeUnknownSync(schema, { onExcessProperty: "error" })(value);
  } catch {
    return fail(`Invalid ${label}`);
  }
}
export const hash = (value: string | Uint8Array): string =>
  createHash("sha256").update(value).digest("hex");
export const slug = (value: string): string =>
  value
    .toLowerCase()
    .replace(/[^a-z0-9-]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 40)
    .replace(/-+$/g, "") || "workspace";
export function newIdentity(project: string, workspace: string, branch: string): Identity {
  const id = hash(`${project}\0${workspace}\0${branch}`).slice(0, 16);
  const label =
    `${slug(branch)}-${slug(basename(workspace))}`.slice(0, 44).replace(/-+$/, "") +
    `-${id.slice(0, 8)}`;
  return {
    Project: project,
    Workspace: workspace,
    Branch: branch,
    ID: id,
    Name: `${project}/${label}`,
    Host: `${label}.${slug(project)}.localhost`,
  };
}
export const resourceName = (prefix: string, name: string): string =>
  `${prefix}-${name.length > 30 ? `${name.slice(0, 23)}-${hash(name).slice(0, 6)}` : name}`;
export const isCode = (e: unknown, code: string): boolean =>
  e instanceof Error && "code" in e && e.code === code;
