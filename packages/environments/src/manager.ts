import { randomBytes, randomUUID } from "node:crypto";
import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync } from "node:fs";
import { join, resolve } from "node:path";
import {
  type Context,
  context,
  fail,
  hash,
  keys,
  message,
  now,
  phase,
  progress,
  serviceContext,
} from "@contremaitre/execution/context";
import { privateEnv, removeFile } from "@contremaitre/execution/files";
import { Semaphore } from "@contremaitre/execution/locks";
import { sleep } from "@contremaitre/execution/sleep";
import {
  detectIdentity,
  loadManifest,
  order,
  prepareManifest,
  projectName,
  readEnv,
  safePath,
} from "@contremaitre/projects/config";
import type { Identity, Manifest } from "@contremaitre/projects/model";
import { type RunSpec, type Runtime, tcpReady } from "./apple.js";
import { cloneData, cloneDriver, recoverClones } from "./clone.js";
import { DevelopmentSource } from "./development.js";
import { applyDriverReply, invokeDriver, snapshotDriver } from "./driver.js";
import {
  type Environment,
  httpEndpoints,
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
  configurationLog?: string[];
}
export interface TunnelHooks {
  stop(ctx: Context, env: Environment, name: string, release: boolean): Promise<void>;
  running(id: string, name: string): boolean;
  sharing?(id: string): boolean;
}
export class Manager {
  private readonly sourceWatchers = new Map<string, { stop: () => Promise<void> }>();
  async stopDevelopment(container?: string) {
    for (const [name, watcher] of this.sourceWatchers)
      if (!container || name === container) {
        this.sourceWatchers.delete(name);
        await watcher.stop();
      }
  }
  private watchDevelopment(s: ServiceState, spec: RunSpec, source: DevelopmentSource) {
    const controller = new AbortController();
    const ctx = {
      ...context(controller.signal, (data) => process.stderr.write(data)),
      processDirectory: join(this.store.home, "processes"),
    };
    let timer: ReturnType<typeof setTimeout> | undefined,
      active = Promise.resolve();
    const tick = async () => {
      try {
        const changes = await source.refresh(ctx);
        if (changes.changed.length || changes.removed.length) {
          await this.runtime.sync(
            ctx,
            spec,
            source.directory,
            changes.changed,
            changes.removed,
            false,
          );
          source.acknowledge();
        }
        const changed =
          s.dependencies_changed !== changes.dependenciesChanged || !!s.development_error;
        if (changes.dependenciesChanged && !s.dependencies_changed)
          phase(ctx, `${s.Name}: dependencies changed; run contremaitre deploy`);
        s.dependencies_changed = changes.dependenciesChanged;
        s.development_error = "";
        if (changed) this.save();
      } catch (e) {
        if (!controller.signal.aborted && s.development_error !== message(e)) {
          s.development_error = message(e);
          phase(ctx, `${s.Name}: source sync failed: ${s.development_error}`);
          this.save();
        }
      } finally {
        if (!controller.signal.aborted) {
          timer = setTimeout(() => {
            active = tick().catch((error) => {
              ctx.log(`${s.Name}: cannot record source sync state: ${message(error)}\n`);
            });
          }, 1000);
          timer.unref();
        }
      }
    };
    timer = setTimeout(() => {
      active = tick().catch((error) => {
        ctx.log(`${s.Name}: cannot record source sync state: ${message(error)}\n`);
      });
    }, 1000);
    timer.unref();
    this.sourceWatchers.set(s.Container, {
      stop: async () => {
        controller.abort();
        if (timer) clearTimeout(timer);
        await active;
      },
    });
  }
  readonly state: State;
  tunnels?: TunnelHooks;
  onSave: () => void = () => {};
  constructor(
    readonly store: Store,
    readonly runtime: Runtime,
    readonly httpPort = 8080,
    readonly protocol: "http" | "https" = "http",
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
    return detectIdentity(ctx, root, projectName(root), branch);
  }
  async prepare(ctx: Context, request: Request): Promise<PreparedDeploy> {
    const root = resolve(request.root ?? process.cwd());
    const configurationLog: string[] = [];
    const manifest = prepareManifest(
      root,
      loadManifest(root, {
        refresh: true,
        log: (event) => {
          configurationLog.push(event);
          ctx.log(event);
        },
      }),
    );
    const identity = await detectIdentity(ctx, root, manifest.project, request.branch);
    return {
      root,
      manifest,
      identity,
      request,
      sourceId: this.state.Main[identity.Project],
      configurationLog,
    };
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
    for (const event of p.configurationLog ?? []) ctx.log(event);
    const { root, identity, manifest, request } = p;
    let env = this.state.Environments[identity.ID];
    if (this.tunnels?.sharing?.(identity.ID) || env?.tunnel_configuration)
      fail("Stop the tunnel session before redeploying this environment", "conflict");
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
      const driver = serviceContext(ctx, "driver");
      delete env.source;
      env.generation = randomUUID();
      this.save();
      try {
        await this.deployDriver(driver, env, request, p.sourceId);
        progress(driver, "ready", "ready");
      } catch (error) {
        driver.log(`${message(error)}\n`);
        progress(driver, ctx.signal.aborted ? "cancelled" : "failed", message(error));
        throw error;
      }
      return;
    }
    if (!env) {
      env = this.fresh(identity, root);
      this.state.Environments[identity.ID] = env;
    }
    if (request.main || (identity.Branch === "main" && !this.state.Main[identity.Project]))
      this.state.Main[identity.Project] = identity.ID;
    delete env.source;
    env.generation = randomUUID();
    this.save();
    const e = env,
      previousStatus = e.Status;
    let mutated = false;
    const names = order(manifest.services);
    const scopes = Object.fromEntries(names.map((name) => [name, serviceContext(ctx, name)]));
    const errors: string[] = [];
    const failed = new Set<string>();
    const sources = new Map<string, Promise<DevelopmentSource | undefined>>();
    const attemptService = async (name: string, work: () => Promise<void>) => {
      try {
        ctx.signal.throwIfAborted();
        await work();
      } catch (error) {
        const text = `${name}: ${message(error)}`;
        scopes[name].log(`${text}\n`);
        progress(scopes[name], ctx.signal.aborted ? "cancelled" : "failed", message(error));
        failed.add(name);
        errors.push(text);
      }
    };
    try {
      for (const name of names) {
        const spec = manifest.services[name];
        if (
          spec.kind !== "app" &&
          spec.depends_on?.some((dep) => manifest.services[dep].kind === "app")
        )
          fail(`${name}: infrastructure services cannot depend on apps`);
      }
      const images: Record<string, string> = {};
      const builds = await Promise.allSettled(
        names.map((name) =>
          attemptService(name, async () => {
            const s = manifest.services[name];
            if (!s.build) {
              progress(scopes[name], "waiting", "waiting for builds");
              images[name] = s.image ?? "";
              return;
            }
            const tag = `cm-${identity.ID}-${name}:${Date.now()}${randomBytes(3).toString("hex")}`;
            e.Images.push(tag);
            this.save();
            phase(scopes[name], "building");
            const built = await this.runtime.build(
              scopes[name],
              safePath(root, s.build),
              safePath(root, s.dockerfile || join(s.build, "Dockerfile")),
              tag,
              request.rebuild ? undefined : e.builds?.[name],
            );
            e.builds ??= {};
            e.builds[name] = built;
            images[name] = built.image;
            if (tag !== built.image) e.Images = e.Images.filter((i) => i !== tag);
            this.save();
            progress(scopes[name], "waiting", "build complete");
          }),
        ),
      );
      const buildError = builds.find((result) => result.status === "rejected");
      if (buildError?.status === "rejected") throw buildError.reason;
      ctx.signal.throwIfAborted();
      if (errors.length) fail(errors.join("; "));
      // Every required build must succeed before touching the current deployment.
      for (const [name, old] of Object.entries(e.Services)) {
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
      const previous = e.Services;
      const previousRoot = e.Root;
      const services: Environment["Services"] = Object.fromEntries(
        names.map((name) => {
          const s = manifest.services[name],
            old = previous[name];
          return [
            name,
            {
              Name: name,
              Container: resourceName(e.Network, name),
              Image: images[name],
              IP: old?.IP ?? "",
              Volume: old?.Volume ?? "",
              Port: s.port || s.endpoints?.[keys(s.endpoints)[0]] || 0,
              HTTP: !!s.http || Object.keys(s.endpoints ?? {}).length > 0,
              Spec: s,
              Initialized: old?.Initialized ?? false,
            },
          ];
        }),
      );
      const candidate = { ...e, Root: root, Services: services };
      const retained = new Set<string>();
      const inspections = new Semaphore(4);
      const reusable = await Promise.allSettled(
        names.map(async (name) => {
          const old = previous[name],
            s = services[name];
          if (
            !old?.deployment ||
            s.Spec.dev ||
            request.rebuild ||
            !e.CloneComplete ||
            old.deployment !== this.deploymentFingerprint(candidate, s)
          )
            return false;
          return inspections.use(ctx.signal, async () => {
            const inspected = await this.runtime.inspect(scopes[name], old.Container);
            return !!inspected?.Running && !!inspected.IP && inspected.IP === old.IP;
          });
        }),
      );
      const inspectionError = reusable.find((result) => result.status === "rejected");
      if (inspectionError?.status === "rejected") throw inspectionError.reason;
      // Inspection can overlap; retaining a dependent still requires its dependencies to be retained.
      for (const [index, name] of names.entries()) {
        const result = reusable[index],
          s = services[name];
        if (
          result.status === "fulfilled" &&
          result.value &&
          !s.Spec.depends_on?.some((dep) => !retained.has(dep))
        ) {
          retained.add(name);
          s.deployment = previous[name].deployment;
          s.ready = true;
        }
      }
      ctx.signal.throwIfAborted();
      const changing = names.filter((name) => !retained.has(name));
      const removing = keys(previous).filter((name) => !retained.has(name));
      mutated = changing.length > 0 || removing.length > 0;
      e.Status = "deploying";
      e.Error = "";
      this.save();
      if (mutated) {
        phase(ctx, `Preparing network for ${identity.Name}`);
        await this.runtime.network(ctx, e.Network);
        // Settle all cleanup calls before proceeding or releasing the environment lock.
        const stopped = await Promise.allSettled(
          removing.map(async (name) => {
            const scope = scopes[name] ?? serviceContext(ctx, name),
              s = previous[name];
            if (scopes[name]) phase(scope, "stopping previous process");
            s.ready = false;
            this.save();
            await this.stopDevelopment(s.Container);
            await this.runtime.stop(scope, s.Container);
            await this.runtime.remove(scope, s.Container);
            await this.runtime.remove(scope, `${s.Container}-task`);
            await this.runtime.remove(scope, `${s.Container}-sync`);
          }),
        );
        const error = stopped.find((result) => result.status === "rejected");
        if (error?.status === "rejected") throw error.reason;
        if (!retained.size && keys(previous).length) {
          await this.runtime.removeNetwork(ctx, e.Network);
          await this.runtime.network(ctx, e.Network);
        }
      }
      for (const name of changing) services[name].IP = "";
      e.Services = services;
      e.Root = root;
      this.save();
      // Host source scans do not need live dependency addresses. Start them while
      // infrastructure and prerequisite applications are becoming ready.
      const sourceSlots = new Semaphore(4);
      for (const name of names.filter((name) => services[name].Spec.dev)) {
        sources.set(
          name,
          (async () => {
            let source: DevelopmentSource | undefined;
            await attemptService(name, async () => {
              source = await sourceSlots.use(ctx.signal, () =>
                this.prepareDevelopment(scopes[name], e, services[name], true),
              );
            });
            return source;
          })(),
        );
      }
      const tasks = new Map<string, Promise<void>>();
      const startGroup = async (apps: boolean) => {
        for (const name of names.filter((name) => (services[name].Spec.kind === "app") === apps)) {
          const s = services[name],
            scope = scopes[name];
          if (failed.has(name)) continue;
          const dependencies = s.Spec.depends_on ?? [];
          progress(
            scope,
            "waiting",
            dependencies.length ? `waiting for ${dependencies.join(", ")}` : "waiting to start",
          );
          tasks.set(
            name,
            (async () => {
              await Promise.all(dependencies.map((dep) => tasks.get(dep)));
              const source = await sources.get(name);
              if (failed.has(name)) return;
              if (dependencies.some((dep) => failed.has(dep))) {
                failed.add(name);
                progress(
                  scope,
                  "blocked",
                  `blocked by ${dependencies.filter((dep) => failed.has(dep)).join(", ")}`,
                );
                return;
              }
              await attemptService(name, async () => {
                if (retained.has(name)) {
                  await this.waitReady(scope, s);
                  progress(
                    scope,
                    "ready",
                    "unchanged",
                    s.HTTP ? this.localURL(e, name) : undefined,
                  );
                } else {
                  await this.startService(scope, e, s, apps, {
                    source,
                    resetSource:
                      !!request.rebuild ||
                      previousRoot !== root ||
                      !previous[name]?.deployment ||
                      !previous[name]?.Spec.dev ||
                      previous[name].Image !== s.Image ||
                      hash(JSON.stringify(previous[name].Spec)) !== hash(JSON.stringify(s.Spec)),
                  });
                  s.deployment = this.deploymentFingerprint(e, s);
                  this.save();
                  progress(scope, "ready", "ready", s.HTTP ? this.localURL(e, name) : undefined);
                }
              });
            })(),
          );
        }
        const finished = await Promise.allSettled(tasks.values());
        const error = finished.find((result) => result.status === "rejected");
        if (error?.status === "rejected") throw error.reason;
        ctx.signal.throwIfAborted();
      };
      await startGroup(false);
      if (!e.CloneComplete) {
        const source = this.state.Environments[p.sourceId ?? ""];
        if (source && source !== e) {
          if (errors.length) fail(errors.join("; "));
          if (source.driver) fail("Cannot clone between native and driver environments");
          phase(ctx, `Forking data from ${source.Identity.Name}`);
          await cloneData(this, ctx, source, e);
        }
        e.CloneComplete = true;
        this.save();
      }
      await startGroup(true);
      if (errors.length) fail(errors.join("; "));
      e.Status = "running";
      e.Error = "";
      e.UpdatedAt = now();
      this.save();
    } catch (error) {
      await Promise.allSettled(sources.values());
      e.Error = message(error);
      e.Status = mutated ? "failed" : previousStatus;
      e.UpdatedAt = now();
      this.save();
      throw error;
    }
  }
  private deploymentFingerprint(env: Environment, s: ServiceState): string {
    return hash(
      JSON.stringify([
        s.Image,
        s.Spec,
        this.serviceEnv(env, s),
        (s.Spec.depends_on ?? []).map((name) => [
          name,
          env.Services[name]?.IP,
          env.Services[name]?.Port,
        ]),
      ]),
    );
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
    name = this.endpointName(env, name);
    const driverURL = env.Services[name]?.url;
    if (driverURL && this.protocol === "http") return driverURL;
    const first = keys(httpEndpoints(env))[0];
    const host = driverURL
      ? new URL(driverURL).hostname
      : `${first === name ? "" : `${name}.`}${env.Identity.Host}`;
    const defaultPort = this.protocol === "https" ? 443 : 80;
    return `${this.protocol}://${host}${this.httpPort === defaultPort ? "" : `:${this.httpPort}`}`;
  }
  browserURL(env: Environment, name: string) {
    name = this.endpointName(env, name);
    return env.tunnel_configuration?.urls[name] ?? this.localURL(env, name);
  }
  private endpointName(env: Environment, name: string) {
    const endpoints = httpEndpoints(env);
    return endpoints[name]
      ? name
      : (keys(endpoints).find((endpoint) => endpoints[endpoint].service.Name === name) ?? name);
  }
  async configureTunnel(ctx: Context, env: Environment, urls: Record<string, string>) {
    if (env.driver)
      fail("Foreground sharing requires native services; drivers cannot apply URL configuration");
    const before = new Map(
      keys(env.Services).map((name) => [name, this.deploymentFingerprint(env, env.Services[name])]),
    );
    const pending = new Set(env.tunnel_configuration?.pending ?? []);
    env.tunnel_configuration = { urls, pending: [...pending] };
    for (const name of keys(env.Services)) {
      const service = env.Services[name];
      if (
        service.Spec.kind === "app" &&
        before.get(name) !== this.deploymentFingerprint(env, service)
      )
        pending.add(name);
    }
    env.tunnel_configuration.pending = [...pending];
    this.save();
    // Persist restart intent before replacing any process, including on rollback.
    const controller = new AbortController();
    const scope = { ...ctx, signal: AbortSignal.any([ctx.signal, controller.signal]) };
    const configuration = env.tunnel_configuration;
    const slots = new Semaphore(4);
    const tasks = new Map<string, Promise<void>>();
    for (const name of order(
      Object.fromEntries(keys(env.Services).map((n) => [n, env.Services[n].Spec])),
    )) {
      const service = env.Services[name];
      tasks.set(
        name,
        (async () => {
          await Promise.all((service.Spec.depends_on ?? []).map((dep) => tasks.get(dep)));
          if (service.Spec.kind !== "app") return;
          await slots.use(scope.signal, async () => {
            if (!pending.has(name) && before.get(name) === this.deploymentFingerprint(env, service))
              return;
            pending.add(name);
            configuration.pending = [...pending];
            service.ready = false;
            this.save();
            await this.stopDevelopment(service.Container);
            await this.runtime.stop(scope, service.Container);
            await this.runtime.remove(scope, service.Container);
            await this.startService(scope, env, service, false);
            scope.signal.throwIfAborted();
            service.deployment = this.deploymentFingerprint(env, service);
            pending.delete(name);
            configuration.pending = [...pending];
            this.save();
          });
        })().catch((error) => {
          controller.abort(error);
          throw error;
        }),
      );
    }
    // Rollback must not race a sibling that is still stopping or starting a container.
    await Promise.allSettled(tasks.values());
    scope.signal.throwIfAborted();
    if (!keys(urls).length) delete env.tunnel_configuration;
    this.save();
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
        .replaceAll("{{contremaitre.url}}", this.browserURL(env, s.Name))
        .replaceAll("{{contremaitre.local_url}}", this.localURL(env, s.Name))
        .replace(
          /\{\{([a-z][a-z0-9-]*)\.(host|port|url|local_url|browser_url|browser_origins)\}\}/g,
          (_token, name: string, property: string) => {
            const endpoint = httpEndpoints(env)[name];
            const dep = endpoint?.service ?? env.Services[name];
            if (property === "browser_origins") {
              if (!endpoint) fail(`${s.Name}: browser_origins requires HTTP service ${name}`);
              return JSON.stringify([
                ...new Set(
                  [this.localURL(env, name), this.browserURL(env, name)].map(
                    (url) => new URL(url).origin,
                  ),
                ),
              ]);
            }
            if (property === "browser_url") {
              if (!endpoint) fail(`${s.Name}: browser_url requires HTTP service ${name}`);
              return this.browserURL(env, name);
            }
            if (dep && property === "local_url") return this.localURL(env, name);
            const ip = dep === s ? "127.0.0.1" : dep?.IP;
            if (!dep || !ip) fail(`${s.Name}: ${name} is not ready; declare depends_on`);
            const port = endpoint?.port ?? dep.Port;
            if (property === "host") return ip;
            if (property === "port") return String(port);
            const host = `${ip.includes(":") ? `[${ip}]` : ip}:${port}`;
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
    values.CONTREMAITRE_URL = this.browserURL(env, s.Name);
    values.CONTREMAITRE_ORIGINS = JSON.stringify([
      ...new Set(
        [this.localURL(env, s.Name), this.browserURL(env, s.Name)].map(
          (url) => new URL(url).origin,
        ),
      ),
    ]);
    const publicURL = env.tunnel_configuration?.urls[this.endpointName(env, s.Name)];
    if (publicURL) values.CONTREMAITRE_PUBLIC_URL = publicURL;
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
  private async prepareDevelopment(
    ctx: Context,
    env: Environment,
    s: ServiceState,
    initialize: boolean,
  ) {
    if (!s.Spec.dev) return fail("Development source requires dev configuration");
    phase(ctx, "preparing development source");
    const source = new DevelopmentSource(
      env.Root,
      join(this.store.home, "sources", env.Identity.ID, s.Name),
      s.Spec.dev,
    );
    await source.load();
    await source.refresh(ctx, initialize);
    return source;
  }
  async startService(
    ctx: Context,
    env: Environment,
    s: ServiceState,
    initialize: boolean,
    options: { source?: DevelopmentSource; resetSource?: boolean } = {},
  ) {
    ctx = serviceContext(ctx, s.Name);
    phase(ctx, `resources: ${s.Spec.cpus ?? 1} CPU, ${s.Spec.memory ?? "512M"} memory`);
    const envFile = privateEnv(join(this.store.home, "tmp"), this.serviceEnv(env, s));
    try {
      await this.stopDevelopment(s.Container);
      const volumes = await this.volumes(ctx, env, s),
        spec = {
          name: s.Container,
          image: s.Image,
          network: env.Network,
          service: s.Spec,
          volumes,
          envFile,
        };
      let source: DevelopmentSource | undefined;
      if (s.Spec.dev) {
        const volume = `${s.Container}-source`;
        if (!env.Volumes.includes(volume)) {
          env.Volumes.push(volume);
          this.save();
        }
        if (options.resetSource ?? initialize) await this.runtime.removeVolume(ctx, volume);
        await this.runtime.volume(ctx, volume);
        volumes[volume] = s.Spec.dev.target;
        source = options.source ?? (await this.prepareDevelopment(ctx, env, s, initialize));
        phase(ctx, "copying development source");
        await this.runtime.sync(
          ctx,
          spec,
          source.directory,
          source.paths(),
          source.removedPaths(),
          true,
        );
        source.acknowledge();
      }
      if (initialize) {
        const tasks = [
          ...(s.Spec.dev?.install?.length ? [s.Spec.dev.install] : []),
          ...(!s.Initialized && s.Spec.init?.length ? [s.Spec.init] : []),
          ...(s.Spec.migrate?.length ? [s.Spec.migrate] : []),
        ];
        for (const command of tasks) {
          await this.runtime.remove(ctx, `${s.Container}-task`);
          phase(
            ctx,
            command === s.Spec.dev?.install
              ? "installing development dependencies"
              : "running initialization/migration",
          );
          await this.runtime.run(ctx, {
            ...spec,
            name: `${s.Container}-task`,
            service: {
              ...s.Spec,
              command,
              working_dir: command === s.Spec.dev?.install ? s.Spec.dev.target : s.Spec.working_dir,
            },
            task: true,
          });
        }
      }
      phase(ctx, "starting");
      await this.runtime.run(ctx, spec);
      await this.waitReady(ctx, s);
      phase(ctx, "ready");
      s.Initialized = true;
      this.save();
      if (source) this.watchDevelopment(s, spec, source);
    } finally {
      removeFile(envFile);
      if (ctx.signal.aborted) {
        // Killing the host CLI does not guarantee that its temporary task VM stopped.
        await this.runtime.remove(
          context(AbortSignal.timeout(15_000), ctx.log),
          `${s.Container}-task`,
        );
        if (s.Spec.dev)
          await this.runtime.remove(
            context(AbortSignal.timeout(15_000), ctx.log),
            `${s.Container}-sync`,
          );
      }
    }
  }
  async waitReady(parent: Context, s: ServiceState) {
    s.ready = false;
    const controller = new AbortController(),
      signal = AbortSignal.any([parent.signal, AbortSignal.timeout(90_000), controller.signal]),
      ctx = serviceContext({ ...parent, signal }, s.Name);
    phase(ctx, "waiting for readiness");
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
            if (ready?.length)
              await this.runtime.exec(ctx, s.Container, ready, {
                timeout: 5000,
                stdout: ctx.log,
                stderr: ctx.log,
              });
            else if (s.Port && !(await tcpReady(s.IP, s.Port, signal)))
              throw Error("Port unavailable");
            for (const port of Object.values(s.Spec.endpoints ?? {}))
              if (!(await tcpReady(s.IP, port, signal)))
                throw Error(`Endpoint port ${port} unavailable`);
            s.ready = true;
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
    if (this.tunnels?.sharing?.(env.Identity.ID))
      fail("Stop the tunnel session before stopping this environment", "conflict");
    const deleting = deleteData || env.Status === "deleting";
    env.Status = deleting ? "deleting" : "stopping";
    this.save();
    for (const s of Object.values(env.Services)) await this.stopDevelopment(s.Container);
    for (const name of keys(env.tunnels)) await this.tunnels?.stop(ctx, env, name, deleteData);
    if (env.driver) {
      const reply = await invokeDriver(ctx, env, deleteData ? "delete" : "stop");
      if (reply.status !== "stopped") fail("Driver did not confirm stopped resources");
    } else {
      for (const name of keys(env.Services)) {
        const s = env.Services[name];
        await this.runtime.stop(ctx, s.Container);
        await this.runtime.remove(ctx, s.Container);
        await this.runtime.remove(ctx, `${s.Container}-task`);
        await this.runtime.remove(ctx, `${s.Container}-sync`);
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
        rmSync(join(this.store.home, "sources", env.Identity.ID), { recursive: true, force: true });
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
      for (const reservation of Object.values(env.tunnels ?? {})) {
        reservation.Desired = false;
        reservation.Connected = false;
      }
      if (env.tunnel_configuration) {
        try {
          await this.configureTunnel(ctx, env, {});
          if (env.Error.startsWith("Tunnel ")) {
            env.Status = "running";
            env.Error = "";
          }
        } catch (error) {
          env.Status = "failed";
          env.Error = `Tunnel configuration recovery failed: ${message(error)}`;
        }
      }
    }

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
          } else if (s.Spec.dev) {
            await this.stopDevelopment(s.Container);
            const source = new DevelopmentSource(
              env.Root,
              join(this.store.home, "sources", env.Identity.ID, s.Name),
              s.Spec.dev,
            );
            await source.load();
            this.watchDevelopment(
              s,
              {
                name: s.Container,
                image: s.Image,
                network: env.Network,
                service: s.Spec,
                volumes: {},
                envFile: "",
              },
              source,
            );
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
