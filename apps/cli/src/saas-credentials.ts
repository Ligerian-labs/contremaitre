import { createHash } from "node:crypto";
import { chmodSync, lstatSync, mkdirSync, readFileSync, type Stats } from "node:fs";
import { join } from "node:path";
import { context, fail, HubError } from "@contremaitre/execution/context";
import { atomicWrite } from "@contremaitre/execution/files";
import { run } from "@contremaitre/execution/process";
import { Schema } from "effect";
import { read } from "./saas-client.js";

export const credentialSchema = Schema.Struct({
  device_id: Schema.NonEmptyString,
  credential: Schema.NonEmptyString,
});
export type Credential = typeof credentialSchema.Type;
export interface Credentials {
  get(account: string, signal: AbortSignal): Promise<Credential | undefined>;
  set(account: string, value: Credential, signal: AbortSignal): Promise<void>;
}
/** `<endpoint origin>#<workspace>`; the origin may carry an explicit port. */
export const isCredentialAccount = (account: string) =>
  /^https:\/\/[a-z0-9.-]+(?::\d{1,5})?#[A-Za-z0-9_-]{1,128}$/.test(account);
export function keychain(): Credentials {
  const command = async (args: string[], signal: AbortSignal, stdin?: Buffer) => {
    if (process.platform !== "darwin") fail("SaaS login currently requires macOS Keychain");
    return run(context(signal), ["/usr/bin/security", ...args], {
      stdin,
      timeout: 15_000,
      maxOutput: 65536,
      strictOutput: true,
      stderr: () => {},
    });
  };
  const store: Credentials = {
    async get(account, signal) {
      let value: Buffer;
      try {
        value = await command(
          ["find-generic-password", "-s", "contremaitre-tunnel", "-a", account, "-w"],
          signal,
        );
      } catch (e) {
        signal.throwIfAborted();
        if (e instanceof HubError && e.exitCode === 44) return undefined;
        return fail(
          "Cannot read SaaS credentials from Keychain; unlock your login keychain and retry",
        );
      }
      try {
        return read(
          credentialSchema,
          JSON.parse(Buffer.from(value.toString().trim(), "base64").toString("utf8")),
        );
      } catch {
        return fail("Invalid SaaS credential in Keychain; run contremaitre tunnel login");
      }
    },
    async set(account, value, signal) {
      if (!isCredentialAccount(account)) fail("Invalid credential account");
      const encoded = Buffer.from(JSON.stringify(value)).toString("base64");
      try {
        // Use stdin so neither process arguments nor process journals contain the secret.
        await command(
          ["-i"],
          signal,
          Buffer.from(
            `add-generic-password -U -s contremaitre-tunnel -a "${account}" -w "${encoded}"\n`,
          ),
        );
        const saved = await store.get(account, signal);
        if (saved?.credential !== value.credential || saved.device_id !== value.device_id)
          throw Error();
      } catch {
        signal.throwIfAborted();
        fail("Cannot save SaaS credentials in Keychain; unlock your login keychain and retry");
      }
    },
  };
  return store;
}

const storedSchema = Schema.Struct({
  version: Schema.Literal(1),
  account: Schema.String,
  device_id: Schema.NonEmptyString,
  credential: Schema.NonEmptyString,
});
export interface FileCredentialOptions {
  /** Writes one credential file; the store sets its mode afterwards. */
  write?: (path: string, data: string) => void;
  /** The effective user that must own the directory and files. */
  uid?: () => number | undefined;
}
/**
 * Off macOS there is no login keychain on a headless server, so credentials
 * live in private files: one per account, named by its hash, in a 0700
 * directory. Anything shared, redirected or unreadable fails closed; this
 * protects against other users, not against the owner or root.
 */
export function fileCredentials(
  directory: string,
  options: FileCredentialOptions = {},
): Credentials {
  const write = options.write ?? ((path: string, data: string) => atomicWrite(path, data, 0o600));
  const uid = options.uid ?? (() => process.getuid?.());
  const owned = (info: Stats) => {
    const expected = uid();
    return expected === undefined || info.uid === expected;
  };
  const insecureDirectory = () =>
    fail(
      `SaaS credential directory ${directory} must be a private directory (mode 0700) you own; fix its permissions or remove it, then run contremaitre tunnel login`,
    );
  const checkDirectory = (create: boolean) => {
    let info: Stats;
    try {
      info = lstatSync(directory);
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code !== "ENOENT") return insecureDirectory();
      if (!create) return false;
      mkdirSync(directory, { recursive: true, mode: 0o700 });
      // The umask may have taken owner bits too; the store's modes are exact.
      chmodSync(directory, 0o700);
      info = lstatSync(directory);
    }
    if (!info.isDirectory() || (info.mode & 0o777) !== 0o700 || !owned(info)) insecureDirectory();
    return true;
  };
  const path = (account: string) =>
    join(directory, `${createHash("sha256").update(account).digest("hex")}.json`);
  const store: Credentials = {
    async get(account) {
      if (!checkDirectory(false)) return undefined;
      const file = path(account);
      let info: Stats;
      try {
        info = lstatSync(file);
      } catch (e) {
        if ((e as NodeJS.ErrnoException).code === "ENOENT") return undefined;
        return fail(`Cannot read SaaS credentials from ${file}`);
      }
      if (!info.isFile() || (info.mode & 0o777) !== 0o600 || !owned(info))
        fail(
          `SaaS credential file ${file} must be a private file (mode 0600) you own; remove it and run contremaitre tunnel login`,
        );
      let stored: typeof storedSchema.Type;
      try {
        stored = read(storedSchema, JSON.parse(readFileSync(file, "utf8")));
      } catch {
        return fail(
          `Invalid SaaS credential in ${file}; remove it and run contremaitre tunnel login`,
        );
      }
      if (stored.account !== account)
        fail(`Invalid SaaS credential in ${file}; remove it and run contremaitre tunnel login`);
      return { device_id: stored.device_id, credential: stored.credential };
    },
    async set(account, value, signal) {
      if (!isCredentialAccount(account)) fail("Invalid credential account");
      checkDirectory(true);
      // An existing entry passes the same checks as a read before it is
      // replaced: shared, redirected, corrupt or foreign state is refused.
      await store.get(account, signal);
      const file = path(account);
      try {
        write(file, JSON.stringify({ version: 1, account, ...read(credentialSchema, value) }));
        chmodSync(file, 0o600);
      } catch {
        fail(`Cannot save SaaS credentials in ${file}`);
      }
      const saved = await store.get(account, signal);
      if (saved?.credential !== value.credential || saved.device_id !== value.device_id)
        fail(`Cannot save SaaS credentials in ${file}`);
    },
  };
  return store;
}
/** Keychain on macOS; private files under the hub home elsewhere. */
export function credentialStore(home: string, platform: NodeJS.Platform = process.platform) {
  return platform === "darwin" ? keychain() : fileCredentials(join(home, "saas-credentials"));
}
