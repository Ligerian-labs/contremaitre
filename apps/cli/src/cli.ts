import { helpRequest, normalizeArguments } from "./help.js";
import { version } from "./version.js";

export { normalizeArguments } from "./help.js";

if (import.meta.main) {
  const normalized = normalizeArguments(process.argv.slice(2));
  let help: string | undefined;
  if (normalized.args.length === 1 && normalized.args[0] === "--version") {
    process.stdout.write(`${version}\n\n`);
  } else {
    try {
      help = helpRequest(normalized.args);
    } catch {}
    if (help !== undefined) process.stdout.write(help);
    else {
      const { run } = await import("./run.js");
      run(normalized);
    }
  }
}
