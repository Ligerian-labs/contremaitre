import { createReadStream } from "node:fs";
import * as fs from "node:fs/promises";
import { basename, join } from "node:path";
import { type Context, fail } from "@contremaitre/execution/context";
import { run } from "@contremaitre/execution/process";
import type { Runtime } from "./apple.js";
import type { RunSpec } from "./runtimes.js";

export async function syncSource(
  runtime: Runtime,
  ctx: Context,
  spec: RunSpec,
  directory: string,
  changed: string[],
  removed: string[],
  initial: boolean,
) {
  const target = spec.service.dev?.target;
  if (!target) fail("Source sync requires dev.target");
  const temp = await fs.mkdtemp(join(directory, "../archive-"));
  try {
    const archive = join(temp, "source.tar"),
      list = join(temp, "files");
    await fs.writeFile(list, changed.map((p) => `./${p}\0`).join(""));
    await run(ctx, ["tar", "--no-xattrs", "-cf", archive, "-C", directory, "--null", "-T", list], {
      env: { ...process.env, COPYFILE_DISABLE: "1" },
    });
    const command = ["sh", "-eu", "-c", 'mkdir -p "$1"; tar -xf - -C "$1"', "sync", target];
    const removeDeleted = 'for p do if [ ! -d "$p" ]; then rm -f -- "$p"; fi; done';
    const replaceShapes =
      // biome-ignore lint/suspicious/noTemplateCurlyInString: POSIX shell parameter expansion must remain literal.
      'for p do if [ -d "$p" ]; then rm -rf -- "$p"; fi; d=${p%/*}; while [ ! -d "$d" ]; do if [ -e "$d" ]; then rm -f -- "$d"; break; fi; d=${d%/*}; d=${d:-/}; done; done';
    if (initial) {
      // A reused source volume retains dependencies and generated files. Remove
      // deleted tracked inputs and resolve file/directory changes before extraction.
      const quote = (value: string) => `'${value.replaceAll("'", "'\\''")}'`;
      const script: string[] = [];
      for (const [paths, action] of [
        [removed, removeDeleted],
        [changed, replaceShapes],
      ] as const)
        for (let i = 0; i < paths.length; i += 100)
          script.push(
            `set -- ${paths
              .slice(i, i + 100)
              .map((p) => quote(join(target, p)))
              .join(" ")}; ${action}`,
          );
      script.push(`mkdir -p ${quote(target)}; tar -xf - -C ${quote(target)}`);
      // The image may run as a non-root user. The parent state directory remains private.
      await fs.chmod(temp, 0o755);
      await fs.writeFile(join(temp, "apply.sh"), script.join("\n"), { mode: 0o644 });
      const control = join("/tmp", basename(temp));
      await runtime.remove(ctx, `${spec.name}-sync`);
      await runtime.run(ctx, {
        ...spec,
        name: `${spec.name}-sync`,
        task: true,
        stdin: createReadStream(archive),
        volumes: { ...spec.volumes, [temp]: control },
        service: {
          ...spec.service,
          working_dir: target,
          command: ["sh", "-eu", join(control, "apply.sh")],
        },
      });
    } else {
      for (let i = 0; i < removed.length; i += 100)
        await runtime.exec(ctx, spec.name, [
          "sh",
          "-eu",
          "-c",
          removeDeleted,
          "sync",
          ...removed.slice(i, i + 100).map((p) => join(target, p)),
        ]);
      for (let i = 0; i < changed.length; i += 100)
        await runtime.exec(ctx, spec.name, [
          "sh",
          "-eu",
          "-c",
          replaceShapes,
          "sync",
          ...changed.slice(i, i + 100).map((p) => join(target, p)),
        ]);
      if (changed.length)
        await runtime.exec(ctx, spec.name, command, { stdin: createReadStream(archive) });
    }
  } finally {
    await fs.rm(temp, { recursive: true, force: true });
  }
}
