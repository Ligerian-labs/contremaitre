import { hash } from "@contremaitre/execution/context";
import {
  type Driver,
  type Identity,
  type RuntimeKind,
  type Service,
  serviceEndpoints,
} from "@contremaitre/projects/model";
import { Schema } from "effect";
export const defaultIdleTimeoutSeconds = 7200;
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
  /** Address host: Apple container IP, or loopback for host-process runtimes. Empty when stopped. */
  Host: string;
  /** Runtime recorded at the service's first deploy. Absent only on driver services. */
  Runtime?: RuntimeKind;
  /** Declared port -> reserved loopback port, for host-process runtimes. */
  Ports?: Record<string, number>;
  Volume: string;
  Port: number;
  HTTP: boolean;
  Spec: Service;
  Initialized: boolean;
  deployment?: string;
  development_source?: string;
  dependency_cache?: string;
  ready?: boolean;
  url?: string;
  raw_environment?: Record<string, string>;
  development_error?: string;
  dependencies_changed?: boolean;
}
export interface Environment {
  source?: { fingerprint: string; revision?: string };
  generation?: string;
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
  idle_timeout_seconds?: number;
  last_activity_at?: string;
  tunnels?: Record<string, TunnelReservation>;
  tunnel_configuration?: { urls: Record<string, string>; pending: string[] };
  driver?: Driver;
  driver_directory?: string;
  builds?: Record<string, BuildRecord>;
}
export function httpEndpoints(
  env: Environment,
): Record<string, { service: ServiceState; port: number }> {
  return Object.fromEntries(
    Object.entries(env.Services)
      .sort(([a], [b]) => a.localeCompare(b))
      .flatMap(([name, service]) =>
        Object.entries(
          service.Spec.endpoints !== undefined
            ? serviceEndpoints(name, service.Spec)
            : service.HTTP
              ? { [name]: service.Port }
              : {},
        ).map(([endpoint, port]) => [endpoint, { service, port }] as const),
      )
      .sort(([a], [b]) => a.localeCompare(b)),
  );
}
/** Where the hub and host processes reach a service's declared port, or undefined while it has no host. */
export function serviceAddress(
  service: ServiceState,
  port: number,
): { host: string; port: number } | undefined {
  if (!service.Host) return;
  return { host: service.Host, port: service.Ports?.[String(port)] ?? port };
}
export const addressURL = (address: { host: string; port: number }): string =>
  `http://${address.host.includes(":") ? `[${address.host}]` : address.host}:${address.port}`;
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
  session_id: Schema.optional(Schema.String),
  provider: Schema.optional(Schema.String),
  delete_data: Schema.optional(Schema.Boolean),
  main: Schema.optional(Schema.Boolean),
  rebuild: Schema.optional(Schema.Boolean),
});
export type Request = Schema.Schema.Type<typeof requestSchema>;
export const resourceName = (prefix: string, name: string): string =>
  `${prefix}-${name.length > 30 ? `${name.slice(0, 23)}-${hash(name).slice(0, 6)}` : name}`;
