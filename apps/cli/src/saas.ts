import { existsSync, readFileSync, statSync } from "node:fs";
import { hostname } from "node:os";
import { join, resolve } from "node:path";
import { createInterface } from "node:readline/promises";
import {
  credentialAccount,
  endpointDirectory,
  managedDescriptor,
  managedEndpoint,
  managedProvider,
  managedProviderId,
  providerConfig,
  providerSettings,
  saasEndpoint,
} from "@contremaitre/environments/tunnel-provider";
import { context, fail, isCode } from "@contremaitre/execution/context";
import { atomicWrite } from "@contremaitre/execution/files";
import { run } from "@contremaitre/execution/process";
import { sleep } from "@contremaitre/execution/sleep";
import { Schema } from "effect";
import {
  AuthenticationRequired,
  api,
  type Fetch,
  read,
  sameOrigin,
  withTrust,
} from "./saas-client.js";
import { type Credentials, credentialSchema, keychain } from "./saas-credentials.js";
import { installProvider } from "./saas-install.js";

const id = Schema.String.pipe(Schema.pattern(/^[A-Za-z0-9_-]{1,128}$/));
const workspaceSchema = Schema.Struct({ id, name: Schema.NonEmptyString });
type Workspace = typeof workspaceSchema.Type;
const accountSchema = Schema.Struct({ account_id: id, workspaces: Schema.Array(workspaceSchema) });
const sessionSchema = Schema.Struct({ ...accountSchema.fields, workspace_id: id });
const flowSchema = Schema.Struct({
  device_code: Schema.NonEmptyString,
  user_code: Schema.String.pipe(Schema.pattern(/^[A-Z0-9-]{4,16}$/)),
  verification_uri: Schema.String,
  verification_uri_complete: Schema.optional(Schema.String),
  expires_in: Schema.Int.pipe(Schema.between(1, 900)),
  interval: Schema.Int.pipe(Schema.between(1, 60)),
});
const accessSchema = Schema.Struct({
  workspace_id: id,
  can_share: Schema.Boolean,
  reason: Schema.NullOr(Schema.Literal("subscription_required")),
  subscription_url: Schema.String,
});
const tokenSchema = Schema.Struct({
  access_token: Schema.optional(Schema.NonEmptyString),
  error: Schema.optional(Schema.String),
});
const loginSchema = Schema.Struct({ workspace_id: id, endpoint: Schema.optional(Schema.String) });
function savedLogin(home: string) {
  let body: string;
  try {
    body = readFileSync(join(home, "saas-login.json"), "utf8");
  } catch (e) {
    if (isCode(e, "ENOENT")) return undefined;
    return fail("Cannot read saas-login.json");
  }
  try {
    const login = read(loginSchema, JSON.parse(body));
    return {
      workspace: login.workspace_id,
      endpoint: login.endpoint === undefined ? saasEndpoint : managedEndpoint(login.endpoint),
    };
  } catch {
    return fail("Invalid saas-login.json; remove it and run contremaitre tunnel login");
  }
}
function readTrust(path: string) {
  let pem: string;
  try {
    if (statSync(path).size > 1 << 20) throw Error();
    pem = readFileSync(path, "utf8");
  } catch {
    return fail(`Cannot read --ca-file ${path}`);
  }
  if (!pem.includes("-----BEGIN CERTIFICATE-----"))
    fail("--ca-file must contain PEM-encoded CA certificates");
  return pem;
}
const optionalTrust = (path: string) => (existsSync(path) ? readTrust(path) : undefined);
export interface OnboardingUI {
  interactive: boolean;
  note(message: string): void;
  open(url: string, signal: AbortSignal): Promise<void>;
  choose(workspaces: readonly Workspace[], signal: AbortSignal): Promise<string>;
}
export interface OnboardingOptions {
  workspace?: string;
  login?: boolean;
  providers?: readonly string[];
  /** Managed service origin; saved with the workspace selection for later commands. */
  endpoint?: string;
  /** PEM roots for a custom endpoint signed by a private CA; saved beside that endpoint. */
  caFile?: string;
}
export interface OnboardingDependencies {
  ui: OnboardingUI;
  credentials: Credentials;
  fetcher: Fetch;
  install: typeof installProvider;
  sleep: typeof sleep;
  now: () => number;
}
const clean = (text: string) => text.replace(/[\p{Cc}\p{Cf}]/gu, "").slice(0, 200);
export function terminalOnboarding(json = false): OnboardingUI {
  return {
    interactive: !json && !!process.stdin.isTTY && !!process.stderr.isTTY,
    note(message) {
      process.stderr.write(`${message}\n`);
    },
    async open(url, signal) {
      await run(context(signal), ["/usr/bin/open", url], { timeout: 5000, stderr: () => {} });
    },
    async choose(workspaces, signal) {
      const terminal = createInterface({ input: process.stdin, output: process.stderr });
      const controller = new AbortController();
      const interrupt = () => controller.abort();
      terminal.on("SIGINT", interrupt);
      terminal.on("close", interrupt);
      try {
        for (const [i, workspace] of workspaces.entries())
          process.stderr.write(`${i + 1}. ${clean(workspace.name)} (${workspace.id})\n`);
        while (true) {
          const answer = await terminal.question("Choose the workspace for this preview: ", {
            signal: AbortSignal.any([signal, controller.signal]),
          });
          const chosen = /^\d+$/.test(answer.trim())
            ? workspaces[Number(answer.trim()) - 1]
            : undefined;
          if (chosen) return chosen.id;
        }
      } catch {
        return fail("Workspace selection cancelled");
      } finally {
        terminal.close();
      }
    },
  };
}
function requireTerminal(ui: OnboardingUI) {
  if (!ui.interactive)
    fail(
      "SaaS login requires a terminal; run contremaitre tunnel login interactively, then retry this command",
    );
}
async function choose(
  ui: OnboardingUI,
  workspaces: readonly Workspace[],
  wanted: string | undefined,
  signal: AbortSignal,
) {
  if (!workspaces.length) fail("No SaaS workspaces are available for this account");
  if (new Set(workspaces.map((w) => w.id)).size !== workspaces.length)
    fail("Invalid SaaS workspace list");
  if (wanted) {
    if (!workspaces.some((workspace) => workspace.id === wanted))
      fail("The selected SaaS workspace is unavailable; choose an accessible --workspace ID");
    return wanted;
  }
  if (!ui.interactive)
    fail(
      "Select a SaaS workspace with --workspace ID or run contremaitre tunnel login in a terminal",
    );
  const selected = await ui.choose(workspaces, signal);
  if (!workspaces.some((w) => w.id === selected)) fail("Invalid workspace selection");
  return selected;
}
export async function onboard(
  home: string,
  signal: AbortSignal,
  options: OnboardingOptions = {},
  overrides: Partial<OnboardingDependencies> = {},
) {
  const pinned = [...new Set(options.providers ?? [])];
  if (pinned.length > 1) fail("Release older tunnel reservations before changing providers");
  const selected = providerConfig(home, pinned[0]);
  const custom = providerSettings(home);
  if (
    (custom && !pinned[0]?.startsWith("saas:")) ||
    (selected && !selected.name.startsWith("saas:"))
  ) {
    if (options.workspace || options.login || options.endpoint || options.caFile)
      fail(
        "This environment uses a custom tunnel provider; use that provider's login and workspace settings",
      );
    return selected?.name;
  }
  if (pinned[0] && !selected)
    fail("Reserved tunnel provider is missing; restore its configuration");
  // providerConfig has already checked that the descriptor agrees with its provider ID.
  const current = selected ? managedProvider(selected.name) : undefined;
  const requested = options.endpoint ? managedEndpoint(options.endpoint) : undefined;
  if (pinned[0] && current && requested && requested !== current.endpoint)
    fail(
      "Existing URLs belong to another SaaS endpoint; release those reservations before switching",
    );
  const login = pinned[0] ? undefined : savedLogin(home);
  // Reservations pin their endpoint; otherwise --endpoint, then the saved selection.
  const endpoint =
    (pinned[0] ? current?.endpoint : (requested ?? (login ?? current)?.endpoint)) ?? saasEndpoint;
  // A saved workspace only means something on the endpoint it was chosen for.
  const saved = [login, current].find((source) => source?.endpoint === endpoint)?.workspace;
  if (pinned[0] && options.workspace && options.workspace !== saved)
    fail(
      "Existing URLs belong to another SaaS workspace; release those reservations before switching",
    );
  const trustPath = join(endpointDirectory(home, endpoint), "ca.pem");
  if (options.caFile && endpoint === saasEndpoint)
    fail("--ca-file applies only to a custom --endpoint");
  const trust = options.caFile
    ? readTrust(resolve(options.caFile))
    : endpoint === saasEndpoint
      ? undefined
      : optionalTrust(trustPath);
  const deps: OnboardingDependencies = {
    ui: terminalOnboarding(),
    credentials: keychain(),
    fetcher: fetch,
    install: installProvider,
    sleep,
    now: Date.now,
    ...overrides,
  };
  const fetcher = withTrust(deps.fetcher, trust);
  const call = api(signal, fetcher, endpoint);
  let workspace = options.workspace || saved;
  if (workspace) workspace = read(id, workspace);
  const account = (tenant: string) => credentialAccount(endpoint, tenant);
  let credential =
    workspace && !options.login
      ? await deps.credentials.get(account(workspace), signal)
      : undefined;
  if (credential) {
    try {
      const session = read(sessionSchema, await call("/v1/cli/session", credential.credential));
      if (session.workspace_id !== workspace)
        fail("Saved SaaS credential belongs to another workspace; run contremaitre tunnel login");
      workspace = await choose(deps.ui, session.workspaces, workspace, signal);
    } catch (e) {
      if (!(e instanceof AuthenticationRequired)) throw e;
      credential = undefined;
    }
  }
  if (!credential) {
    requireTerminal(deps.ui);
    deps.ui.note(`Sign in to ${endpoint} and authorize this computer.`);
    const flow = read(
      flowSchema,
      await call(
        "/oauth/device/code",
        undefined,
        new URLSearchParams({
          client_id: "contremaitre-cli",
          scope: "tunnels",
          device_name: clean(hostname()),
        }),
      ),
    );
    const verification = sameOrigin(flow.verification_uri, endpoint);
    deps.ui.note(`Open ${verification} and enter ${flow.user_code}`);
    const complete = new URL(sameOrigin(flow.verification_uri_complete ?? verification, endpoint));
    if (complete.pathname !== new URL(verification).pathname)
      fail("Invalid SaaS device authorization URL");
    complete.searchParams.set("user_code", flow.user_code);
    const expires = deps.now() + flow.expires_in * 1000;
    try {
      await deps.ui.open(complete.href, signal);
    } catch {
      signal.throwIfAborted();
    }
    let interval = flow.interval * 1000;
    let token: string | undefined;
    while (deps.now() + interval < expires) {
      await deps.sleep(interval, signal);
      if (deps.now() >= expires) break;
      const response = read(
        tokenSchema,
        await call(
          "/oauth/device/token",
          undefined,
          new URLSearchParams({
            grant_type: "urn:ietf:params:oauth:grant-type:device_code",
            client_id: "contremaitre-cli",
            device_code: flow.device_code,
          }),
        ),
      );
      if (response.error === "authorization_pending") continue;
      if (response.error === "slow_down") {
        interval += 5000;
        continue;
      }
      if (response.error === "access_denied")
        fail("SaaS login was denied; run contremaitre tunnel again to retry");
      if (response.error === "expired_token") break;
      if (response.error || !response.access_token)
        fail("SaaS login failed; run contremaitre tunnel again to retry");
      token = response.access_token;
      break;
    }
    if (!token) fail("SaaS login expired; run contremaitre tunnel again to retry");
    const membership = read(accountSchema, await call("/v1/cli/workspaces", token));
    workspace = await choose(deps.ui, membership.workspaces, workspace, signal);
    const enrolled = read(
      Schema.Struct({ ...credentialSchema.fields, workspace_id: id, account_id: id }),
      await call("/v1/devices/enroll", token, { name: clean(hostname()), tenant_id: workspace }),
    );
    if (enrolled.workspace_id !== workspace || enrolled.account_id !== membership.account_id)
      fail("SaaS enrollment identity does not match the approved account and workspace");
    credential = { device_id: enrolled.device_id, credential: enrolled.credential };
    await deps.credentials.set(account(workspace), credential, signal);
  }
  if (!workspace) return fail("Missing SaaS workspace");
  signal.throwIfAborted();
  if (options.caFile && trust) atomicWrite(trustPath, trust);
  atomicWrite(
    join(home, "saas-login.json"),
    JSON.stringify(
      endpoint === saasEndpoint
        ? { workspace_id: workspace }
        : { workspace_id: workspace, endpoint },
    ),
  );
  const name = managedProviderId(workspace, endpoint);
  if (options.login) return name;
  const access = read(accessSchema, await call("/v1/cli/access", credential.credential));
  if (access.workspace_id !== workspace || access.can_share !== (access.reason === null))
    fail("Invalid SaaS workspace access response");
  if (!access.can_share) {
    const billing = new URL(sameOrigin(access.subscription_url, endpoint));
    if (billing.pathname !== "/billing" || billing.searchParams.get("workspace") !== workspace)
      fail("Invalid SaaS subscription URL");
    const message = `This workspace needs an active subscription before creating tunnels. Subscribe at ${billing.href}, then run contremaitre tunnel again.`;
    if (deps.ui.interactive) {
      deps.ui.note("Opening the subscription page for this workspace.");
      try {
        await deps.ui.open(billing.href, signal);
      } catch {
        signal.throwIfAborted();
      }
    }
    fail(message);
  }
  const installed = await deps.install(home, signal, fetcher, endpoint);
  signal.throwIfAborted();
  const { executable, ...transport } = installed;
  const settings = JSON.stringify({
    default: name,
    providers: {
      [name]: {
        executable,
        config: {
          endpoint,
          tenant_id: workspace,
          credential_account: account(workspace),
          foreground_sessions: true,
          state_directory: join(endpointDirectory(home, endpoint), "state", workspace),
          ...transport,
        },
      },
    },
  });
  // Per-workspace files keep existing reservations and concurrent sessions independent
  // of whichever workspace was most recently selected as the default.
  atomicWrite(managedDescriptor(home, name), settings);
  atomicWrite(join(home, "saas-provider.json"), settings);
  return name;
}
