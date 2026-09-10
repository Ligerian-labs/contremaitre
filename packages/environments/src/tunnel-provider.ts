import { readFileSync } from "node:fs";
import { isAbsolute, join } from "node:path";
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
export function providerSettings(home: string, managed = false, provider?: string) {
  if (provider && !/^saas:[A-Za-z0-9_-]{1,128}$/.test(provider)) fail("Invalid SaaS provider ID");
  const file = provider
    ? join("saas", "providers", `${provider.slice(5)}.json`)
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
  return { name, ...cfg };
}
