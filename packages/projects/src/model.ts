import { basename } from "node:path";
import { hash, strings } from "@contremaitre/execution/context";
import { Schema } from "effect";
export const serviceSchema = Schema.Struct({
  kind: Schema.optional(Schema.String),
  image: Schema.optional(Schema.String),
  build: Schema.optional(Schema.String),
  dockerfile: Schema.optional(Schema.String),
  command: Schema.optional(Schema.Array(Schema.String)),
  working_dir: Schema.optional(Schema.String),
  dev: Schema.optional(
    Schema.Struct({
      source: Schema.String,
      target: Schema.String,
      install: Schema.optional(Schema.Array(Schema.String)),
      exclude: Schema.optional(Schema.Array(Schema.String)),
    }),
  ),
  port: Schema.optional(Schema.Int),
  http: Schema.optional(Schema.Boolean),
  depends_on: Schema.optional(Schema.Array(Schema.String)),
  environment: Schema.optional(strings),
  env_file: Schema.optional(Schema.Union(Schema.String, Schema.Array(Schema.String))),
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
