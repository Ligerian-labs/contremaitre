import { Options } from "@structure-ai/cli";
import { type CommandHelp, type FlagName, flags, type Parser } from "./help.js";

export function optionsFor(command: Pick<CommandHelp, "flags">) {
  function option<A>(
    key: FlagName,
    spec: { name: string; parser: Parser; fallback: A; description: string },
  ) {
    if (!command.flags.includes(key)) return Options.none.pipe(Options.map(() => spec.fallback));
    const parser = spec.parser;
    let option: Options.Options<unknown>;
    switch (parser.kind) {
      case "choices":
        option = Options.choice(spec.name, parser.values).pipe(Options.repeated);
        break;
      case "text":
        option = Options.text(spec.name);
        break;
      case "integer":
        option = Options.integer(spec.name);
        break;
      case "boolean":
        option = Options.boolean(spec.name);
        break;
    }
    if ("alias" in parser && parser.alias) option = option.pipe(Options.withAlias(parser.alias));
    return (option as Options.Options<A>).pipe(
      Options.withDefault(spec.fallback),
      Options.withDescription(spec.description),
    );
  }
  return {
    status: option("status", flags.status),
    project: option("project", flags.project),
    listBranch: option("listBranch", flags.listBranch),
    workspace: option("workspace", flags.workspace),
    endpoint: option("endpoint", flags.endpoint),
    caFile: option("caFile", flags.caFile),
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
    updateCheck: option("updateCheck", flags.updateCheck),
    timeout: option("timeout", flags.timeout),
  };
}
