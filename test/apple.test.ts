import { expect, test } from "bun:test";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Apple } from "@contremaitre/environments/apple";
import { context } from "@contremaitre/execution/context";

test("separate hub runtimes share concurrent builds after builder bootstrap and preserve its resources", async () => {
  const root = await mkdtemp(join(tmpdir(), "cm-apple-")),
    binary = join(root, "container"),
    events = join(root, "events");
  try {
    await writeFile(join(root, "Dockerfile"), "FROM scratch\n");
    await writeFile(
      binary,
      `#!${process.execPath}\nimport {appendFileSync,readFileSync} from 'node:fs';const args=process.argv.slice(2);if(args[0]==='inspect')console.log(JSON.stringify([{status:"running",configuration:{resources:{cpus:4,memoryInBytes:8589934592}}}]));else if(args[0]==='build'){if(args[args.indexOf('--cpus')+1]!=='4'||args[args.indexOf('--memory')+1]!=='8589934592')process.exit(3);appendFileSync(${JSON.stringify(events)},'start\\n');const deadline=Date.now()+2000;while(readFileSync(${JSON.stringify(events)},'utf8').split('start').length<3){if(Date.now()>deadline)process.exit(4);await Bun.sleep(10);}appendFileSync(${JSON.stringify(events)},'end\\n');}else process.exit(2);`,
      { mode: 0o700 },
    );
    await Promise.all([
      new Apple(binary).build(context(), root, "Dockerfile", "one"),
      new Apple(binary).build(context(), root, "Dockerfile", "two"),
    ]);
    expect((await readFile(events, "utf8")).trim().split("\n")).toEqual([
      "start",
      "start",
      "end",
      "end",
    ]);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
