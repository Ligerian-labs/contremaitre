import { afterEach, expect, test } from "bun:test";
import {
  chmodSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { browserCommand } from "../apps/cli/src/saas.js";
import { credentialStore, fileCredentials } from "../apps/cli/src/saas-credentials.js";

const homes: string[] = [];
afterEach(() => {
  for (const home of homes.splice(0)) rmSync(home, { recursive: true, force: true });
});
function scratch() {
  const home = mkdtempSync(join(tmpdir(), "contremaitre-saas-"));
  homes.push(home);
  return home;
}
const signal = new AbortController().signal;
const account = "https://contremaitre.ligerianlabs.fr#team-a";
const value = { device_id: "device-1", credential: "secret-1" };
const mode = (path: string) => lstatSync(path).mode & 0o777;
const only = (dir: string) => {
  const files = readdirSync(dir);
  expect(files).toHaveLength(1);
  return join(dir, files[0] as string);
};

test("the file store saves a credential privately and reads it back", async () => {
  const dir = join(scratch(), "saas-credentials");
  const store = fileCredentials(dir);
  expect(await store.get(account, signal)).toBeUndefined();
  await store.set(account, value, signal);
  expect(await store.get(account, signal)).toEqual(value);
  expect(mode(dir)).toBe(0o700);
  const file = only(dir);
  expect(mode(file)).toBe(0o600);
  // The file name carries no endpoint or workspace text; the content names its account.
  expect(file).not.toContain("team-a");
  expect(JSON.parse(readFileSync(file, "utf8"))).toMatchObject({ account, ...value });
  await store.set(account, { device_id: "device-2", credential: "secret-2" }, signal);
  expect(await store.get(account, signal)).toEqual({
    device_id: "device-2",
    credential: "secret-2",
  });
  expect(readdirSync(dir)).toHaveLength(1);
  // Each endpoint and workspace has its own entry.
  const other = "https://tunnels.example.com:8443#team-b";
  expect(await store.get(other, signal)).toBeUndefined();
  await store.set(other, value, signal);
  expect(readdirSync(dir)).toHaveLength(2);
  expect(await store.get(account, signal)).toEqual({
    device_id: "device-2",
    credential: "secret-2",
  });
});

test("the file store refuses an invalid account before writing", async () => {
  const dir = join(scratch(), "saas-credentials");
  await expect(fileCredentials(dir).set("not-an-account", value, signal)).rejects.toThrow(
    "Invalid credential account",
  );
  expect(() => readdirSync(dir)).toThrow();
});

test("the file store fails closed on shared or redirected state", async () => {
  const home = scratch();
  const dir = join(home, "saas-credentials");
  const store = fileCredentials(dir);
  await store.set(account, value, signal);
  const file = only(dir);

  chmodSync(file, 0o644);
  await expect(store.get(account, signal)).rejects.toThrow("must be a private file");
  chmodSync(file, 0o600);

  chmodSync(dir, 0o755);
  await expect(store.get(account, signal)).rejects.toThrow("must be a private directory");
  await expect(store.set(account, value, signal)).rejects.toThrow("must be a private directory");
  chmodSync(dir, 0o700);

  const elsewhere = join(home, "elsewhere.json");
  writeFileSync(elsewhere, readFileSync(file), { mode: 0o600 });
  rmSync(file);
  symlinkSync(elsewhere, file);
  await expect(store.get(account, signal)).rejects.toThrow("must be a private file");
  rmSync(file);

  const real = join(home, "real-dir");
  mkdirSync(real, { mode: 0o700 });
  const linked = join(home, "linked-credentials");
  symlinkSync(real, linked);
  await expect(fileCredentials(linked).get(account, signal)).rejects.toThrow(
    "must be a private directory",
  );
  await expect(fileCredentials(linked).set(account, value, signal)).rejects.toThrow(
    "must be a private directory",
  );
  expect(readdirSync(real)).toHaveLength(0);
});

test("the file store rejects corrupt data and a credential copied from another account", async () => {
  const dir = join(scratch(), "saas-credentials");
  const store = fileCredentials(dir);
  await store.set(account, value, signal);
  const file = only(dir);
  writeFileSync(file, "{not json", { mode: 0o600 });
  await expect(store.get(account, signal)).rejects.toThrow("Invalid SaaS credential");
  writeFileSync(file, JSON.stringify({ version: 1, account, device_id: "", credential: "x" }), {
    mode: 0o600,
  });
  await expect(store.get(account, signal)).rejects.toThrow("Invalid SaaS credential");
  const other = "https://tunnels.example.com#team-b";
  writeFileSync(file, JSON.stringify({ version: 1, account: other, ...value }), { mode: 0o600 });
  await expect(store.get(account, signal)).rejects.toThrow("Invalid SaaS credential");
});

test("macOS keeps Keychain; Linux uses the private file store under the hub home", async () => {
  const home = scratch();
  // Off macOS the Keychain store reaches no `security` binary and says so;
  // on macOS this case would touch the real login keychain, so it stays off.
  if (process.platform !== "darwin")
    await expect(credentialStore(home, "darwin").get(account, signal)).rejects.toThrow(
      "from Keychain",
    );
  const linux = credentialStore(home, "linux");
  await linux.set(account, value, signal);
  expect(await linux.get(account, signal)).toEqual(value);
  expect(mode(join(home, "saas-credentials"))).toBe(0o700);
}, 20_000);

test("the browser opener follows the platform and a Linux graphical session", () => {
  const url = "https://contremaitre.ligerianlabs.fr/device?user_code=ABCD-1234";
  const found = (name: string) => (name === "xdg-open" ? "/usr/bin/xdg-open" : null);
  const missing = () => null;
  expect(browserCommand(url, "darwin", {}, missing)).toEqual(["/usr/bin/open", url]);
  expect(browserCommand(url, "linux", { DISPLAY: ":0" }, found)).toEqual([
    "/usr/bin/xdg-open",
    url,
  ]);
  expect(browserCommand(url, "linux", { WAYLAND_DISPLAY: "wayland-0" }, found)).toEqual([
    "/usr/bin/xdg-open",
    url,
  ]);
  // A headless server prints the URL and code; the user approves on another device.
  expect(browserCommand(url, "linux", {}, found)).toBeUndefined();
  expect(browserCommand(url, "linux", { DISPLAY: "" }, found)).toBeUndefined();
  expect(browserCommand(url, "linux", { DISPLAY: ":0" }, missing)).toBeUndefined();
});
