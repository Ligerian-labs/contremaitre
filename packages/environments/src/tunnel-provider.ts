import { readFileSync } from "node:fs";
import { isAbsolute, join, relative } from "node:path";
import { decode, fail, isCode } from "@contremaitre/execution/context";
import { Schema } from "effect";

export const saasEndpoint = "https://contremaitre.ligerianlabs.fr";
const schema = Schema.Struct({
  default: Schema.String,
  providers: Schema.Record({
    key: Schema.String,
    value: Schema.Struct({ executable: Schema.String, config: Schema.optional(Schema.Unknown) }),
  }),
});
/**
 * Canonical origin of a managed tunnel service: HTTPS, an optional explicit port, and nothing
 * else. Userinfo, paths, queries and fragments are refused rather than normalised away.
 */
export function managedEndpoint(value: string) {
  const url = /^https:\/\/[^/?#@\\]+\/?$/i.test(value) ? URL.parse(value) : null;
  if (url?.protocol !== "https:" || url.port === "0" || !/^[a-z0-9.-]+$/.test(url.hostname))
    return fail("Invalid SaaS endpoint; use an HTTPS origin such as https://tunnels.example.com");
  return url.origin;
}
const managedId = /^saas:([A-Za-z0-9_-]{1,128})(?:@([a-z0-9.-]+(?::\d{1,5})?))?$/;
/**
 * Managed provider IDs bind a workspace to its endpoint. The default endpoint keeps the
 * original `saas:WORKSPACE` form; any other endpoint appends `@HOST[:PORT]`.
 */
export function managedProvider(name: string) {
  const match = managedId.exec(name);
  if (!match?.[1]) return fail("Invalid SaaS provider ID");
  const host = match[2];
  if (host) {
    const endpoint = `https://${host}`;
    let canonical: string | undefined;
    try {
      canonical = managedEndpoint(endpoint);
    } catch {}
    if (canonical !== endpoint || endpoint === saasEndpoint) fail("Invalid SaaS provider ID");
    return { workspace: match[1], endpoint };
  }
  return { workspace: match[1], endpoint: saasEndpoint };
}
export function managedProviderId(workspace: string, endpoint: string) {
  return endpoint === saasEndpoint
    ? `saas:${workspace}`
    : `saas:${workspace}@${new URL(endpoint).host}`;
}
export const credentialAccount = (endpoint: string, workspace: string) =>
  `${endpoint}#${workspace}`;
/**
 * Descriptors, adapter state and the manifest cache of one managed endpoint. The default
 * endpoint keeps the original `<home>/saas` layout so existing installations stay valid.
 */
export function endpointDirectory(home: string, endpoint: string) {
  return endpoint === saasEndpoint
    ? join(home, "saas")
    : join(home, "saas", "endpoints", new URL(endpoint).host.replace(":", "_"));
}
export function managedDescriptor(home: string, provider: string) {
  const { workspace, endpoint } = managedProvider(provider);
  return join(endpointDirectory(home, endpoint), "providers", `${workspace}.json`);
}
export function providerSettings(home: string, managed = false, provider?: string) {
  const file = provider
    ? relative(home, managedDescriptor(home, provider))
    : managed
      ? "saas-provider.json"
      : "tunnels.json";
  let body: string;
  try {
    body = readFileSync(join(home, file), "utf8");
  } catch (e) {
    if (isCode(e, "ENOENT")) return undefined;
    return fail(`Cannot read ${file}`);
  }
  try {
    const value = decode(schema, JSON.parse(body), "tunnel provider configuration");
    if (!managed && Object.keys(value.providers).some((name) => name.startsWith("saas:")))
      fail("Reserved provider name");
    return value;
  } catch {
    return fail(`Invalid ${file}; fix the provider configuration`);
  }
}
export function providerConfig(home: string, provider?: string) {
  const custom = providerSettings(home);
  const all = provider?.startsWith("saas:")
    ? providerSettings(home, true, provider)
    : (custom ?? providerSettings(home, true));
  if (!all) return undefined;
  const name = provider || all.default;
  const cfg = all.providers[name];
  if (!cfg || !isAbsolute(cfg.executable))
    fail(`Tunnel provider ${name} needs an absolute executable path`);
  if (name.startsWith("saas:")) {
    // The adapter talks to whatever endpoint its descriptor names, so the descriptor must
    // agree with the endpoint and workspace encoded in the reserved provider ID.
    const { workspace, endpoint } = managedProvider(name);
    const config = (typeof cfg.config === "object" && cfg.config) || {};
    if (
      !("endpoint" in config && config.endpoint === endpoint) ||
      !("tenant_id" in config && config.tenant_id === workspace) ||
      !(
        "credential_account" in config &&
        config.credential_account === credentialAccount(endpoint, workspace)
      )
    )
      fail(
        `Tunnel provider ${name} does not match its SaaS endpoint; run contremaitre tunnel login`,
      );
  }
  return { name, ...cfg };
}
