import { homedir } from "node:os";
import { join } from "node:path";
import { Options } from "@structure-ai/cli";

function flag<A>(
  name: string,
  parser: Options.Options<A>,
  fallback: A,
  description: string,
  value = "",
  shared = false,
) {
  return {
    name,
    value,
    description,
    shared,
    fallback,
    parser: parser.pipe(Options.withDefault(fallback), Options.withDescription(description)),
  };
}

const flags = {
  global: flag(
    "global",
    Options.boolean("global"),
    false,
    "Install agent integration in your home directory.",
  ),
  profile: flag(
    "profile",
    Options.text("profile"),
    "smoke",
    "Verification profile. Default: smoke.",
    "NAME",
  ),
  run: flag("run", Options.text("run"), "", "Verification or deployment operation ID.", "ID"),
  check: flag("check", Options.text("check"), "", "Read diagnostics for this check.", "NAME"),
  timeout: flag(
    "timeout",
    Options.integer("timeout"),
    1800,
    "Wait deadline in seconds, 1..7200. Timeout leaves the operation running.",
    "SECONDS",
  ),
  workspace: flag(
    "workspace",
    Options.text("workspace"),
    "",
    "SaaS workspace ID. Overrides the saved selection.",
    "ID",
  ),
  noAI: flag(
    "no-ai",
    Options.boolean("no-ai"),
    false,
    "Use conventional detection without a coding agent.",
  ),
  agent: flag(
    "agent",
    Options.text("agent"),
    "",
    "Coding agent: codex, claude, pi or opencode. Overrides saved selection.",
    "NAME",
  ),
  home: flag(
    "home",
    Options.text("home"),
    process.env.CONTREMAITRE_HOME || join(homedir(), ".local", "share", "contremaitre"),
    "Hub data directory. Default: CONTREMAITRE_HOME or ~/.local/share/contremaitre.",
    "PATH",
    true,
  ),
  env: flag(
    "env",
    Options.text("env"),
    "",
    "Environment ID or name. Default: current workspace.",
    "ENV",
  ),
  branch: flag(
    "branch",
    Options.text("branch"),
    "",
    "Override the detected branch or bookmark name.",
    "NAME",
  ),
  port: flag(
    "http-port",
    Options.integer("http-port"),
    8080,
    "Hub HTTP port when starting it. Default: 8080.",
    "PORT",
  ),
  http: flag(
    "http",
    Options.boolean("http"),
    false,
    "Use legacy HTTP routing instead of local HTTPS.",
  ),
  httpsPort: flag(
    "https-port",
    Options.integer("https-port"),
    8443,
    "Local TLS listener. Default: 8443; forward port 443 to this port.",
    "PORT",
  ),
  publicPort: flag(
    "public-port",
    Options.integer("public-port"),
    0,
    "Legacy HTTP public port. Requires --http. Default: the HTTP port.",
    "PORT",
  ),
  json: flag("json", Options.boolean("json"), false, "Print the result as JSON.", "", true),
  deleteData: flag(
    "delete-data",
    Options.boolean("delete-data"),
    false,
    "Also delete retained environment data. Default: false.",
  ),
  main: flag(
    "main",
    Options.boolean("main"),
    false,
    "Designate this environment as the initial clone source.",
  ),
  rebuild: flag(
    "rebuild",
    Options.boolean("rebuild"),
    false,
    "Build again instead of reusing an unchanged image.",
  ),
  detach: flag(
    "detach",
    Options.boolean("detach").pipe(Options.withAlias("d")),
    false,
    "Return the operation immediately without following it.",
  ),
  failure: flag(
    "failure",
    Options.boolean("failure"),
    false,
    "Print logs from failed services in the latest deployment; empty after success.",
  ),
  follow: flag(
    "follow",
    Options.boolean("follow").pipe(Options.withAlias("f")),
    false,
    "Follow deployment output until completion. Default: print and exit.",
  ),
  compose: flag(
    "compose",
    Options.text("compose"),
    "",
    "Select Compose input. With --no-ai, import the supported subset.",
    "FILE",
  ),
  offset: flag(
    "offset",
    Options.integer("offset"),
    0,
    "Resume operation logs at this byte offset. Default: 0.",
    "BYTES",
  ),
};

type FlagName = keyof typeof flags;
type Group = "Environments" | "Inspect and connect" | "Operations" | "Hub and tools";
export interface CommandHelp {
  readonly name: string;
  readonly aliases?: readonly string[];
  readonly group: Group;
  readonly description: string;
  readonly usage?: string;
  readonly details?: string;
  readonly flags: readonly FlagName[];
  readonly examples: readonly string[];
}

export const commands: readonly CommandHelp[] = [
  {
    name: "agents",
    group: "Hub and tools",
    description: "Install skills and adapters or export a plugin bundle",
    usage: "install | export DIRECTORY",
    details:
      "Install defaults to this directory. --agent all supports Claude Code, Codex, OpenCode and Pi. Export writes a self-contained contremaitre plugin under an existing DIRECTORY; --agent and --global apply only to install. Both preserve existing files with different contents.",
    flags: ["agent", "global", "json"],
    examples: [
      "contremaitre agents install --agent all",
      "contremaitre agents install --agent codex --global",
      "contremaitre agents export .",
    ],
  },
  {
    name: "ensure",
    group: "Environments",
    description: "Reuse or deploy the current workspace for testing",
    details:
      "Wait quietly for readiness and return a compact result. No model is invoked. Source changes during deployment require a retry. --detach returns an operation ID.",
    flags: [
      "branch",
      "main",
      "rebuild",
      "detach",
      "timeout",
      "port",
      "publicPort",
      "http",
      "httpsPort",
      "home",
      "json",
    ],
    examples: ["contremaitre ensure --json"],
  },
  {
    name: "verify",
    group: "Environments",
    description: "Run configured checks and collect evidence",
    details:
      "Requires a current environment prepared by ensure. Missing profiles and failed checks exit nonzero. Results and artifacts persist outside the checkout.",
    flags: ["env", "branch", "profile", "detach", "timeout", "home", "json"],
    examples: ["contremaitre verify --profile smoke --json"],
  },
  {
    name: "report",
    group: "Environments",
    description: "Show preview, evidence and source freshness",
    flags: ["env", "branch", "home", "json"],
    examples: ["contremaitre report --json"],
  },
  {
    name: "status",
    group: "Environments",
    description: "Show compact status for the current workspace",
    details:
      "Includes readiness, verification and freshness. Use list to inspect every environment.",
    flags: ["env", "branch", "home", "json"],
    examples: ["contremaitre status --json"],
  },
  {
    name: "diagnose",
    group: "Operations",
    description: "Read bounded failure details",
    details:
      "Returns up to 3000 bytes and a cursor. --offset resumes without repeating output. Full logs are available on the review page.",
    flags: ["run", "check", "offset", "home", "json"],
    examples: ["contremaitre diagnose --run OPERATION_ID --json"],
  },
  {
    name: "wait",
    group: "Operations",
    description: "Wait for an operation without streaming logs",
    usage: "OPERATION_ID",
    flags: ["timeout", "home", "json"],
    examples: ["contremaitre wait OPERATION_ID --json"],
  },
  {
    name: "init",
    group: "Environments",
    description: "Create or update a project manifest",
    details:
      "Configure the development stack and save launch settings in .contremaitre.lock. --no-ai detects conventional development scripts or Dockerfiles and can resolve an existing compact apps config. Existing version 1 manifests require assisted init. Agent settings live in <home>/init.json.",
    flags: ["agent", "noAI", "compose", "home", "json"],
    examples: [
      "contremaitre init",
      "contremaitre init --agent pi",
      "contremaitre init --no-ai --compose compose.yml",
    ],
  },
  {
    name: "deploy",
    group: "Environments",
    description: "Deploy the current working files",
    details:
      "Deploy this workspace with compact service progress until readiness. Ctrl-C cancels deployment. Unchanged services stay running. New environments clone data from main. Use contremaitre deploy logs for full output.",
    flags: [
      "branch",
      "main",
      "rebuild",
      "detach",
      "port",
      "publicPort",
      "http",
      "httpsPort",
      "home",
      "json",
    ],
    examples: [
      "contremaitre deploy",
      "contremaitre deploy -d",
      "contremaitre deploy logs --failure",
      "contremaitre deploy --branch main --main",
    ],
  },
  {
    name: "show",
    group: "Environments",
    description: "Show URLs for the current workspace",
    details:
      "Print local HTTP service URLs for the current workspace and branch. Works from subdirectories. URLs use the hub's routing settings; they do not indicate service readiness. Use --json for a service-to-URL map.",
    flags: ["env", "branch", "home", "json"],
    examples: ["contremaitre show", "contremaitre show --branch main", "contremaitre show --json"],
  },
  {
    name: "list",
    group: "Environments",
    description: "List environments",
    flags: ["home", "json"],
    examples: ["contremaitre list", "contremaitre list --json"],
  },
  {
    name: "main",
    group: "Environments",
    description: "Choose the environment to clone data from",
    usage: "[ENV]",
    details:
      "Designate an existing environment as the project's data clone source. ENV overrides --env; without either, use the current workspace.",
    flags: ["env", "branch", "home", "json"],
    examples: ["contremaitre main", "contremaitre main --env shop/main"],
  },
  {
    name: "down",
    group: "Environments",
    description: "Stop an environment, keeping its data",
    usage: "[ENV]",
    details:
      "Stop the selected environment. ENV overrides --env; without either, use the current workspace. --delete-data also deletes databases, uploads, images, and tunnel reservations.",
    flags: ["env", "branch", "deleteData", "home", "json"],
    examples: ["contremaitre down", "contremaitre down --env shop/feature"],
  },
  {
    name: "prune",
    group: "Environments",
    description: "Remove old builds",
    details:
      "Remove superseded build images across environments. --delete-data also deletes stopped environments that have no tunnel reservations.",
    flags: ["deleteData", "home", "json"],
    examples: ["contremaitre prune", "contremaitre prune --delete-data"],
  },
  {
    name: "logs",
    group: "Inspect and connect",
    description: "Show service logs",
    usage: "SERVICE",
    flags: ["env", "branch", "home"],
    examples: ["contremaitre logs api", "contremaitre logs api --env shop/main"],
  },
  {
    name: "exec",
    group: "Inspect and connect",
    description: "Run a command inside a service",
    usage: "SERVICE -- COMMAND [ARG...]",
    details:
      "Arguments after -- go to the service command, including flags such as --help. The CLI preserves the command's exit status.",
    flags: ["env", "branch", "home"],
    examples: ["contremaitre exec api -- node scripts/migrate.js", "contremaitre exec web -- sh"],
  },
  {
    name: "proxy",
    group: "Inspect and connect",
    description: "Forward a local port to a service",
    usage: "SERVICE [LOCAL:]REMOTE",
    details:
      "Listen on loopback and forward to the service port. Omit LOCAL or use 0 to choose a free local port.",
    flags: ["env", "branch", "home", "json"],
    examples: ["contremaitre proxy postgres 15432:5432", "contremaitre proxy postgres 0:5432"],
  },
  {
    name: "tunnel",
    group: "Inspect and connect",
    description: "Share a live preview until this command exits",
    usage: "[login | status | stop | release SERVICE]",
    details:
      "Share all HTTP services in the current environment. Keep this command open; Ctrl-C ends sharing and restores local URL configuration. Branch changes also stop sharing. Services may restart. With no custom provider, use contremaitre.ligerianlabs.fr and sign in through your browser. login authenticates without starting a preview. status lists reservations; stop ends the session; release retires a service URL.",
    flags: ["workspace", "env", "branch", "home", "json"],
    examples: [
      "contremaitre tunnel",
      "contremaitre tunnel login",
      "contremaitre tunnel --workspace my-team",
      "contremaitre tunnel status",
      "contremaitre tunnel stop",
      "contremaitre tunnel release web",
    ],
  },
  {
    name: "operations",
    group: "Operations",
    description: "List operations",
    flags: ["home", "json"],
    examples: ["contremaitre operations", "contremaitre operations --json"],
  },
  {
    name: "attach",
    group: "Operations",
    description: "Follow operation progress",
    usage: "OPERATION_ID",
    details:
      "Reconnect to a persisted operation and follow it until completion. --json formats the final result; progress still goes to stderr.",
    flags: ["offset", "home", "json"],
    examples: [
      "contremaitre attach OPERATION_ID",
      "contremaitre attach OPERATION_ID --offset 1024",
    ],
  },
  {
    name: "cancel",
    group: "Operations",
    description: "Cancel an operation",
    usage: "OPERATION_ID",
    details: "Cancel an operation and wait for its cleanup to finish.",
    flags: ["home", "json"],
    examples: ["contremaitre cancel OPERATION_ID", "contremaitre cancel OPERATION_ID --json"],
  },
  {
    name: "self-install",
    group: "Hub and tools",
    description: "Install this binary and upgrade a running hub",
    usage: "DIRECTORY",
    details:
      "Used by the download installer. Requires the compiled CLI. A stopped hub stays stopped; a running hub restarts with its existing ports and environments.",
    flags: ["home"],
    examples: ["./contremaitre self-install ~/.local/bin"],
  },
  {
    name: "start",
    group: "Hub and tools",
    description: "Start the hub in the background",
    flags: ["port", "publicPort", "http", "httpsPort", "home", "json"],
    examples: ["contremaitre start", "contremaitre start --http --http-port 18080"],
  },
  {
    name: "stop",
    group: "Hub and tools",
    description: "Stop the hub and all environments",
    details:
      "Stop all environments and shut down the hub. Retain environment data for the next deployment.",
    flags: ["home", "json"],
    examples: ["contremaitre stop", "contremaitre stop --home /tmp/contremaitre"],
  },
  {
    name: "serve",
    group: "Hub and tools",
    description: "Run the hub in the foreground",
    flags: ["port", "publicPort", "http", "httpsPort", "home"],
    examples: ["contremaitre serve", "contremaitre serve --http --http-port 18080"],
  },
  {
    name: "forward-https",
    group: "Hub and tools",
    description: "Forward local port 443 to the TLS hub",
    details:
      "Bridge loopback port 443 to 8443 until interrupted. For permanent forwarding use https-service install. Run this foreground forwarder with sudo; run the hub as your normal user.",
    flags: ["httpsPort", "json"],
    examples: ["sudo contremaitre forward-https", "contremaitre start"],
  },
  {
    name: "https-service",
    group: "Hub and tools",
    description: "Manage background HTTPS forwarding",
    usage: "install|status|uninstall",
    details:
      "Install or update the macOS service that forwards port 443 to the TLS hub. Installation and removal request administrator authentication once. Status needs no privileges. The service starts at boot and remains available across hub restarts. Use the compiled CLI.",
    flags: ["httpsPort", "json"],
    examples: [
      "contremaitre https-service install",
      "contremaitre https-service status",
      "contremaitre https-service uninstall",
    ],
  },
  {
    name: "forward-http",
    group: "Hub and tools",
    description: "Forward local port 80 to 8080",
    details:
      "Bridge loopback port 80 to 8080 until interrupted. Port 80 requires elevated privileges; run the hub separately without sudo.",
    flags: ["json"],
    examples: ["sudo contremaitre forward-http", "contremaitre start --http --public-port 80"],
  },
  {
    name: "version",
    group: "Hub and tools",
    description: "Print the version",
    flags: ["json"],
    examples: ["contremaitre version", "contremaitre version --json"],
  },
];

export const deployLogsHelp: CommandHelp = {
  name: "logs",
  group: "Operations",
  description: "Print the latest deployment logs",
  details:
    "Print the latest deployment's build, migration and readiness logs for the current workspace. Use --follow to wait for new output. Container runtime logs are available through contremaitre logs SERVICE.",
  flags: ["home", "branch", "env", "failure", "follow"],
  examples: [
    "contremaitre deploy logs",
    "contremaitre deploy logs --failure",
    "contremaitre deploy logs -f",
  ],
};

export function optionsFor(command: Pick<CommandHelp, "flags">) {
  function option<A>(key: FlagName, spec: { parser: Options.Options<A>; fallback: A }) {
    return command.flags.includes(key)
      ? spec.parser
      : Options.none.pipe(Options.map(() => spec.fallback));
  }
  return {
    workspace: option("workspace", flags.workspace),
    noAI: option("noAI", flags.noAI),
    agent: option("agent", flags.agent),
    home: option("home", flags.home),
    env: option("env", flags.env),
    branch: option("branch", flags.branch),
    port: option("port", flags.port),
    http: option("http", flags.http),
    httpsPort: option("httpsPort", flags.httpsPort),
    publicPort: option("publicPort", flags.publicPort),
    json: option("json", flags.json),
    deleteData: option("deleteData", flags.deleteData),
    main: option("main", flags.main),
    rebuild: option("rebuild", flags.rebuild),
    detach: option("detach", flags.detach),
    failure: option("failure", flags.failure),
    follow: option("follow", flags.follow),
    compose: option("compose", flags.compose),
    offset: option("offset", flags.offset),
    global: option("global", flags.global),
    profile: option("profile", flags.profile),
    run: option("run", flags.run),
    check: option("check", flags.check),
    timeout: option("timeout", flags.timeout),
  };
}

const builtins = [
  { name: "help", value: "", description: "Show help for this command." },
  { name: "version", value: "", description: "Print the version." },
  {
    name: "completions",
    value: "SHELL",
    description: "Generate shell completions: sh, bash, fish, zsh.",
  },
  {
    name: "log-level",
    value: "LEVEL",
    description: "Minimum log level: all, trace, debug, info, warning, error, fatal, none.",
  },
  { name: "wizard", value: "", description: "Build a command interactively." },
];
const valuedFlags = new Set(
  [...Object.values(flags), ...builtins]
    .filter((flag) => flag.value)
    .map((flag) => `--${flag.name}`),
);

export function normalizeArguments(input: readonly string[]) {
  const separator = input.indexOf("--");
  const command = separator < 0 ? [] : input.slice(separator + 1);
  const args = [...(separator < 0 ? input : input.slice(0, separator))];
  function actionIndex() {
    for (let i = 0; i < args.length; i++) {
      if (valuedFlags.has(args[i])) i++;
      else if (!args[i].startsWith("-")) return i;
    }
    return -1;
  }
  let index = actionIndex();
  if (index >= 0 && args[index] === "help") {
    args.splice(index, 1);
    args.push("--help");
    index = actionIndex();
  }
  if (index >= 0) args.unshift(...args.splice(index, 1));
  if (args[0] === "deploy") {
    for (let i = 1; i < args.length; i++) {
      if (valuedFlags.has(args[i])) {
        i++;
        continue;
      }
      if (args[i].startsWith("-")) continue;
      if (args[i] === "logs") args.splice(1, 0, ...args.splice(i, 1));
      break;
    }
  }
  return { args, command };
}

class UsageError extends Error {
  readonly exitCode = 64;
}

// Inspect only Contremaitre's arguments. Tokens after -- belong to the child.
export function helpRequest(args: readonly string[]): string | undefined {
  const nested = args[0] === "deploy" && args[1] === "logs";
  const name = nested ? "deploy logs" : args[0]?.startsWith("-") ? undefined : args[0];
  const command =
    name === "deploy logs"
      ? deployLogsHelp
      : commands.find((command) => command.name === name || command.aliases?.includes(name ?? ""));
  if (name && !command) throw new UsageError(`Unknown command '${name}'. Run contremaitre --help.`);
  const supported = [
    ...(command?.flags ?? (["home", "json"] as const)).map((key) => flags[key]),
    ...builtins,
    { name: "h", value: "" },
  ];
  let help = args.length === 0;
  for (let i = nested ? 2 : name ? 1 : 0; i < args.length; i++) {
    const token = args[i];
    if (!token.startsWith("-")) continue;
    let [key] = token.split("=", 1);
    if (key === "-d") key = "--detach";
    if (key === "-f") key = "--follow";
    const spec = supported.find((flag) => (flag.name === "h" ? "-h" : `--${flag.name}`) === key);
    if (!spec)
      throw new UsageError(
        `Unknown flag '${key}'${name ? ` for ${name}` : ""}. Run contremaitre${name ? ` ${name}` : ""} --help.`,
      );
    if (spec.value && !token.includes("=")) i++;
    if ((key === "--help" || key === "-h") && (token === key || token === `${key}=true`))
      help = true;
  }
  return help ? renderHelp(name) : undefined;
}

function wrap(text: string, width: number, first = "", rest = first): string[] {
  const lines: string[] = [];
  let prefix = first;
  let content = "";
  for (let word of text.split(/\s+/)) {
    if (prefix.length + content.length + word.length + (content ? 1 : 0) > width && content) {
      lines.push(prefix + content);
      prefix = rest;
      content = "";
    }
    while (word.length > width - prefix.length) {
      const count = width - prefix.length;
      lines.push(prefix + word.slice(0, count));
      word = word.slice(count);
      prefix = rest;
    }
    if (word) content += `${content ? " " : ""}${word}`;
  }
  if (content) lines.push(prefix + content);
  return lines;
}

export function renderHelp(name?: string) {
  const columns = Number(process.env.COLUMNS);
  const width = Math.max(
    40,
    Math.min(
      80,
      process.stdout.columns || (Number.isFinite(columns) && columns > 0 ? columns : 80),
    ),
  );
  const lines: string[] = [];
  const paragraph = (text: string) => lines.push(...wrap(text, width));
  const rows = (items: readonly (readonly [string, string])[], minimum = 0) => {
    const labelWidth = Math.min(24, Math.max(minimum, ...items.map(([label]) => label.length)));
    const indent = " ".repeat(labelWidth + 4);
    for (const [label, description] of items) {
      const prefix = `  ${label.padEnd(labelWidth)}  `;
      lines.push(...wrap(description, width, prefix, indent));
    }
  };
  const command =
    name === "deploy logs"
      ? deployLogsHelp
      : commands.find((command) => command.name === name || command.aliases?.includes(name ?? ""));
  if (!command) {
    paragraph("Usage: contremaitre <command> [flags]");
    for (const group of ["Environments", "Inspect and connect", "Operations", "Hub and tools"]) {
      lines.push(`${group}:`);
      rows(
        commands
          .filter((command) => command.group === group)
          .sort((a, b) => Number(b.name === "init") - Number(a.name === "init"))
          .map((command) => [
            [command.name, ...(command.aliases ?? [])].join(", "),
            command.description,
          ]),
        12,
      );
    }
    paragraph('Use "contremaitre <command> --help" for flags and examples.');
    paragraph('Use "contremaitre --completions SHELL" for shell completions.');
  } else {
    paragraph(`Usage: contremaitre ${name} [flags]${command.usage ? ` ${command.usage}` : ""}`);
    lines.push("");
    paragraph(command.details ?? command.description);
    if (command.aliases) paragraph(`Aliases: ${[command.name, ...command.aliases].join(", ")}`);
    lines.push("", "Examples:");
    for (const example of command.examples) lines.push(...wrap(example, width, "  ", "    "));
    const selected = command.flags.map((key) => flags[key]);
    for (const shared of [false, true]) {
      const entries: (readonly [string, string])[] = selected
        .filter((flag) => flag.shared === shared)
        .map(
          (flag) =>
            [
              `${flag.name === "detach" ? "-d, " : flag.name === "follow" ? "-f, " : ""}--${flag.name}${flag.value ? ` ${flag.value}` : ""}`,
              flag.description,
            ] as const,
        );
      if (shared)
        entries.push(
          ...builtins.map(
            (flag) =>
              [
                flag.name === "help"
                  ? "-h, --help"
                  : `--${flag.name}${flag.value ? ` ${flag.value}` : ""}`,
                flag.description,
              ] as const,
          ),
        );
      if (entries.length) {
        lines.push("", shared ? "Shared flags:" : "Flags:");
        rows(entries, 19);
      }
    }
  }
  return `${lines.join("\n")}\n`;
}
