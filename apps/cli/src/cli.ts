import { homedir } from "node:os";
import { join, resolve } from "node:path";
import { Apple } from "@contremaitre/environments/apple";
import { driverProcess } from "@contremaitre/environments/driver";
import type { Environment, Request } from "@contremaitre/environments/model";
import { context, decode, fail, keys } from "@contremaitre/execution/context";
import { attempt } from "@contremaitre/hub/application";
import { serve } from "@contremaitre/hub/server";
import { operationSchema } from "@contremaitre/operations/operations";
import { initProject } from "@contremaitre/projects/init";
import { tcpProxy } from "@contremaitre/routing/proxy";
import { BunContext, BunRuntime } from "@effect/platform-bun";
import {
  Args,
  Command,
  defineCommand,
  exitCodeFor,
  Options,
  withSubcommands,
} from "@structure-ai/cli";
import { Cause, Effect, Exit, Option } from "effect";
import { attach, call, launch, projectRoot } from "./client.js";

const common = {
  home: Options.text("home").pipe(
    Options.withDefault(
      process.env.CONTREMAITRE_HOME || join(homedir(), ".local", "share", "contremaitre"),
    ),
  ),
  env: Options.text("env").pipe(Options.withDefault("")),
  branch: Options.text("branch").pipe(Options.withDefault("")),
  port: Options.integer("http-port").pipe(Options.withDefault(8080)),
  publicPort: Options.integer("public-port").pipe(Options.withDefault(0)),
  json: Options.boolean("json"),
  deleteData: Options.boolean("delete-data"),
  main: Options.boolean("main"),
  rebuild: Options.boolean("rebuild"),
  detach: Options.boolean("detach"),
  compose: Options.text("compose").pipe(Options.withDefault("")),
  offset: Options.integer("offset").pipe(Options.withDefault(0)),
};
const positional = { args: Args.text({ name: "arguments" }).pipe(Args.repeated) };
function output(json: boolean, data: unknown) {
  process.stdout.write(
    `${json ? JSON.stringify({ version: 1, data }) : typeof data === "string" ? data : JSON.stringify(data, null, 2)}\n`,
  );
}
const descriptions: Record<string, string> = {
  init: "Generate a manifest from project conventions or Compose",
  start: "Start the local hub",
  serve: "Run the hub in the foreground",
  deploy: "Deploy working files and attach to its persisted operation",
  attach: "Reconnect to an operation by ID",
  operations: "List persisted operations",
  cancel: "Cancel an operation and wait for cleanup",
  list: "List environments",
  status: "List environments",
  main: "Designate the data clone source",
  down: "Stop an environment; retain data unless --delete-data",
  prune: "Remove old builds; optionally delete stopped environments",
  stop: "Stop all environments and the hub",
  exec: "Execute a command inside a service",
  logs: "Print service logs",
  proxy: "Forward [LOCAL:]REMOTE on loopback; 0 selects a free local port",
  tunnel: "Reserve a stable URL, or status/stop/release",
  version: "Print version",
  "forward-http": "Forward loopback port 80 to 8080",
};
export function makeRoot(passthrough: readonly string[] = []) {
  const commands = Object.entries(descriptions).map(([name, description]) =>
    defineCommand({
      name,
      description,
      options: common,
      args: positional,
      handler: (o) => {
        const home = resolve(o.home);
        if (name === "serve")
          return serve({ home, port: o.port, publicPort: o.publicPort }).pipe(Effect.asVoid);
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
          switch (name) {
            case "version":
              output(o.json, "contremaitre 0.2.0");
              return;
            case "init":
              output(o.json, initProject(process.cwd(), o.compose || undefined));
              return;
            case "start":
              await launch(ctx, home, o.port, o.publicPort);
              output(o.json, "Contremaitre is running");
              return;
            case "deploy": {
              await launch(ctx, home, o.port, o.publicPort);
              const op = decode(
                operationSchema,
                await call(ctx, home, "deploy-async", req),
                "deployment operation",
              );
              process.stderr.write(
                `[contremaitre] Operation ${op.id}; reconnect with contremaitre attach ${op.id}\n`,
              );
              if (o.detach) {
                output(o.json, op);
                return;
              }
              await attach(ctx, home, op.id);
              const env = (await call(ctx, home, "resolve", {
                env: op.environmentId,
              })) as Environment;
              if (o.json) {
                output(true, env);
                return;
              }
              output(false, `${env.Identity.Name} [${env.Identity.ID}]`);
              const health = (await call(ctx, home, "health")) as { public_port: number };
              const first = keys(env.Services).find((n) => env.Services[n].HTTP);
              for (const n of keys(env.Services)) {
                const s = env.Services[n];
                if (s.HTTP)
                  output(
                    false,
                    `${n}: ${s.url || `http://${first === n ? "" : `${n}.`}${env.Identity.Host}${health.public_port === 80 ? "" : `:${health.public_port}`}`}`,
                  );
              }
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
            case "list":
            case "status": {
              const envs = (await call(ctx, home, "list", req)) as Environment[];
              if (o.json) output(true, envs);
              else
                for (const e of envs)
                  output(false, `${e.Identity.ID}\t${e.Status}\t${e.Identity.Name}`);
              return;
            }
            case "down":
            case "main":
            case "prune":
            case "stop":
              output(
                o.json,
                (await call(ctx, home, name, { ...req, env: args[0] || req.env })) ??
                  `${name} complete`,
              );
              return;
            case "tunnel": {
              if (!args[0]) fail("tunnel requires a service, status, stop or release");
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
    }),
  );
  return withSubcommands(
    defineCommand({
      name: "contremaitre",
      description: "Isolated local application environments",
      handler: () =>
        Effect.sync(() => {
          process.stdout.write("Run contremaitre --help for commands.\n");
        }),
    }),
    [commands[0], ...commands.slice(1)],
  );
}
export const root = makeRoot();
export function normalizeArguments(input: readonly string[]) {
  const separator = input.indexOf("--");
  const command = separator < 0 ? [] : input.slice(separator + 1);
  const args = [...(separator < 0 ? input : input.slice(0, separator))];
  const valued = new Set([
    "--home",
    "--env",
    "--branch",
    "--http-port",
    "--public-port",
    "--compose",
    "--offset",
    "--log-level",
  ]);
  for (let i = 0; i < args.length; i++) {
    if (valued.has(args[i])) {
      i++;
      continue;
    }
    if (!args[i].startsWith("-")) {
      const action = args.splice(i, 1)[0];
      args.unshift(action === "help" ? "--help" : action);
      break;
    }
  }
  return { args, command };
}
if (import.meta.main) {
  const normalized = normalizeArguments(process.argv.slice(2));
  process.argv = [...process.argv.slice(0, 2), ...normalized.args];
  const execute = Command.run(makeRoot(normalized.command), {
    name: "contremaitre",
    version: "0.2.0",
  });
  const app = execute(process.argv).pipe(
    Effect.tapErrorCause((cause) =>
      Effect.sync(() => {
        const code = exitCodeFor(cause);
        if (code === 64) return;
        const failure = Cause.failureOption(cause);
        const text =
          Option.isSome(failure) && failure.value instanceof Error
            ? failure.value.message
            : Cause.pretty(cause);
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
      const failure = Cause.failureOption(exit.cause);
      const error = Option.isSome(failure) ? failure.value : undefined;
      const childCode =
        error && typeof error === "object" && "exitCode" in error ? error.exitCode : undefined;
      done(
        typeof childCode === "number" && childCode > 0 && childCode <= 255
          ? childCode
          : exitCodeFor(exit.cause),
      );
    },
  });
}
