import { afterEach, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { type OnboardingDependencies, onboard } from "@contremaitre/cli/saas";
import { installProvider } from "@contremaitre/cli/saas-install";
import {
  managedEndpoint,
  managedProvider,
  providerConfig,
  saasEndpoint,
} from "@contremaitre/environments/tunnel-provider";
import { withTrust } from "../apps/cli/src/saas-client.js";
import { isCredentialAccount } from "../apps/cli/src/saas-credentials.js";

const directories: string[] = [];
afterEach(() => {
  for (const directory of directories.splice(0))
    rmSync(directory, { recursive: true, force: true });
});
function fixture(endpoint = saasEndpoint) {
  let origin = endpoint;
  const trusted: (string | undefined)[] = [];
  const installs: string[] = [];
  const home = mkdtempSync(join(tmpdir(), "cm-saas-"));
  directories.push(home);
  const events: string[] = [];
  const credentials = new Map<string, { device_id: string; credential: string }>();
  let now = 1000;
  let workspace = "team-b";
  let tokenResponses: unknown[] = [{ access_token: "enrollment-secret" }];
  let sessionStatus = 200;
  let canShare = true;
  const workspaces = [
    { id: "team-a", name: "Personal" },
    { id: "team-b", name: "Team" },
  ];
  const deps: OnboardingDependencies = {
    now: () => now,
    sleep: async (ms) => {
      now += ms;
      events.push(`wait:${ms}`);
    },
    ui: {
      interactive: true,
      note: (text) => {
        events.push(`note:${text}`);
      },
      open: async (url) => {
        events.push(`open:${url}`);
      },
      choose: async () => {
        events.push("choose");
        return workspace;
      },
    },
    credentials: {
      get: async (key) => credentials.get(key),
      set: async (key, value) => {
        events.push("save");
        credentials.set(key, value);
      },
    },
    fetcher: async (url, init) => {
      expect(new URL(url).origin).toBe(origin);
      trusted.push(init.tls?.ca as string | undefined);
      expect(init.redirect).toBe("error");
      const path = new URL(url).pathname;
      events.push(path);
      switch (path) {
        case "/oauth/device/code":
          expect(String(init.body)).toContain("device_name=");
          return Response.json({
            device_code: "device-secret",
            user_code: "ABCD-EFGH",
            verification_uri: `${origin}/device`,
            expires_in: 600,
            interval: 5,
          });
        case "/oauth/device/token":
          return Response.json(tokenResponses.shift() ?? { error: "authorization_pending" });
        case "/v1/cli/workspaces":
          expect((init.headers as Record<string, string>).authorization).toBe(
            "Bearer enrollment-secret",
          );
          return Response.json({ account_id: "user-a", workspaces });
        case "/v1/devices/enroll":
          workspace = JSON.parse(String(init.body)).tenant_id;
          return Response.json({
            device_id: "device-id",
            credential: `secret-${workspace}`,
            workspace_id: workspace,
            account_id: "user-a",
          });
        case "/v1/cli/access":
          expect((init.headers as Record<string, string>).authorization).toBe(
            `Bearer secret-${workspace}`,
          );
          return Response.json({
            workspace_id: workspace,
            can_share: canShare,
            reason: canShare ? null : "subscription_required",
            subscription_url: `${origin}/billing?workspace=${workspace}`,
          });
        case "/v1/cli/session":
          return Response.json(
            { account_id: "user-a", workspace_id: workspace, workspaces },
            { status: sessionStatus },
          );
        default:
          throw Error(`Unexpected path ${path}`);
      }
    },
    install: async (_home, _signal, _fetcher, endpoint = saasEndpoint) => {
      events.push("install");
      installs.push(endpoint);
      return {
        executable: "/managed/provider",
        transport: "/managed/transport",
        frpc: "/managed/frpc",
        ca_file: "/managed/ca",
      };
    },
  };
  return {
    home,
    deps,
    events,
    credentials,
    tokens: (values: unknown[]) => {
      tokenResponses = values;
    },
    access: (value: boolean) => {
      canShare = value;
    },
    status: (value: number) => {
      sessionStatus = value;
    },
    workspace: (value: string) => {
      workspace = value;
    },
    endpoint: (value: string) => {
      origin = value;
    },
    trusted,
    installs,
  };
}
const signal = () => new AbortController().signal;

test("first tunnel logs in, asks for workspace, enrolls and installs automatically; next tunnel reuses auth", async () => {
  const f = fixture();
  expect(await onboard(f.home, signal(), {}, f.deps)).toBe("saas:team-b");
  expect(f.events.indexOf("choose")).toBeLessThan(f.events.indexOf("/v1/devices/enroll"));
  expect(f.events.indexOf("save")).toBeLessThan(f.events.indexOf("install"));
  const config = providerConfig(f.home);
  expect(config?.config).toMatchObject({
    endpoint: saasEndpoint,
    tenant_id: "team-b",
    credential_account: `${saasEndpoint}#team-b`,
    foreground_sessions: true,
  });
  expect(readFileSync(join(f.home, "saas-provider.json"), "utf8")).not.toContain("secret");
  expect(statSync(join(f.home, "saas-login.json")).mode & 0o777).toBe(0o600);
  expect(f.events.join("\n")).not.toContain("enrollment-secret");
  f.events.length = 0;
  f.deps.ui.interactive = false;
  await onboard(f.home, signal(), {}, f.deps);
  expect(f.events).toEqual(["/v1/cli/session", "/v1/cli/access", "install"]);
});

test("explicit workspace overrides saved choice; existing URLs stay pinned to their workspace", async () => {
  const f = fixture();
  await onboard(f.home, signal(), { workspace: "team-a" }, f.deps);
  expect(f.events).not.toContain("choose");
  f.tokens([{ access_token: "enrollment-secret" }]);
  await onboard(f.home, signal(), { workspace: "team-b" }, f.deps);
  expect(providerConfig(f.home)?.name).toBe("saas:team-b");
  expect(providerConfig(f.home, "saas:team-a")?.name).toBe("saas:team-a");
  f.workspace("team-a");
  f.events.length = 0;
  await onboard(f.home, signal(), { providers: ["saas:team-a"] }, f.deps);
  expect(f.events).toEqual(["/v1/cli/session", "/v1/cli/access", "install"]);
  await expect(
    onboard(f.home, signal(), { workspace: "team-b", providers: ["saas:team-a"] }, f.deps),
  ).rejects.toThrow("release those reservations");
});

test("missing or revoked auth requires a terminal; custom configuration never falls back", async () => {
  const f = fixture();
  f.deps.ui.interactive = false;
  await expect(onboard(f.home, signal(), {}, f.deps)).rejects.toThrow("tunnel login");
  expect(f.events).toEqual([]);
  writeFileSync(
    join(f.home, "tunnels.json"),
    JSON.stringify({
      default: "custom",
      providers: { custom: { executable: "/custom/provider" } },
    }),
  );
  expect(await onboard(f.home, signal(), {}, f.deps)).toBe("custom");
  expect(f.events).toEqual([]);
  writeFileSync(join(f.home, "tunnels.json"), '{"password":"should-not-leak"');
  await expect(onboard(f.home, signal(), {}, f.deps)).rejects.toThrow("Invalid tunnels.json");
  expect(f.events).toEqual([]);
  writeFileSync(join(f.home, "tunnels.json"), JSON.stringify({ default: "gone", providers: {} }));
  await expect(onboard(f.home, signal(), {}, f.deps)).rejects.toThrow("absolute executable path");
});

test("expired/revoked credentials trigger fresh approval only at startup, outages do not trigger login", async () => {
  const f = fixture();
  await onboard(f.home, signal(), {}, f.deps);
  f.events.length = 0;
  f.status(503);
  await expect(onboard(f.home, signal(), {}, f.deps)).rejects.toThrow("HTTP 503");
  expect(f.events).toEqual(["/v1/cli/session"]);
  f.status(401);
  f.deps.ui.interactive = false;
  await expect(onboard(f.home, signal(), {}, f.deps)).rejects.toThrow("tunnel login");
  f.deps.ui.interactive = true;
  f.tokens([{ access_token: "enrollment-secret" }]);
  await onboard(f.home, signal(), {}, f.deps);
  expect(f.events).toContain("/oauth/device/code");
  expect(f.events).not.toContain("choose");
});

test("browser failure leaves manual URL/code; pending, slowdown, denial and expiry stay bounded", async () => {
  const f = fixture();
  f.deps.ui.open = async () => {
    throw Error("No browser");
  };
  f.tokens([
    { error: "authorization_pending" },
    { error: "slow_down" },
    { access_token: "enrollment-secret" },
  ]);
  await onboard(f.home, signal(), {}, f.deps);
  expect(f.events).toContain(`note:Open ${saasEndpoint}/device and enter ABCD-EFGH`);
  expect(f.events.filter((e) => e.startsWith("wait:"))).toEqual([
    "wait:5000",
    "wait:5000",
    "wait:10000",
  ]);
  f.tokens([{ error: "access_denied" }]);
  await expect(onboard(f.home, signal(), { login: true }, f.deps)).rejects.toThrow("denied");
  f.tokens([]);
  f.events.length = 0;
  await expect(onboard(f.home, signal(), { login: true }, f.deps)).rejects.toThrow("expired");
  expect(f.events.filter((e) => e === "/oauth/device/token").length).toBeLessThan(120);
});

test("login alone saves selection without needing a provider installation", async () => {
  const f = fixture();
  await onboard(f.home, signal(), { login: true }, f.deps);
  expect(f.events).not.toContain("install");
  expect(existsSync(join(f.home, "saas-provider.json"))).toBe(false);
  f.events.length = 0;
  await onboard(f.home, signal(), {}, f.deps);
  expect(f.events).toEqual(["/v1/cli/session", "/v1/cli/access", "install"]);
});

test("a failed install preserves login and retries without browser approval", async () => {
  const f = fixture();
  const install = f.deps.install;
  f.deps.install = async () => {
    throw Error("download interrupted");
  };
  await expect(onboard(f.home, signal(), {}, f.deps)).rejects.toThrow("download interrupted");
  expect(existsSync(join(f.home, "saas-provider.json"))).toBe(false);
  f.deps.install = install;
  f.deps.ui.interactive = false;
  f.events.length = 0;
  await onboard(f.home, signal(), {}, f.deps);
  expect(f.events).toEqual(["/v1/cli/session", "/v1/cli/access", "install"]);
});

test("enrollment cannot substitute an account or workspace and inaccessible choices fail", async () => {
  const f = fixture();
  await expect(onboard(f.home, signal(), { workspace: "missing" }, f.deps)).rejects.toThrow(
    "unavailable",
  );
  expect(f.events).not.toContain("/v1/devices/enroll");
  const fetcher = f.deps.fetcher;
  f.tokens([{ access_token: "enrollment-secret", token_type: "Bearer", expires_in: 120 }]);
  f.deps.fetcher = async (url, init) =>
    url.endsWith("/v1/devices/enroll")
      ? Response.json({
          account_id: "other-account",
          workspace_id: "team-b",
          device_id: "device",
          credential: "secret",
        })
      : fetcher(url, init);
  await expect(onboard(f.home, signal(), {}, f.deps)).rejects.toThrow("does not match");
  expect(f.credentials.size).toBe(0);
  expect(f.events).not.toContain("install");
});

test("cancellation and untrusted browser URLs cannot enroll or install", async () => {
  const f = fixture();
  const controller = new AbortController();
  f.deps.sleep = async () => {
    controller.abort(Error("cancelled"));
    controller.signal.throwIfAborted();
  };
  await expect(onboard(f.home, controller.signal, {}, f.deps)).rejects.toThrow("cancelled");
  expect(f.events).not.toContain("save");
  expect(f.events).not.toContain("install");
  f.deps.fetcher = async () =>
    Response.json({
      device_code: "secret",
      user_code: "ABCD-EFGH",
      verification_uri: "https://evil.example/device",
      interval: 5,
      expires_in: 600,
    });
  await expect(onboard(f.home, signal(), {}, f.deps)).rejects.toThrow("configured HTTPS origin");
});

test("provider bootstrap verifies artifacts, uses a cache, repairs corruption and rejects origin/checksum changes", async () => {
  const f = fixture();
  const digest = (value: string) => createHash("sha256").update(value).digest("hex");
  const artifacts = Object.fromEntries(
    ["provider", "transport", "frpc", "ca"].map((name) => [
      name,
      { url: `/downloads/${name}`, sha256: digest(name) },
    ]),
  );
  const manifest = {
    version: 1,
    protocol: 2,
    credential_accounts: true,
    platform: "darwin-arm64",
    artifacts,
  };
  const downloads: string[] = [];
  const fetcher: OnboardingDependencies["fetcher"] = async (url, init) => {
    expect(init.redirect).toBe("error");
    downloads.push(url);
    return url.includes(".well-known")
      ? Response.json(manifest)
      : new Response(url.split("/").at(-1));
  };
  const installed = await installProvider(f.home, signal(), fetcher);
  expect(downloads).toHaveLength(5);
  expect(statSync(installed.executable).mode & 0o777).toBe(0o700);
  downloads.length = 0;
  await installProvider(f.home, signal(), fetcher);
  expect(downloads).toEqual([]);
  writeFileSync(installed.executable, "corrupted");
  await installProvider(f.home, signal(), fetcher);
  expect(downloads).toEqual([`${saasEndpoint}/downloads/provider`]);
  rmSync(join(f.home, "saas"), { recursive: true });
  artifacts.provider.url = "https://untrusted.example/provider";
  await expect(installProvider(f.home, signal(), fetcher)).rejects.toThrow(
    "configured HTTPS origin",
  );
  artifacts.provider.url = "/downloads/provider";
  artifacts.provider.sha256 = "0".repeat(64);
  await expect(installProvider(f.home, signal(), fetcher)).rejects.toThrow("checksum mismatch");
  expect(existsSync(join(f.home, "saas", "manifest.json"))).toBe(false);
});

test("device link carries the displayed user code without the polling secret", async () => {
  const f = fixture();
  await onboard(f.home, signal(), { login: true }, f.deps);
  expect(f.events).toContain(`open:${saasEndpoint}/device?user_code=ABCD-EFGH`);
  expect(f.events.filter((e) => e.startsWith("open:")).join("\n")).not.toContain("device-secret");
});

test("unpaid workspaces keep login but stop before provider installation and open scoped billing", async () => {
  const f = fixture();
  f.access(false);
  await expect(onboard(f.home, signal(), {}, f.deps)).rejects.toThrow("active subscription");
  expect(f.events).toContain(`open:${saasEndpoint}/billing?workspace=team-b`);
  expect(f.events).not.toContain("install");
  expect(existsSync(join(f.home, "saas-provider.json"))).toBe(false);
  expect(f.credentials.size).toBe(1);
  f.events.length = 0;
  f.deps.ui.interactive = false;
  await expect(onboard(f.home, signal(), {}, f.deps)).rejects.toThrow(
    `${saasEndpoint}/billing?workspace=team-b`,
  );
  expect(f.events.some((e) => e.startsWith("open:"))).toBe(false);
  expect(f.events).not.toContain("/oauth/device/code");
  f.access(true);
  await onboard(f.home, signal(), {}, f.deps);
  expect(f.events).toContain("install");
  expect(f.events).not.toContain("/oauth/device/code");
});

test("billing browser failure keeps the actionable subscription error", async () => {
  const f = fixture();
  await onboard(f.home, signal(), { login: true }, f.deps);
  f.access(false);
  f.deps.ui.open = async () => {
    throw Error("No browser");
  };
  await expect(onboard(f.home, signal(), {}, f.deps)).rejects.toThrow("/billing?workspace=team-b");
  expect(f.events).not.toContain("install");
});

test("invalid access responses fail before installation or opening billing", async () => {
  for (const response of [
    {
      workspace_id: "other",
      can_share: false,
      reason: "subscription_required",
      subscription_url: `${saasEndpoint}/billing?workspace=other`,
    },
    {
      workspace_id: "team-b",
      can_share: false,
      reason: "subscription_required",
      subscription_url: "https://evil.example/billing",
    },
    { workspace_id: "team-b", can_share: true },
  ]) {
    const f = fixture();
    await onboard(f.home, signal(), { login: true }, f.deps);
    f.events.length = 0;
    const fetcher = f.deps.fetcher;
    f.deps.fetcher = async (url, init) =>
      url.endsWith("/v1/cli/access") ? Response.json(response) : fetcher(url, init);
    await expect(onboard(f.home, signal(), {}, f.deps)).rejects.toThrow();
    expect(f.events).not.toContain("install");
    expect(f.events.some((e) => e.startsWith("open:"))).toBe(false);
  }
});

test("access outages and authorization loss never open billing or restart device login", async () => {
  for (const status of [401, 403, 503]) {
    const f = fixture();
    await onboard(f.home, signal(), { login: true }, f.deps);
    f.events.length = 0;
    const fetcher = f.deps.fetcher;
    f.deps.fetcher = async (url, init) =>
      url.endsWith("/v1/cli/access") ? Response.json({}, { status }) : fetcher(url, init);
    await expect(onboard(f.home, signal(), {}, f.deps)).rejects.toThrow();
    expect(f.events).not.toContain("install");
    expect(f.events).not.toContain("/oauth/device/code");
    expect(f.events.some((e) => e.startsWith("open:"))).toBe(false);
    expect(f.credentials.size).toBe(1);
  }
});

test("complete verification links stay on the authorization origin and path", async () => {
  for (const complete of [
    `${saasEndpoint}/device?user_code=ABCD-EFGH`,
    "https://evil.example/device?user_code=ABCD-EFGH",
    `${saasEndpoint}/elsewhere?user_code=ABCD-EFGH`,
  ]) {
    const f = fixture();
    const fetcher = f.deps.fetcher;
    f.deps.fetcher = async (url, init) => {
      const response = await fetcher(url, init);
      return url.endsWith("/oauth/device/code")
        ? Response.json({ ...(await response.json()), verification_uri_complete: complete })
        : response;
    };
    if (complete.startsWith(`${saasEndpoint}/device?`)) {
      await onboard(f.home, signal(), { login: true }, f.deps);
      expect(f.events).toContain(`open:${complete}`);
    } else {
      await expect(onboard(f.home, signal(), { login: true }, f.deps)).rejects.toThrow();
      expect(f.events.some((e) => e.startsWith("open:"))).toBe(false);
      expect(f.credentials.size).toBe(0);
    }
  }
});

const custom = "https://localhost:8443";
const customDirectory = (home: string) => join(home, "saas", "endpoints", "localhost_8443");

test("the default endpoint keeps its provider ID, files, Keychain account and saved state", async () => {
  const f = fixture();
  expect(await onboard(f.home, signal(), {}, f.deps)).toBe("saas:team-b");
  expect(JSON.parse(readFileSync(join(f.home, "saas-login.json"), "utf8"))).toEqual({
    workspace_id: "team-b",
  });
  expect([...f.credentials.keys()]).toEqual([`${saasEndpoint}#team-b`]);
  const descriptor = JSON.parse(
    readFileSync(join(f.home, "saas", "providers", "team-b.json"), "utf8"),
  );
  expect(descriptor.providers["saas:team-b"].config.state_directory).toBe(
    join(f.home, "saas", "state", "team-b"),
  );
  expect(existsSync(join(f.home, "saas", "endpoints"))).toBe(false);
  expect(f.installs).toEqual([saasEndpoint]);
  expect(f.trusted.every((ca) => ca === undefined)).toBe(true);

  // State written by the previous CLI, which had no endpoint field anywhere, still works.
  const legacy = fixture();
  const config = {
    endpoint: saasEndpoint,
    tenant_id: "team-a",
    credential_account: `${saasEndpoint}#team-a`,
    foreground_sessions: true,
    state_directory: join(legacy.home, "saas", "state", "team-a"),
  };
  const settings = JSON.stringify({
    default: "saas:team-a",
    providers: { "saas:team-a": { executable: "/managed/provider", config } },
  });
  mkdirSync(join(legacy.home, "saas", "providers"), { recursive: true });
  writeFileSync(join(legacy.home, "saas", "providers", "team-a.json"), settings);
  writeFileSync(join(legacy.home, "saas-provider.json"), settings);
  writeFileSync(join(legacy.home, "saas-login.json"), JSON.stringify({ workspace_id: "team-a" }));
  legacy.credentials.set(`${saasEndpoint}#team-a`, { device_id: "d", credential: "secret-team-a" });
  legacy.workspace("team-a");
  legacy.deps.ui.interactive = false;
  expect(await onboard(legacy.home, signal(), { providers: ["saas:team-a"] }, legacy.deps)).toBe(
    "saas:team-a",
  );
  expect(await onboard(legacy.home, signal(), {}, legacy.deps)).toBe("saas:team-a");
  expect(legacy.events).not.toContain("/oauth/device/code");
});

test("a custom endpoint carries through login, Keychain, install, descriptor and later commands", async () => {
  const f = fixture(custom);
  const name = String(await onboard(f.home, signal(), { endpoint: `${custom}/` }, f.deps));
  expect(name).toBe("saas:team-b@localhost:8443");
  expect(f.events).toContain(`note:Sign in to ${custom} and authorize this computer.`);
  expect(f.events).toContain(`open:${custom}/device?user_code=ABCD-EFGH`);
  expect([...f.credentials.keys()]).toEqual([`${custom}#team-b`]);
  expect(f.installs).toEqual([custom]);
  expect(JSON.parse(readFileSync(join(f.home, "saas-login.json"), "utf8"))).toEqual({
    workspace_id: "team-b",
    endpoint: custom,
  });
  expect(existsSync(join(customDirectory(f.home), "providers", "team-b.json"))).toBe(true);
  expect(existsSync(join(f.home, "saas", "providers"))).toBe(false);
  expect(providerConfig(f.home, name)?.config).toMatchObject({
    endpoint: custom,
    tenant_id: "team-b",
    credential_account: `${custom}#team-b`,
    state_directory: join(customDirectory(f.home), "state", "team-b"),
  });
  expect(providerConfig(f.home)?.name).toBe(name);

  // The saved endpoint is reused without the flag, and reservations stay pinned to it.
  f.events.length = 0;
  f.deps.ui.interactive = false;
  expect(await onboard(f.home, signal(), {}, f.deps)).toBe(name);
  expect(await onboard(f.home, signal(), { providers: [name] }, f.deps)).toBe(name);
  expect(f.events).toEqual([
    "/v1/cli/session",
    "/v1/cli/access",
    "install",
    "/v1/cli/session",
    "/v1/cli/access",
    "install",
  ]);
  await expect(
    onboard(f.home, signal(), { providers: [name], endpoint: saasEndpoint }, f.deps),
  ).rejects.toThrow("another SaaS endpoint");
});

test("two endpoints never share credentials, workspaces or descriptors", async () => {
  const f = fixture();
  expect(await onboard(f.home, signal(), {}, f.deps)).toBe("saas:team-b");
  f.endpoint(custom);
  f.tokens([{ access_token: "enrollment-secret" }]);
  f.events.length = 0;
  expect(await onboard(f.home, signal(), { endpoint: custom }, f.deps)).toBe(
    "saas:team-b@localhost:8443",
  );
  // The default endpoint's saved workspace and credential are not offered to another service.
  expect(f.events).toContain("/oauth/device/code");
  expect(f.events).toContain("choose");
  expect([...f.credentials.keys()].sort()).toEqual([`${saasEndpoint}#team-b`, `${custom}#team-b`]);
  expect(providerConfig(f.home, "saas:team-b")?.config).toMatchObject({ endpoint: saasEndpoint });
  expect(providerConfig(f.home, "saas:team-b@localhost:8443")?.config).toMatchObject({
    endpoint: custom,
  });
  await expect(
    onboard(f.home, signal(), { providers: ["saas:team-b"], endpoint: custom }, f.deps),
  ).rejects.toThrow("another SaaS endpoint");
  f.endpoint(saasEndpoint);
  f.events.length = 0;
  f.deps.ui.interactive = false;
  // The saved selection now names the custom endpoint, so going back names the workspace too;
  // the default endpoint's Keychain credential is then reused without browser approval.
  expect(
    await onboard(f.home, signal(), { endpoint: saasEndpoint, workspace: "team-b" }, f.deps),
  ).toBe("saas:team-b");
  expect(f.events).not.toContain("/oauth/device/code");
  expect(JSON.parse(readFileSync(join(f.home, "saas-login.json"), "utf8"))).toEqual({
    workspace_id: "team-b",
  });
});

test("endpoints are strict HTTPS origins; an explicit port is allowed", () => {
  expect(managedEndpoint("https://localhost:8443")).toBe(custom);
  expect(managedEndpoint("HTTPS://Tunnels.Antasphere.com/")).toBe("https://tunnels.antasphere.com");
  expect(managedEndpoint("https://tunnels.antasphere.com:443")).toBe(
    "https://tunnels.antasphere.com",
  );
  for (const value of [
    "http://tunnels.antasphere.com",
    "https://user:pass@tunnels.antasphere.com",
    "https://user@tunnels.antasphere.com",
    "https://tunnels.antasphere.com/api",
    "https://tunnels.antasphere.com?x=1",
    "https://tunnels.antasphere.com?",
    "https://tunnels.antasphere.com#",
    "https://tunnels.antasphere.com#frag",
    "https://tunnels.antasphere.com\\evil",
    "https://localhost:0",
    "https://localhost:99999",
    "https://[::1]:8443",
    "tunnels.antasphere.com",
    "",
  ])
    expect(() => managedEndpoint(value)).toThrow("Invalid SaaS endpoint");
  expect(managedProvider("saas:team-b@localhost:8443")).toEqual({
    workspace: "team-b",
    endpoint: custom,
  });
  expect(managedProvider("saas:team-b")).toEqual({ workspace: "team-b", endpoint: saasEndpoint });
  for (const id of [
    "saas:team-b@contremaitre.ligerianlabs.fr",
    "saas:team-b@tunnels.antasphere.com:443",
    "saas:team-b@Tunnels.antasphere.com",
    "saas:team-b@localhost:0",
    "saas:team/b",
    "saas:../team-b",
  ])
    expect(() => managedProvider(id)).toThrow("Invalid SaaS provider ID");
  expect(isCredentialAccount(`${custom}#team-b`)).toBe(true);
  expect(isCredentialAccount(`${saasEndpoint}#team-b`)).toBe(true);
  for (const account of [
    `${custom}/#team-b`,
    "http://localhost:8443#team-b",
    "https://user@localhost#team-b",
    `${custom}#team b`,
    `${custom}`,
  ])
    expect(isCredentialAccount(account)).toBe(false);
});

test("a descriptor that disagrees with its provider ID is refused", async () => {
  const f = fixture(custom);
  const name = String(await onboard(f.home, signal(), { endpoint: custom }, f.deps));
  const path = join(customDirectory(f.home), "providers", "team-b.json");
  const original = readFileSync(path, "utf8");
  for (const change of [
    { endpoint: saasEndpoint },
    { credential_account: `${saasEndpoint}#team-b` },
    { tenant_id: "team-a" },
  ]) {
    const settings = JSON.parse(original);
    Object.assign(settings.providers[name].config, change);
    writeFileSync(path, JSON.stringify(settings));
    expect(() => providerConfig(f.home, name)).toThrow("does not match its SaaS endpoint");
    await expect(onboard(f.home, signal(), { providers: [name] }, f.deps)).rejects.toThrow(
      "does not match",
    );
  }
  // The selected default is held to the same rule.
  const settings = JSON.parse(original);
  settings.providers[name].config.endpoint = saasEndpoint;
  writeFileSync(join(f.home, "saas-provider.json"), JSON.stringify(settings));
  expect(() => providerConfig(f.home)).toThrow("does not match its SaaS endpoint");
});

test("custom endpoint installs stay on that origin and keep a separate manifest cache", async () => {
  const f = fixture();
  const digest = (value: string) => createHash("sha256").update(value).digest("hex");
  const artifacts = Object.fromEntries(
    ["provider", "transport", "frpc", "ca"].map((name) => [
      name,
      { url: `/downloads/${name}`, sha256: digest(name) },
    ]),
  );
  const manifest = {
    version: 1,
    protocol: 2,
    credential_accounts: true,
    platform: "darwin-arm64",
    artifacts,
  };
  const downloads: string[] = [];
  const fetcher: OnboardingDependencies["fetcher"] = async (url, init) => {
    expect(init.redirect).toBe("error");
    downloads.push(url);
    return url.includes(".well-known")
      ? Response.json(manifest)
      : new Response(url.split("/").at(-1));
  };
  await installProvider(f.home, signal(), fetcher, custom);
  expect(downloads.every((url) => url.startsWith(`${custom}/`))).toBe(true);
  expect(downloads).toHaveLength(5);
  expect(existsSync(join(customDirectory(f.home), "manifest.json"))).toBe(true);
  expect(existsSync(join(f.home, "saas", "manifest.json"))).toBe(false);
  rmSync(join(customDirectory(f.home), "manifest.json"));
  for (const foreign of [`${saasEndpoint}/downloads/provider`, "https://localhost:9443/provider"]) {
    artifacts.provider.url = foreign;
    downloads.length = 0;
    await expect(installProvider(f.home, signal(), fetcher, custom)).rejects.toThrow(
      "configured HTTPS origin",
    );
    expect(downloads).toEqual([`${custom}/.well-known/contremaitre-provider/darwin-arm64.json`]);
    expect(existsSync(join(customDirectory(f.home), "manifest.json"))).toBe(false);
  }
});

test("a private CA is explicit, scoped to its custom endpoint and saved beside it", async () => {
  const f = fixture(custom);
  const pem = "-----BEGIN CERTIFICATE-----\nMIIB\n-----END CERTIFICATE-----\n";
  const file = join(f.home, "private-ca.pem");
  writeFileSync(file, pem);
  await expect(onboard(f.home, signal(), { caFile: file }, f.deps)).rejects.toThrow(
    "only to a custom --endpoint",
  );
  writeFileSync(join(f.home, "not-a-ca.pem"), "hello");
  await expect(
    onboard(f.home, signal(), { endpoint: custom, caFile: join(f.home, "not-a-ca.pem") }, f.deps),
  ).rejects.toThrow("PEM-encoded");
  await expect(
    onboard(f.home, signal(), { endpoint: custom, caFile: join(f.home, "missing.pem") }, f.deps),
  ).rejects.toThrow("Cannot read --ca-file");
  expect(f.events).toEqual([]);
  await onboard(f.home, signal(), { endpoint: custom, caFile: file }, f.deps);
  expect(f.trusted.length).toBeGreaterThan(0);
  expect(f.trusted.every((ca) => ca === pem)).toBe(true);
  const saved = join(customDirectory(f.home), "ca.pem");
  expect(readFileSync(saved, "utf8")).toBe(pem);
  expect(statSync(saved).mode & 0o777).toBe(0o600);
  // Later commands trust the saved roots without repeating the flag.
  rmSync(file);
  f.trusted.length = 0;
  await onboard(f.home, signal(), {}, f.deps);
  expect(f.trusted.length).toBeGreaterThan(0);
  expect(f.trusted.every((ca) => ca === pem)).toBe(true);
});

const openssl = Bun.which("openssl");
test.skipIf(!openssl)(
  "withTrust verifies a private CA instead of disabling verification",
  async () => {
    const dir = mkdtempSync(join(tmpdir(), "cm-saas-ca-"));
    directories.push(dir);
    const sh = (args: string[]) => {
      const result = Bun.spawnSync([openssl as string, ...args], { cwd: dir, stderr: "pipe" });
      if (result.exitCode !== 0) throw Error(result.stderr.toString());
    };
    sh([
      "req",
      "-x509",
      "-newkey",
      "rsa:2048",
      "-nodes",
      "-keyout",
      "ca.key",
      "-out",
      "ca.pem",
      "-days",
      "1",
      "-subj",
      "/CN=Contremaitre test CA",
      "-addext",
      "basicConstraints=critical,CA:TRUE",
      "-addext",
      "keyUsage=critical,keyCertSign",
    ]);
    sh([
      "req",
      "-newkey",
      "rsa:2048",
      "-nodes",
      "-keyout",
      "server.key",
      "-out",
      "server.csr",
      "-subj",
      "/CN=localhost",
    ]);
    writeFileSync(
      join(dir, "server.ext"),
      "subjectAltName=DNS:localhost\nbasicConstraints=CA:FALSE\nextendedKeyUsage=serverAuth\n",
    );
    sh([
      "x509",
      "-req",
      "-in",
      "server.csr",
      "-CA",
      "ca.pem",
      "-CAkey",
      "ca.key",
      "-CAcreateserial",
      "-out",
      "server.pem",
      "-days",
      "1",
      "-extfile",
      "server.ext",
    ]);
    const server = Bun.serve({
      port: 0,
      hostname: "localhost",
      tls: {
        cert: readFileSync(join(dir, "server.pem"), "utf8"),
        key: readFileSync(join(dir, "server.key"), "utf8"),
      },
      fetch: () => Response.json({ ok: true }),
    });
    try {
      const url = `https://localhost:${server.port}/v1/cli/session`;
      await expect(fetch(url)).rejects.toThrow();
      await expect(
        withTrust(fetch, readFileSync(join(dir, "server.pem"), "utf8"))(url, {}),
      ).rejects.toThrow();
      const response = await withTrust(fetch, readFileSync(join(dir, "ca.pem"), "utf8"))(url, {
        redirect: "error",
      });
      expect(await response.json()).toEqual({ ok: true });
    } finally {
      server.stop(true);
    }
  },
);
