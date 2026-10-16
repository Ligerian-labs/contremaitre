import { expect, test } from "bun:test";
import { mkdir, mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { context } from "@contremaitre/execution/context";
import { forkPgliteData } from "../packages/environments/src/pglite-fork.js";
import { startPglite } from "../packages/environments/src/pglite-server.js";
import { checkPgliteCleanup } from "./fixtures/pglite-resources/monitor.js";
import { freePort } from "./ports.js";

checkPgliteCleanup();

const missingHdiutil = !Bun.which("hdiutil");
if (missingHdiutil) console.log("Skipping HFS+ clonefile experiment: hdiutil is not installed");

test.skipIf(missingHdiutil)(
  "HFS+ reports copy across volumes and within the volume; APFS reports clonefile",
  async () => {
    const root = await mkdtemp(join(tmpdir(), "cm-pglite-hfs-"));
    const source = join(root, "source"),
      mount = join(root, "mnt"),
      image = join(root, "img.dmg");
    let attached = false;
    async function command(args: string[]) {
      const process = Bun.spawn(args, { stdout: "pipe", stderr: "pipe" });
      const [stdout, stderr, code] = await Promise.all([
        new Response(process.stdout).text(),
        new Response(process.stderr).text(),
        process.exited,
      ]);
      console.log(`${args.join(" ")} -> exit ${code}\n${stdout}${stderr}`);
      return code;
    }
    try {
      const server = await startPglite({ dataDir: source, port: await freePort() });
      await server.stop();
      await mkdir(mount);
      expect(
        await command([
          "hdiutil",
          "create",
          "-size",
          "600m",
          "-fs",
          "HFS+",
          "-volname",
          "cmpg",
          image,
        ]),
      ).toBe(0);
      expect(await command(["hdiutil", "attach", "-nobrowse", "-mountpoint", mount, image])).toBe(
        0,
      );
      attached = true;
      const crossCp = await command(["/bin/cp", "-c", "-R", source, join(mount, "cp-cross")]);
      await rm(join(mount, "cp-cross"), { recursive: true, force: true });
      const cross = await forkPgliteData({ source, target: join(mount, "source"), ctx: context() });
      console.log(`APFS -> HFS+: cp -c exit ${crossCp}; fork method ${cross.method}`);
      const withinCp = await command([
        "/bin/cp",
        "-c",
        "-R",
        join(mount, "source"),
        join(mount, "cp-within"),
      ]);
      await rm(join(mount, "cp-within"), { recursive: true, force: true });
      const within = await forkPgliteData({
        source: join(mount, "source"),
        target: join(mount, "fork"),
        ctx: context(),
      });
      console.log(`HFS+ -> HFS+: cp -c exit ${withinCp}; fork method ${within.method}`);
      expect(cross.method).toBe("copy");
      expect(within.method).toBe("copy");
      expect(await readFile(join(mount, "fork/PG_VERSION"), "utf8")).toBe(
        await readFile(join(source, "PG_VERSION"), "utf8"),
      );
      expect(
        (
          await forkPgliteData({
            source: join(mount, "source"),
            target: join(mount, "fork"),
            ctx: context(),
            replace: true,
          })
        ).method,
      ).toBe("copy");
      const fork = await startPglite({ dataDir: join(mount, "fork"), port: await freePort() });
      try {
        expect(fork.running).toBe(true);
      } finally {
        await fork.stop();
      }
      const apfs = await forkPgliteData({ source, target: join(root, "apfs"), ctx: context() });
      console.log(`APFS -> APFS: fork method ${apfs.method}`);
      expect(apfs.method).toBe("clonefile");
    } finally {
      if (attached) expect(await command(["hdiutil", "detach", "-force", mount])).toBe(0);
      await rm(root, { recursive: true, force: true });
    }
  },
  60_000,
);
