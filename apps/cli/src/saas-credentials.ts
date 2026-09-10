import { context, fail, HubError } from "@contremaitre/execution/context";
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
      if (!/^https:\/\/[a-z0-9.-]+#[A-Za-z0-9_-]+$/.test(account))
        fail("Invalid credential account");
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
