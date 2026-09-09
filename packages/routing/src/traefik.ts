import { mkdirSync } from "node:fs";
import { createConnection } from "node:net";
import { join } from "node:path";
import { type Context, fail, hash, message } from "@contremaitre/execution/context";
import { atomicWrite } from "@contremaitre/execution/files";
import { run } from "@contremaitre/execution/process";
import { sleep } from "@contremaitre/execution/sleep";
import { localCertificates } from "./certificates.js";

export interface LocalRoute {
  host: string;
  upstream: string;
}
interface CertificateFiles {
  certFile: string;
  keyFile: string;
}
const dashboardHost = "contremaitre.localhost";

export function traefikConfiguration(routes: LocalRoute[], certificates: CertificateFiles[]) {
  const routers: Record<string, unknown> = {
      dashboard: {
        rule: `Host(\`${dashboardHost}\`)`,
        entryPoints: ["websecure"],
        service: "api@internal",
        middlewares: ["dashboard-redirect"],
        tls: {},
      },
    },
    services: Record<string, unknown> = {};
  for (const { host, upstream } of routes) {
    const name = hash(host);
    routers[name] = {
      rule: `Host(\`${host}\`)`,
      entryPoints: ["websecure"],
      service: name,
      tls: {},
    };
    services[name] = {
      loadBalancer: { passHostHeader: true, servers: upstream ? [{ url: upstream }] : [] },
    };
  }
  return {
    http: {
      routers,
      ...(routes.length ? { services } : {}),
      middlewares: {
        "dashboard-redirect": {
          redirectRegex: {
            regex: "^(https://[^/]+)/?(\\?.*)?$",
            replacement: "$1/dashboard/$2",
            permanent: true,
          },
        },
      },
    },
    tls: { certificates, options: { default: { minVersion: "VersionTLS12" } } },
  };
}

async function reachable(port: number) {
  return new Promise<boolean>((resolve) => {
    const socket = createConnection({ host: "127.0.0.1", port });
    const done = (value: boolean) => {
      socket.destroy();
      resolve(value);
    };
    socket.setTimeout(300, () => done(false));
    socket.once("error", () => done(false));
    socket.once("connect", () => done(true));
  });
}

export async function startTraefik(
  parent: Context,
  home: string,
  port: number,
  snapshot: () => LocalRoute[],
  failed: (error: Error) => void,
) {
  if (!Bun.which("traefik"))
    fail("Local HTTPS requires Traefik. Run brew install traefik mkcert, then mkcert -install.");
  if (await reachable(port)) fail(`Local HTTPS port ${port} is already in use`);
  const cancelled = new AbortController();
  const ctx = { ...parent, signal: AbortSignal.any([parent.signal, cancelled.signal]) };
  const certificates = await localCertificates(ctx, home);
  const directory = join(home, "traefik", "dynamic");
  mkdirSync(directory, { recursive: true, mode: 0o700 });
  let previous = "",
    dirty = false,
    stopped = false;
  let publishing: Promise<void> | undefined;
  async function publish() {
    do {
      dirty = false;
      const routes = snapshot();
      const signature = JSON.stringify(routes);
      if (signature === previous) continue;
      const files: CertificateFiles[] = [
        { certFile: certificates.certFile, keyFile: certificates.keyFile },
        await certificates.certificate(dashboardHost),
      ];
      // Sequential issuance bounds mkcert processes even for a large recorded stack.
      for (const route of routes) files.push(await certificates.certificate(route.host));
      ctx.signal.throwIfAborted();
      atomicWrite(
        join(directory, "routes.yml"),
        JSON.stringify(traefikConfiguration(routes, files)),
      );
      previous = signature;
    } while (dirty && !stopped);
  }
  await publish();
  const configuration = join(home, "traefik", "static.yml");
  atomicWrite(
    configuration,
    JSON.stringify({
      api: { dashboard: true, insecure: false },
      entryPoints: { websecure: { address: `127.0.0.1:${port}` } },
      providers: { providersThrottleDuration: "100ms", file: { directory, watch: true } },
      log: { level: "ERROR" },
    }),
  );
  const child = run(ctx, ["traefik", `--configFile=${configuration}`], {
    timeout: 2_147_483_647,
    stdout: ctx.log,
    stderr: ctx.log,
    env: Object.fromEntries(
      Object.entries(process.env).filter(([key]) => !key.startsWith("TRAEFIK_")),
    ),
  });
  let exited = false;
  const completion = child.then(
    () => {
      exited = true;
      if (!stopped) failed(Error("Traefik exited; restart the hub"));
    },
    (error) => {
      exited = true;
      if (!stopped) failed(Error(`Traefik failed: ${message(error)}`));
    },
  );
  const close = async () => {
    stopped = true;
    clearInterval(renewal);
    cancelled.abort();
    await completion;
    await publishing?.catch(() => {});
  };
  const update = () => {
    if (stopped) return;
    dirty = true;
    publishing ??= publish()
      .catch((error) => {
        if (!stopped) failed(error);
      })
      .finally(() => {
        publishing = undefined;
        if (dirty && !stopped) update();
      });
  };
  const renewal = setInterval(() => {
    previous = "";
    update();
  }, 3600000);
  try {
    const deadline = Date.now() + 10000;
    while (!(await reachable(port))) {
      if (exited) fail("Traefik failed to start; see daemon.log");
      if (Date.now() > deadline) fail("Traefik startup timed out; see daemon.log");
      await sleep(100, ctx.signal);
    }
    return { update, close };
  } catch (error) {
    await close();
    throw error;
  }
}
