import { hash } from "@contremaitre/execution/context";
import type { Driver, Identity, Service } from "@contremaitre/projects/model";
import { Schema } from "effect";
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
  deployment?: string;
  ready?: boolean;
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
export const resourceName = (prefix: string, name: string): string =>
  `${prefix}-${name.length > 30 ? `${name.slice(0, 23)}-${hash(name).slice(0, 6)}` : name}`;
