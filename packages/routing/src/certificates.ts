import { X509Certificate } from "node:crypto";
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  renameSync,
  rmSync,
} from "node:fs";
import { join } from "node:path";
import { createSecureContext } from "node:tls";
import { type Context, fail, hash } from "@contremaitre/execution/context";
import { run } from "@contremaitre/execution/process";

// The hub requests certificates only for its recorded local service hostnames.
export async function localCertificates(ctx: Context, home: string) {
  if (!Bun.which("mkcert"))
    fail("Local HTTPS requires mkcert. Run brew install mkcert, then mkcert -install.");
  const root = (await run(ctx, ["mkcert", "-CAROOT"], { timeout: 5000 })).toString().trim();
  if (!existsSync(join(root, "rootCA.pem")))
    fail("Local HTTPS requires a local CA. Run mkcert -install first.");
  const ca = new X509Certificate(readFileSync(join(root, "rootCA.pem")));
  const directory = join(home, "certificates");
  mkdirSync(directory, { recursive: true, mode: 0o700 });
  chmodSync(directory, 0o700);
  const pending = new Map<string, Promise<{ keyFile: string; certFile: string }>>();
  async function issue(host: string) {
    if (host !== "localhost" && !/^(?:[a-z0-9][a-z0-9-]*\.)+localhost$/.test(host))
      fail("Invalid local certificate hostname");
    const name = hash(host),
      keyFile = join(directory, `${name}-key.pem`),
      certFile = join(directory, `${name}.pem`);
    try {
      const cert = readFileSync(certFile),
        key = readFileSync(keyFile),
        parsed = new X509Certificate(cert);
      if (
        parsed.checkHost(host) &&
        parsed.verify(ca.publicKey) &&
        Date.parse(parsed.validTo) > Date.now() + 30 * 86400000
      ) {
        createSecureContext({ key, cert });
        return { keyFile, certFile };
      }
    } catch {}
    const temp = mkdtempSync(join(directory, ".issue-"));
    try {
      const keyPath = join(temp, "key.pem"),
        certPath = join(temp, "cert.pem");
      await run(ctx, ["mkcert", "-cert-file", certPath, "-key-file", keyPath, host], {
        timeout: 15000,
      });
      chmodSync(keyPath, 0o600);
      renameSync(keyPath, keyFile);
      renameSync(certPath, certFile);
      return { keyFile, certFile };
    } finally {
      rmSync(temp, { recursive: true, force: true });
    }
  }
  function certificate(host: string) {
    const active = pending.get(host);
    if (active) return active;
    const result = issue(host).finally(() => pending.delete(host));
    pending.set(host, result);
    return result;
  }
  const initial = await certificate("localhost");
  return {
    ...initial,
    certificate,
  };
}
