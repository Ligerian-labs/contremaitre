import { resolve } from "node:path";
import { Apple } from "@contremaitre/environments/apple";
import { driverProcess } from "@contremaitre/environments/driver";
import type { Environment, Request } from "@contremaitre/environments/model";
import { context, decode, fail } from "@contremaitre/execution/context";
import { attempt } from "@contremaitre/execution/effect";
import { serve } from "@contremaitre/hub/server";
import { operationSchema } from "@contremaitre/operations/operations";
import { tcpProxy } from "@contremaitre/routing/proxy";
import { BunContext, BunRuntime } from "@effect/platform-bun";
import { Args, Command, defineCommand, withSubcommands } from "@structure-ai/cli";
import { Effect, Exit } from "effect";
import { AgentResultError, agentCommand } from "./agents.js";
import { attach, call, deploymentLogs, launch, projectRoot } from "./client.js";
import { deploy } from "./deploy.js";
import { commandFailure } from "./errors.js";
import {
  type CommandHelp,
  commands as commandHelp,
  deployLogsHelp,
  helpRequest,
  normalizeArguments,
  optionsFor,
  renderHelp,
  UsageError,
} from "./help.js";
import { manageHttpsService } from "./https-service.js";
import { initialize } from "./init.js";
import { installBinary } from "./install.js";
import { exportAgents, installAgents } from "./install-agents.js";
import { formatEnvironments, selectEnvironments } from "./list.js";
import { onboard, terminalOnboarding } from "./saas.js";
import { tunnel } from "./tunnel.js";
import { tunnelLogs } from "./tunnel-logs.js";
import { version } from "./version.js";

export { normalizeArguments } from "./help.js";

function output(json: boolean, data: unknown) {
  process.stdout.write(
    `${json ? JSON.stringify({ version: 1, data }) : typeof data === "string" ? data : JSON.stringify(data, null, 2)}\n`,
  );
}
export function makeRoot(passthrough: readonly string[] = []) {
  const definitions = commandHelp.flatMap((definition) =>
    [definition.name, ...(definition.aliases ?? [])].map((name) => ({ ...definition, name })),
  );
  const buildCommand = ({ name, ...definition }: CommandHelp, action = name) =>
    defineCommand({
      name,
      description: definition.description,
      options: optionsFor(definition),
      args: {
        args: definition.usage
          ? Args.text({ name: definition.usage }).pipe(Args.repeated)
          : Args.none.pipe(Args.map((): string[] => [])),
      },
      handler: (o) => {
        const home = resolve(o.home);
        if (action === "deploy")
          return deploy(
            home,
            { root: projectRoot(), branch: o.branch, main: o.main, rebuild: o.rebuild },
            o,
          );
        if (
          action === "tunnel" &&
          o.args[0] === "login" &&
          o.args.length === 1 &&
          !passthrough.length
        )
          return attempt(async (signal) => {
            const provider = await onboard(
              home,
              signal,
              { workspace: o.workspace, login: true },
              { ui: terminalOnboarding(o.json) },
            );
            output(o.json, { provider, authenticated: true });
          });
        if (action === "tunnel" && !o.args.length && !passthrough.length)
          return tunnel(
            home,
            { root: projectRoot(), branch: o.branch, env: o.env },
            o.json,
            o.workspace,
          );
        if (name === "serve")
          return serve({
            home,
            port: o.port,
            publicPort: o.publicPort,
            httpsPort: o.http ? undefined : o.httpsPort,
          }).pipe(Effect.asVoid);
        return attempt(async (signal) => {
          if (o.port < 1 || o.port > 65535 || o.publicPort < 0 || o.publicPort > 65535)
            fail("Invalid HTTP port");
          const ctx = context(signal, (data) => process.stderr.write(data)),
            args = [...o.args, ...passthrough],
            req: Request = {
              root: projectRoot(),
              branch: o.branch,
              env: o.env,
              delete_data: o.deleteData,
              main: o.main,
              rebuild: o.rebuild,
            };
          if (["ensure", "verify", "report", "status", "diagnose", "wait"].includes(action)) {
            const result = await agentCommand(ctx, home, action, req, o, args);
            output(o.json, result.data);
            if (result.failed) throw new AgentResultError();
            return;
          }
          switch (action) {
            case "agents":
              if (args.length === 2 && args[0] === "export") {
                if (o.agent || o.global) fail("agents export does not accept --agent or --global");
                output(o.json, exportAgents(args[1]));
                return;
              }
              if (args.length !== 1 || args[0] !== "install")
                fail("Use contremaitre agents install --agent NAME or agents export DIRECTORY");
              output(o.json, installAgents(process.cwd(), o.agent || "all", o.global));
              return;
            case "https-service":
              if (args.length !== 1) fail("https-service requires install, status or uninstall");
              output(o.json, await manageHttpsService(ctx, args[0], o.httpsPort));
              return;
            case "self-install":
              if (args.length !== 1) fail("self-install requires an installation directory");
              if (!Bun.main.startsWith("/$bunfs/")) fail("self-install requires the compiled CLI");
              await installBinary(
                context(AbortSignal.any([signal, AbortSignal.timeout(400_000)]), ctx.log),
                process.execPath,
                resolve(args[0], "contremaitre"),
                home,
              );
              return;
            case "version":
              output(o.json, `contremaitre ${version}`);
              return;
            case "init":
              output(
                o.json,
                await initialize(ctx, process.cwd(), home, {
                  noAI: o.noAI,
                  agent: o.agent || undefined,
                  compose: o.compose || undefined,
                  json: o.json,
                }),
              );
              return;
            case "start":
              await launch(ctx, home, o.port, o.publicPort, o.http ? undefined : o.httpsPort);
              output(o.json, "Contremaitre is running");
              return;
            case "deploy-logs": {
              const op = decode(
                operationSchema,
                await call(ctx, home, "deployment", req),
                "latest deployment",
              );
              await deploymentLogs(
                context(signal, (data) => {
                  process.stdout.write(data);
                }),
                home,
                op.id,
                { failure: o.failure, follow: o.follow },
              );
              return;
            }
            case "attach":
              if (args.length !== 1) fail("attach requires an operation ID");
              output(o.json, await attach(ctx, home, args[0], o.offset));
              return;
            case "operations":
              output(o.json, await call(ctx, home, "operations"));
              return;
            case "cancel":
              if (args.length !== 1) fail("cancel requires an operation ID");
              output(o.json, await call(ctx, home, "cancel", { id: args[0] }));
              return;
            case "show": {
              if (o.json) {
                output(true, await call(ctx, home, "show", req));
                return;
              }
              const env = (await call(ctx, home, "resolve", req)) as Environment;
              const urls = (await call(ctx, home, "show", {
                env: env.Identity.ID,
              })) as Record<string, string>;
              output(false, `Environment: ${env.Identity.Name} (${env.Identity.ID})`);
              output(false, `Workspace: ${env.Root}`);
              output(false, `Hub data: ${home}`);
              if (env.driver_directory) output(false, `Driver directory: ${env.driver_directory}`);
              output(false, "");
              if (!Object.keys(urls).length)
                output(false, "No HTTP service URLs for this environment.");
              else
                for (const [service, url] of Object.entries(urls))
                  output(false, `${service}\t${url}`);
              const quote = (value: string) =>
                /^[a-zA-Z0-9_./-]+$/.test(value) ? value : `'${value.replaceAll("'", "'\\''")}'`;
              const selection = `--env ${quote(env.Identity.ID)} --home ${quote(home)}`;
              output(false, "\nApplication logs:");
              if (!Object.keys(env.Services).length) output(false, "No deployed services.");
              for (const service of Object.keys(env.Services).sort())
                output(false, `contremaitre logs ${quote(service)} ${selection}`);
              output(false, "\nDeployment logs:");
              output(false, `contremaitre deploy logs ${selection}`);
              return;
            }
            case "list": {
              const envs = selectEnvironments((await call(ctx, home, "list")) as Environment[], {
                status: o.status,
                project: o.project,
                branch: o.listBranch,
              });
              if (o.json) output(true, envs);
              else if (envs.length) output(false, formatEnvironments(envs));
              return;
            }
            case "prune":
              output(
                o.json,
                await call(ctx, home, "prune", {
                  delete_data: o.deleteData,
                  ...(args.length ? { envs: args } : {}),
                }),
              );
              return;
            case "down":
            case "main":
            case "stop":
              output(
                o.json,
                (await call(ctx, home, name, { ...req, env: args[0] || req.env })) ??
                  `${name} complete`,
              );
              return;
            case "tunnel": {
              if (
                !["status", "logs", "stop", "release"].includes(args[0]) ||
                args.length > (["release", "logs"].includes(args[0]) ? 2 : 1)
              )
                fail(
                  "Use contremaitre tunnel to share all HTTP services, or tunnel login, status, logs [SERVICE], stop, release SERVICE",
                );
              if (args[0] === "logs") {
                const env = (await call(ctx, home, "resolve", req)) as Environment;
                const logs = await tunnelLogs(home, env, args[1]);
                if (o.json) output(true, logs);
                else if (!Object.keys(logs).length)
                  output(false, "No HTTP services have tunnel logs.");
                else
                  for (const [service, log] of Object.entries(logs)) {
                    output(false, `[${service}] ${log.path}`);
                    if (log.truncated)
                      output(false, "Showing the last 64 KiB; full log is at the path above.");
                    if (!log.exists) output(false, `No tunnel logs recorded for ${service}.`);
                    else if (!log.output)
                      output(false, `No connector diagnostics recorded for ${service}.`);
                    else
                      process.stdout.write(
                        log.output.endsWith("\n") ? log.output : `${log.output}\n`,
                      );
                  }
                return;
              }
              if (args[0] === "status") {
                const env = (await call(ctx, home, "resolve", req)) as Environment;
                output(o.json, env.tunnels);
                return;
              }
              const stopping = ["stop", "release"].includes(args[0]);
              if (args[0] === "release" && !args[1]) fail("tunnel release requires a service");
              const result = await call(ctx, home, stopping ? `tunnel-${args[0]}` : "tunnel", {
                ...req,
                service: stopping ? args[1] : args[0],
              });
              output(o.json, !stopping && !o.json ? (result as { URL: string }).URL : result);
              return;
            }
            case "exec":
            case "logs":
            case "proxy": {
              if (!args[0]) fail(`${name} requires a service`);
              const env = (await call(ctx, home, "resolve", req)) as Environment,
                s = env.Services[args[0]];
              if (!s) fail(`Service ${args[0]} not found`);
              const command = args.slice(1).filter((arg, i) => !(i === 0 && arg === "--"));
              if (name === "exec" && !command.length) fail("exec requires a command after --");
              const io = {
                stdin: process.stdin,
                stdout: (data: Buffer) => {
                  process.stdout.write(data);
                },
                stderr: (data: Buffer) => {
                  process.stderr.write(data);
                },
                timeout: 2_147_483_647,
              };
              if (env.driver) {
                await driverProcess(ctx, env, name, undefined, args[0], command, io);
                return;
              }
              const runtime = new Apple();
              if (name === "exec") {
                await runtime.exec(ctx, s.Container, command, io);
                return;
              }
              if (name === "logs") {
                await runtime.output(ctx, ["logs", s.Container], {
                  stdout: io.stdout,
                  stderr: io.stderr,
                });
                return;
              }
              if (command.length !== 1) fail("proxy requires [LOCAL:]REMOTE");
              const parts = command[0].split(":");
              if (parts.length > 2 || parts.some((p) => !/^\d+$/.test(p)))
                fail("Invalid port mapping");
              const local = parts.length === 2 ? Number(parts[0]) : 0,
                remote = Number(parts.at(-1));
              if (local > 65535 || remote < 1 || remote > 65535) fail("Invalid port mapping");
              await tcpProxy(
                ctx,
                local,
                remote,
                async () => {
                  const value = await runtime.inspect(ctx, s.Container);
                  if (!value?.Running) fail("Service is not running");
                  return value.IP;
                },
                (port) => output(o.json, { address: `127.0.0.1:${port}`, remote_port: remote }),
              );
              return;
            }
            case "forward-https":
              if (o.httpsPort < 1024 || o.httpsPort > 65535)
                fail("HTTPS forwarding target must be 1024..65535");
              await tcpProxy(
                ctx,
                443,
                o.httpsPort,
                async () => "127.0.0.1",
                () => output(o.json, `Forwarding 127.0.0.1:443 to 127.0.0.1:${o.httpsPort}`),
              );
              return;
            case "forward-http":
              await tcpProxy(
                ctx,
                80,
                8080,
                async () => "127.0.0.1",
                () => output(o.json, "Forwarding 127.0.0.1:80 to 127.0.0.1:8080"),
              );
              return;
          }
        });
      },
    });
  const commands = definitions.map((definition) =>
    definition.name === "deploy"
      ? withSubcommands(buildCommand(definition), [buildCommand(deployLogsHelp, "deploy-logs")])
      : buildCommand(definition),
  );
  return withSubcommands(
    defineCommand({
      name: "contremaitre",
      description: "Isolated local application environments",
      handler: () =>
        Effect.sync(() => {
          process.stdout.write(renderHelp());
        }),
    }),
    [commands[0], ...commands.slice(1)],
  );
}
export const root = makeRoot();
if (import.meta.main) {
  const normalized = normalizeArguments(process.argv.slice(2));
  process.argv = [...process.argv.slice(0, 2), ...normalized.args];
  const execute = Command.run(makeRoot(normalized.command), {
    name: "contremaitre",
    version,
  });
  const app = Effect.suspend(() => {
    try {
      return Effect.succeed(helpRequest(normalized.args));
    } catch (error) {
      return error instanceof UsageError ? Effect.fail(error) : Effect.die(error);
    }
  }).pipe(
    Effect.flatMap((help) =>
      help === undefined
        ? execute(process.argv)
        : Effect.sync(() => {
            process.stdout.write(help);
          }),
    ),
    Effect.tapErrorCause((cause) =>
      Effect.sync(() => {
        const { text } = commandFailure(cause);
        if (text === undefined) return;
        if (normalized.args.includes("--json"))
          process.stdout.write(`${JSON.stringify({ version: 1, error: text })}\n`);
        else process.stderr.write(`contremaitre: ${text}\n`);
      }),
    ),
    Effect.provide(BunContext.layer),
  );
  BunRuntime.runMain(app, {
    disableErrorReporting: true,
    disablePrettyLogger: true,
    teardown: (exit, done) => {
      if (Exit.isSuccess(exit)) {
        done(0);
        return;
      }
      done(commandFailure(exit.cause).code);
    },
  });
}
