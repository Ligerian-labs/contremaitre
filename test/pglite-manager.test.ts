import { expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Manager, type PreparedDeploy } from "@contremaitre/environments/manager";
import type { Environment } from "@contremaitre/environments/model";
import { Store } from "@contremaitre/environments/store";
import { context } from "@contremaitre/execution/context";
import { parseManifest, prepareManifest } from "@contremaitre/projects/config";
import { newIdentity } from "@contremaitre/projects/model";
import { SQL } from "bun";
import { FakeRuntime } from "./fake-runtime.js";
import { checkPgliteCleanup } from "./fixtures/pglite-resources/monitor.js";

checkPgliteCleanup();

const manifest =
  "version: 1\nproject: pglite-manager\nservices:\n  db: {kind: postgres, runtime: wasm}\n";

async function scenario(home: string, method: "clonefile" | "copy") {
  const root = join(home, "project");
  mkdirSync(root);
  const apple = new FakeRuntime();
  const manager = new Manager(new Store(home), apple, 48570);
  const lines: string[] = [];
  const ctx = context(undefined, (line) => lines.push(String(line)));
  const prepare = (branch: string): PreparedDeploy => ({
    root,
    identity: newIdentity("pglite-manager", root, branch),
    manifest: prepareManifest(root, parseManifest(manifest)),
    request: {},
    sourceId: manager.state.Main["pglite-manager"],
  });
  const query = async (env: Environment, text: string) => {
    const db = env.Services.db;
    // Resolve exactly the same token that an app's DATABASE_URL would use.
    const consumer = {
      ...db,
      Name: "consumer",
      Spec: { environment: { DATABASE_URL: "{{db.url}}" } },
    };
    const url = manager.serviceEnv(env, consumer).DATABASE_URL;
    expect(url).toContain(`127.0.0.1:${db.Ports?.["5432"]}/app?sslmode=disable`);
    const sql = new SQL(url, { max: 1, prepare: false });
    try {
      return await sql.unsafe(text);
    } finally {
      await sql.close();
    }
  };
  try {
    const main = prepare("main");
    await manager.deploy(ctx, main);
    const source = manager.resolve(main.identity.ID);
    await query(source, "CREATE TABLE items (id int PRIMARY KEY)");
    await query(source, "INSERT INTO items VALUES (1)");
    const branch = prepare("branch");
    await manager.deploy(ctx, branch);
    expect(lines.join("")).toContain(
      method === "clonefile"
        ? "cloned Postgres data with clonefile"
        : "copied Postgres data (clonefile unavailable)",
    );
    const target = manager.resolve(branch.identity.ID);
    expect(await query(target, "SELECT id FROM items")).toEqual([{ id: 1 }]);
    await query(source, "INSERT INTO items VALUES (2)");
    await query(target, "INSERT INTO items VALUES (3)");
    expect(await query(source, "SELECT id FROM items ORDER BY id")).toEqual([{ id: 1 }, { id: 2 }]);
    expect(await query(target, "SELECT id FROM items ORDER BY id")).toEqual([{ id: 1 }, { id: 3 }]);
    const db = source.Services.db;
    await manager.backend(db).stop(ctx, db.Container);
    await manager.backend(db).start(ctx, db.Container);
    expect((await query(source, "SELECT count(*)::int AS n FROM items"))[0].n).toBe(2);
    lines.length = 0;
    await manager.deploy(ctx, main);
    expect((lines.join("").match(/PGlite listening/g) ?? []).length).toBeLessThanOrEqual(1);
    expect((await query(source, "SELECT count(*)::int AS n FROM items"))[0].n).toBe(2);
    const data = manager.dataDirectory(source, db);
    await manager.down(ctx, source);
    expect(existsSync(data)).toBe(true);
    lines.length = 0;
    await manager.deploy(ctx, main);
    expect((lines.join("").match(/PGlite listening/g) ?? []).length).toBeLessThanOrEqual(1);
    expect((await query(source, "SELECT count(*)::int AS n FROM items"))[0].n).toBe(2);
    await manager.down(ctx, source, true);
    expect(existsSync(data)).toBe(false);
    expect(existsSync(`${data}.pglite-log`)).toBe(false);
    await manager.down(ctx, target, true);
    expect(existsSync(manager.dataDirectory(target, target.Services.db))).toBe(false);
  } finally {
    for (const env of manager.list()) await manager.down(ctx, env, true);
    expect(apple.calls).toEqual([]);
    rmSync(home, { recursive: true, force: true });
  }
}

test(
  "real Manager deploy, file fork, restart, redeploy and explicit data deletion",
  () => scenario(mkdtempSync(join(tmpdir(), "cm-pglite-manager-")), "clonefile"),
  60000,
);

test("WASM managed postgres rejects init and migrate through manifest validation", () => {
  for (const field of ["init", "migrate"]) {
    expect(() =>
      parseManifest(manifest.replace("runtime: wasm", `runtime: wasm, ${field}: [echo, no]`)),
    ).toThrow("managed databases cannot override storage, credentials, command or initialization");
  }
});

if (!Bun.which("hdiutil")) console.log("Skipping Manager HFS+ test: hdiutil is unavailable");
test.skipIf(!Bun.which("hdiutil"))(
  "V3-F1/F5: Manager fork on HFS+ reports copy and isolates both ways",
  async () => {
    const root = mkdtempSync(join(tmpdir(), "cm-pglite-manager-hfs-"));
    const mount = join(root, "mnt");
    mkdirSync(mount);
    let attached = false;
    const command = async (args: string[]) => {
      const child = Bun.spawn(args, { stdout: "pipe", stderr: "pipe" });
      const [code, out, err] = await Promise.all([
        child.exited,
        new Response(child.stdout).text(),
        new Response(child.stderr).text(),
      ]);
      console.log(`${args.join(" ")} -> ${code}\n${out}${err}`);
      expect(code).toBe(0);
    };
    try {
      await command([
        "hdiutil",
        "create",
        "-size",
        "600m",
        "-fs",
        "HFS+",
        "-volname",
        "cmpg-manager",
        join(root, "img.dmg"),
      ]);
      await command([
        "hdiutil",
        "attach",
        "-nobrowse",
        "-mountpoint",
        mount,
        join(root, "img.dmg"),
      ]);
      attached = true;
      const home = join(mount, "home");
      mkdirSync(home);
      await scenario(home, "copy");
    } finally {
      if (attached) await command(["hdiutil", "detach", "-force", mount]);
      rmSync(root, { recursive: true, force: true });
    }
  },
  60000,
);
