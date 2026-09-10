import { createHash } from "node:crypto";
import { readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { saasEndpoint } from "@contremaitre/environments/tunnel-provider";
import { fail } from "@contremaitre/execution/context";
import { atomicWrite } from "@contremaitre/execution/files";
import { Schema } from "effect";
import { api, bytes, type Fetch, read, sameOrigin } from "./saas-client.js";

const artifact = Schema.Struct({
  url: Schema.String,
  sha256: Schema.String.pipe(Schema.pattern(/^[a-f0-9]{64}$/)),
});
const manifestSchema = Schema.Struct({
  version: Schema.Literal(1),
  protocol: Schema.Literal(2),
  credential_accounts: Schema.Literal(true),
  platform: Schema.Literal("darwin-arm64"),
  artifacts: Schema.Struct({
    provider: artifact,
    transport: artifact,
    frpc: artifact,
    ca: artifact,
  }),
});
const sha = (value: Uint8Array) => createHash("sha256").update(value).digest("hex");
export async function installProvider(home: string, signal: AbortSignal, fetcher: Fetch = fetch) {
  if (process.platform !== "darwin" || process.arch !== "arm64")
    fail("The SaaS tunnel provider currently supports macOS on Apple Silicon");
  const cache = join(home, "saas", "manifest.json");
  let manifest: typeof manifestSchema.Type | undefined;
  try {
    manifest = read(manifestSchema, JSON.parse(readFileSync(cache, "utf8")));
  } catch {
    // The cache is reconstructible; never execute an unverified cached artifact.
  }
  if (!manifest) {
    manifest = read(
      manifestSchema,
      await api(signal, fetcher)("/.well-known/contremaitre-provider/darwin-arm64.json"),
    );
  }
  const paths = {} as Record<keyof typeof manifest.artifacts, string>;
  for (const [name, spec] of Object.entries(manifest.artifacts)) {
    const url = sameOrigin(spec.url);
    const path = join(home, "saas", spec.sha256, name);
    const mode = name === "ca" ? 0o600 : 0o700;
    let valid = false;
    try {
      const info = statSync(path);
      valid =
        info.isFile() &&
        info.size <= 128 * 1048576 &&
        (info.mode & 0o777) === mode &&
        sha(readFileSync(path)) === spec.sha256;
    } catch {}
    if (!valid) {
      let data: Buffer;
      try {
        const response = await fetcher(url, {
          redirect: "error",
          signal: AbortSignal.any([signal, AbortSignal.timeout(120_000)]),
        });
        if (!response.ok) {
          await response.body?.cancel();
          throw Error();
        }
        data = await bytes(response, 128 * 1048576);
      } catch {
        signal.throwIfAborted();
        return fail(`Cannot install the SaaS tunnel provider from ${saasEndpoint}; retry later`);
      }
      if (sha(data) !== spec.sha256) fail("SaaS provider download checksum mismatch");
      atomicWrite(path, data, mode);
    }
    paths[name as keyof typeof paths] = path;
  }
  atomicWrite(cache, JSON.stringify(manifest));
  return {
    executable: paths.provider,
    transport: paths.transport,
    frpc: paths.frpc,
    ca_file: paths.ca,
  };
}
