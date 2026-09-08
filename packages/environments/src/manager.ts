import { randomBytes } from "node:crypto";
import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync } from "node:fs";
import { join, resolve } from "node:path";
import {
  type Context,
  context,
  fail,
  keys,
  message,
  now,
  phase,
} from "@contremaitre/execution/context";
import { privateEnv, removeFile } from "@contremaitre/execution/files";
import { sleep } from "@contremaitre/execution/sleep";
import {
  detectIdentity,
  loadManifest,
  order,
  prepareManifest,
  readEnv,
  safePath,
} from "@contremaitre/projects/config";
import type { Identity, Manifest } from "@contremaitre/projects/model";
import { type Runtime, tcpReady } from "./apple.js";
import { cloneData, cloneDriver, recoverClones } from "./clone.js";
import { applyDriverReply, invokeDriver, snapshotDriver } from "./driver.js";
import {
  type Environment,
  type Request,
  resourceName,
  type ServiceState,
  type State,
} from "./model.js";
import { publicEnvironment, type Store } from "./store.js";
export interface PreparedDeploy {
  root: string;
  identity: Identity;
  manifest: Manifest;
  request: Request;
  sourceId?: string;
}
export interface TunnelHooks {
  stop(ctx: Context, env: Environment, name: string, release: boolean): Promise<void>;
  running(id: string, name: string): boolean;
}
export class Manager {
  readonly state: State;
  tunnels?: TunnelHooks;
  onSave: () => void = () => {};
  constructor(
    readonly store: Store,
    readonly runtime: Runtime,
    readonly httpPort = 8080,
  ) {
    this.state = store.load();
  }
  assertRecovered(id: string) {
    const dir = join(this.store.home, "recovery");
    if (!existsSync(dir)) return;
    for (const file of readdirSync(dir)) {
      if (!file.endsWith(".json")) continue;
      const r: unknown = JSON.parse(readFileSync(join(dir, file), "utf8"));
      if (typeof r !== "object" || r === null) fail("Invalid clone recovery journal");
      if (("source" in r && r.source === id) || ("target" in r && r.target === id))
        fail(
          "Clone recovery is pending; restart the hub to resume recovery before modifying this environment",
          "conflict",
        );
    }
  }
  save() {
    this.store.save(this.state);
    this.onSave();
  }
  resolve(selector: string): Environment {
    const direct = this.state.Environments[selector];
    if (direct) return direct;
    const matches = Object.values(this.state.Environments).filter((e) =>
      [e.Identity.Name, e.Identity.Host, e.Identity.Project].includes(selector),
    );
    if (matches.length > 1) fail(`Ambiguous environment ${selector}; use an ID or full name`);
    if (matches[0]) return matches[0];
    if (selector.endsWith("/main")) {
      const env = this.state.Environments[this.state.Main[selector.slice(0, -5)]];
      if (env) return env;
    }
    return fail(`Environment ${selector} not found`);
  }
  view(env: Environment): Environment {
    const out = publicEnvironment(env);
    for (const [name, t] of Object.entries(out.tunnels ?? {}))
      t.Connected = this.tunnels?.running(env.Identity.ID, name) ?? false;
    return out;
  }
  list() {
    return keys(this.state.Environments).map((id) => this.view(this.state.Environments[id]));
  }
  async current(ctx: Context, root: string, branch?: string) {
    const manifest = loadManifest(root);
    return detectIdentity(ctx, root, manifest.project, branch);
  }
  async prepare(ctx: Context, request: Request): Promise<PreparedDeploy> {
    const root = resolve(request.root ?? process.cwd());
    const manifest = prepareManifest(root, loadManifest(root));
    const identity = await detectIdentity(ctx, root, manifest.project, request.branch);
    return { root, manifest, identity, request, sourceId: this.state.Main[identity.Project] };
  }
  fresh(identity: Identity, root: string): Environment {
    return {
      Identity: identity,
      Root: root,
      Status: "pending",
      Error: "",
      Network: `${this.store.namespace()}-${identity.ID}`,
      Services: {},
      credentials: {},
      tunnels: {},
      builds: {},
      Volumes: [],
      Images: [],
      CloneComplete: false,
      CreatedAt: now(),
      UpdatedAt: now(),
    };
  }
  source(env: Environment) {
    return this.state.Environments[this.state.Main[env.Identity.Project]];
  }
  async deploy(ctx: Context, p: PreparedDeploy): Promise<void> {
    this.assertRecovered(p.identity.ID);
    if (p.sourceId) this.assertRecovered(p.sourceId);
    if (p.sourceId && p.sourceId !== p.identity.ID && !this.state.Environments[p.sourceId])
      fail(
        "The selected main source was deleted while this deployment was queued; deploy again to select a source",
      );
    phase(ctx, "Reading project configuration");
    const { root, identity, manifest, request } = p;
    let env = this.state.Environments[identity.ID];
    if (env && (!!env.driver !== !!manifest.driver || env.Status === "deleting"))
      fail(
        "Explicitly delete this environment before changing runtime or redeploying an incomplete deletion",
      );
    if (
      request.main &&
      this.state.Main[identity.Project] &&
      this.state.Main[identity.Project] !== identity.ID
    )
      fail("Main already designated; use main --env to change it explicitly");
    if (manifest.driver) {
      const candidate = this.fresh(identity, root);
      snapshotDriver(this.store.home, candidate, manifest.driver);
      await invokeDriver(ctx, candidate, "preflight");
      if (!env) {
        env = candidate;
        this.state.Environments[identity.ID] = env;
      } else {
        env.driver = candidate.driver;
        env.driver_directory = candidate.driver_directory;
        env.Root = root;
      }
      await this.deployDriver(ctx, env, request, p.sourceId);
      return;
    }
    if (!env) {
      env = this.fresh(identity, root);
      this.state.Environments[identity.ID] = env;
    }
    if (request.main || (identity.Branch === "main" && !this.state.Main[identity.Project]))
      this.state.Main[identity.Project] = identity.ID;
    this.save();
    const previousStatus = env.Status;
    let mutated = false;
    try {
      const names = order(manifest.services),
        images: Record<string, string> = {};
      for (const name of names) {
        const s = manifest.services[name];
        if (!s.build) {
          images[name] = s.image ?? "";
          continue;
        }
        const buildRoot = safePath(root, s.build),
          dockerfile = safePath(root, s.dockerfile || join(s.build, "Dockerfile"));
        const tag = `cm-${identity.ID}-${name}:${Date.now()}${randomBytes(3).toString("hex")}`;
        env.Images.push(tag);
        this.save();
        phase(ctx, `Building ${name}`);
        const built = await this.runtime.build(
          ctx,
          buildRoot,
          dockerfile,
          tag,
          request.rebuild ? undefined : env.builds?.[name],
        );
        env.builds ??= {};
        env.builds[name] = built;
        images[name] = built.image;
        if (tag !== built.image) env.Images = env.Images.filter((i) => i !== tag);
        this.save();
      }
      for (const [name, old] of Object.entries(env.Services)) {
        const next = manifest.services[name];
        if (
          next &&
          old.Spec.kind !== "app" &&
          (old.Spec.kind !== next.kind || old.Image !== images[name])
        )
          fail(
            `${name}: database kind/image changed; use an explicit data migration or delete this environment`,
          );
      }
      phase(ctx, `Preparing network for ${identity.Name}`);
      await this.runtime.network(ctx, env.Network);
      mutated = true;
      env.Status = "deploying";
      env.Error = "";
      this.save();
      for (const name of keys(env.Services)) {
        const s = env.Services[name];
        await this.runtime.stop(ctx, s.Container);
        await this.runtime.remove(ctx, s.Container);
        await this.runtime.remove(ctx, `${s.Container}-task`);
      }
      if (keys(env.Services).length) {
        await this.runtime.removeNetwork(ctx, env.Network);
        await this.runtime.network(ctx, env.Network);
      }
      const services: Environment["Services"] = {};
      for (const name of names) {
        const s = manifest.services[name],
          old = env.Services[name];
        services[name] = {
          Name: name,
          Container: resourceName(env.Network, name),
          Image: images[name],
          IP: "",
          Volume: old?.Volume ?? "",
          Port: s.port ?? 0,
          HTTP: s.http ?? false,
          Spec: s,
          Initialized: old?.Initialized ?? false,
        };
      }
      env.Services = services;
      env.Root = root;
      this.save();
      for (const name of names)
        if (env.Services[name].Spec.kind !== "app")
          await this.startService(ctx, env, env.Services[name], false);
      if (!env.CloneComplete) {
        const source = this.state.Environments[p.sourceId ?? ""];
        if (source && source !== env) {
          if (source.driver) fail("Cannot clone between native and driver environments");
          phase(ctx, `Forking data from ${source.Identity.Name}`);
          await cloneData(this, ctx, source, env);
        }
        env.CloneComplete = true;
        this.save();
      }
      for (const name of names)
        if (env.Services[name].Spec.kind === "app")
          await this.startService(ctx, env, env.Services[name], true);
      env.Status = "running";
      env.Error = "";
      env.UpdatedAt = now();
      this.save();
    } catch (e) {
      env.Error = message(e);
      env.Status = mutated ? "failed" : previousStatus;
      env.UpdatedAt = now();
      this.save();
      throw e;
    }
  }
  private async deployDriver(ctx: Context, env: Environment, req: Request, sourceId?: string) {
    const previous = env.Status;
    env.Status = "deploying";
    env.Error = "";
    this.save();
    try {
      if (!env.CloneComplete) {
        const source = this.state.Environments[sourceId ?? ""];
        if (source && source !== env) {
          if (!source.driver) fail("Cannot clone between native and driver environments");
          await cloneDriver(this, ctx, source, env);
        }
        env.CloneComplete = true;
        this.save();
      }
      applyDriverReply(env, await invokeDriver(ctx, env, "deploy"));
      if (env.Status !== "running") fail("Driver deploy did not confirm a running environment");
      if (req.main || (env.Identity.Branch === "main" && !this.state.Main[env.Identity.Project]))
        this.state.Main[env.Identity.Project] = env.Identity.ID;
      env.UpdatedAt = now();
      this.save();
    } catch (e) {
      env.Status = "failed";
      if (previous === "running")
        try {
          const reply = await invokeDriver(context(AbortSignal.timeout(15_000)), env, "status");
          if (reply.status === "running") applyDriverReply(env, reply);
        } catch {}
      env.Error = message(e);
      this.save();
      throw e;
    }
  }
  localURL(env: Environment, name: string) {
    if (env.Services[name]?.url) return env.Services[name].url;
    const first = keys(env.Services).find((n) => env.Services[n].HTTP);
    const host = `${first === name ? "" : `${name}.`}${env.Identity.Host}`;
    return `http://${host}${this.httpPort === 80 ? "" : `:${this.httpPort}`}`;
  }
  serviceEnv(env: Environment, s: ServiceState): Record<string, string> {
    const values = {
      ...(s.raw_environment ?? (s.Spec.env_file ? readEnv(env.Root, s.Spec.env_file) : {})),
      ...s.Spec.environment,
    };
    if (!s.raw_environment) {
      s.raw_environment = { ...values };
      this.save();
    }
    if (s.Spec.kind === "postgres") {
      env.credentials ??= {};
      if (!env.credentials[s.Name]) {
        env.credentials[s.Name] = randomBytes(24).toString("hex");
        this.save();
      }
      Object.assign(values, {
        POSTGRES_USER: "app",
        POSTGRES_DB: "app",
        PGDATA: "/var/lib/postgresql/data/pgdata",
        POSTGRES_PASSWORD: env.credentials[s.Name],
      });
    }
    for (const [key, value] of Object.entries(values)) {
      values[key] = value
        .replaceAll(
          "{{contremaitre.url}}",
          env.tunnels?.[s.Name]?.URL ?? this.localURL(env, s.Name),
        )
        .replaceAll("{{contremaitre.local_url}}", this.localURL(env, s.Name))
        .replace(
          /\{\{([a-z][a-z0-9-]*)\.(host|port|url|local_url)\}\}/g,
          (_token, name: string, property: string) => {
            const dep = env.Services[name];
            if (dep && property === "local_url") return this.localURL(env, name);
            if (!dep?.IP) fail(`${s.Name}: ${name} is not ready; declare depends_on`);
            if (property === "host") return dep.IP;
            if (property === "port") return String(dep.Port);
            const host = `${dep.IP.includes(":") ? `[${dep.IP}]` : dep.IP}:${dep.Port}`;
            if (dep.Spec.kind === "postgres")
              return `postgresql://app:${encodeURIComponent(env.credentials?.[name] ?? "")}@${host}/app?sslmode=disable`;
            if (dep.Spec.kind === "redis") return `redis://${host}/0`;
            return `http://${host}`;
          },
        );
      if (values[key].includes("{{")) fail(`${key}: unsupported environment reference`);
    }
    values.CONTREMAITRE_ENVIRONMENT = env.Identity.ID;
    values.CONTREMAITRE_LOCAL_URL = this.localURL(env, s.Name);
    if (env.tunnels?.[s.Name]) values.CONTREMAITRE_PUBLIC_URL = env.tunnels[s.Name].URL;
    return values;
  }
  async volumes(ctx: Context, env: Environment, s: ServiceState) {
    const volumes: Record<string, string> = {};
    if (s.Spec.kind === "postgres") {
      if (!s.Volume) {
        s.Volume = `${resourceName(env.Network, s.Name)}-data`;
        env.Volumes.push(s.Volume);
        this.save();
      }
      await this.runtime.volume(ctx, s.Volume);
      volumes[s.Volume] = "/var/lib/postgresql/data";
    }
    for (const [name, target] of Object.entries(s.Spec.volumes ?? {})) {
      const path = join(this.store.home, "data", env.Identity.ID, name);
      mkdirSync(path, { recursive: true, mode: 0o755 });
      volumes[path] = target;
    }
    return volumes;
  }
  async startService(ctx: Context, env: Environment, s: ServiceState, initialize: boolean) {
    const envFile = privateEnv(join(this.store.home, "tmp"), this.serviceEnv(env, s));
    try {
      const volumes = await this.volumes(ctx, env, s),
        spec = {
          name: s.Container,
          image: s.Image,
          network: env.Network,
          service: s.Spec,
          volumes,
          envFile,
        };
      if (initialize) {
        const tasks = [
          ...(!s.Initialized && s.Spec.init?.length ? [s.Spec.init] : []),
          ...(s.Spec.migrate?.length ? [s.Spec.migrate] : []),
        ];
        for (const command of tasks) {
          await this.runtime.remove(ctx, `${s.Container}-task`);
          phase(ctx, `${s.Name}: running initialization/migration`);
          await this.runtime.run(ctx, {
            ...spec,
            name: `${s.Container}-task`,
            service: { ...s.Spec, command },
            task: true,
          });
        }
      }
      phase(ctx, `Starting ${s.Name}`);
      await this.runtime.run(ctx, spec);
      await this.waitReady(ctx, s);
      phase(ctx, `${s.Name}: ready`);
      s.Initialized = true;
      this.save();
    } finally {
      removeFile(envFile);
    }
  }
  async waitReady(parent: Context, s: ServiceState) {
    const controller = new AbortController(),
      signal = AbortSignal.any([parent.signal, AbortSignal.timeout(90_000), controller.signal]),
      ctx = { ...parent, signal };
    phase(ctx, `${s.Name}: waiting for readiness`);
    const logs = this.runtime.logs(ctx, s.Container).catch(() => {});
    try {
      while (true) {
        signal.throwIfAborted();
        const v = await this.runtime.inspect(ctx, s.Container);
        if (v && !v.Running)
          fail(`${s.Name} exited before becoming ready; run contremaitre logs ${s.Name}`);
        if (v?.Running && v.IP) {
          s.IP = v.IP;
          const ready =
            s.Spec.kind === "postgres"
              ? ["pg_isready", "-U", "app", "-d", "app"]
              : s.Spec.kind === "redis"
                ? ["redis-cli", "ping"]
                : s.Spec.ready;
          try {
            if (ready?.length) await this.runtime.exec(ctx, s.Container, ready, { timeout: 5000 });
            else if (s.Port && !(await tcpReady(s.IP, s.Port, signal)))
              throw Error("Port unavailable");
            return;
          } catch (e) {
            if (signal.aborted) throw e;
          }
        }
        await sleep(250, signal);
      }
    } finally {
      controller.abort();
      await logs;
    }
  }
  setMain(env: Environment) {
    this.assertRecovered(env.Identity.ID);
    this.state.Main[env.Identity.Project] = env.Identity.ID;
    this.save();
  }
  async down(ctx: Context, env: Environment, deleteData = false) {
    this.assertRecovered(env.Identity.ID);
    for (const name of keys(env.tunnels)) await this.tunnels?.stop(ctx, env, name, deleteData);
    const deleting = deleteData || env.Status === "deleting";
    env.Status = deleting ? "deleting" : "stopping";
    this.save();
    if (env.driver) {
      const reply = await invokeDriver(ctx, env, deleteData ? "delete" : "stop");
      if (reply.status !== "stopped") fail("Driver did not confirm stopped resources");
    } else {
      for (const name of keys(env.Services)) {
        const s = env.Services[name];
        await this.runtime.stop(ctx, s.Container);
        await this.runtime.remove(ctx, s.Container);
        await this.runtime.remove(ctx, `${s.Container}-task`);
        s.IP = "";
      }
    }
    env.Status = deleting ? "deleting" : "stopped";
    env.Error = "";
    env.UpdatedAt = now();
    for (const s of Object.values(env.Services)) s.IP = "";
    this.save();
    if (deleteData) {
      if (env.driver) {
        if (env.driver_directory) rmSync(env.driver_directory, { recursive: true, force: true });
      } else {
        while (env.Volumes.length) {
          await this.runtime.removeVolume(ctx, env.Volumes[0]);
          env.Volumes.shift();
          this.save();
        }
        rmSync(join(this.store.home, "data", env.Identity.ID), { recursive: true, force: true });
        await this.runtime.removeNetwork(ctx, env.Network);
        for (const image of env.Images) await this.runtime.removeImage(ctx, image);
      }
      delete this.state.Environments[env.Identity.ID];
      if (this.state.Main[env.Identity.Project] === env.Identity.ID)
        delete this.state.Main[env.Identity.Project];
      this.save();
    }
  }
  async pruneImages(ctx: Context, env: Environment) {
    this.assertRecovered(env.Identity.ID);
    const current = new Set([
      ...Object.values(env.Services).map((s) => s.Image),
      ...Object.values(env.builds ?? {}).map((b) => b.image),
    ]);
    const removed: string[] = [];
    for (const image of [...env.Images])
      if (!current.has(image)) {
        await this.runtime.removeImage(ctx, image);
        env.Images = env.Images.filter((i) => i !== image);
        removed.push(image);
        this.save();
      }
    return removed;
  }
  async recover(ctx: Context) {
    await recoverClones(this, ctx);
    for (const env of Object.values(this.state.Environments)) {
      if (env.driver) {
        if (env.Status === "running" || env.Status === "deploying")
          try {
            applyDriverReply(env, await invokeDriver(ctx, env, "status"));
          } catch (e) {
            env.Status = "failed";
            env.Error = message(e);
          }
      } else if (env.Status === "running") {
        for (const s of Object.values(env.Services)) {
          const v = await this.runtime.inspect(ctx, s.Container);
          s.IP = v?.Running ? v.IP : "";
          if (!v?.Running) {
            env.Status = "failed";
            env.Error = `${s.Name} is not running`;
          }
        }
      } else if (["deploying", "stopping"].includes(env.Status)) {
        env.Status = "failed";
        env.Error = "Interrupted operation; inspect logs before redeploying";
      }
    }
    this.save();
  }
}
