import { expect, spyOn, test } from "bun:test";
import * as fs from "node:fs/promises";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Apple } from "@contremaitre/environments/apple";
import { context } from "@contremaitre/execution/context";
import { run } from "@contremaitre/execution/process";

async function fixture(configured = true) {
  const dir = await mkdtemp(join(tmpdir(), "cm-apple-")),
    root = join(dir, "context"),
    binary = join(dir, "container");
  await mkdir(root);
  await writeFile(join(root, "Dockerfile"), "FROM scratch\n");
  await writeFile(join(dir, "configured"), String(configured));
  await writeFile(join(dir, "events"), "");
  await writeFile(
    binary,
    `#!${process.execPath}
import { appendFileSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
const dir = ${JSON.stringify(dir)}, args = process.argv.slice(2);
const event = value => appendFileSync(join(dir, 'events'), value + '\\n');
const fatal = message => { console.error(message); process.exit(1); };
const resources = () => {
  if (args[args.indexOf('--cpus') + 1] !== '4' || args[args.indexOf('--memory') + 1] !== '8589934592') fatal('builder resources changed');
};
if (args[0] === 'image' && args[1] === 'inspect') {
  event('image ' + args[2]);
  if (existsSync(join(dir, 'missing-image'))) fatal('image not found');
} else if (args[0] === 'inspect') {
  console.log(JSON.stringify([{ status: 'running', configuration: { resources: { cpus: 4, memoryInBytes: 8589934592 } } }]));
} else if (args[0] === 'builder' && args[1] === 'start') {
  resources(); event('prepare');
  if (existsSync(join(dir, 'fail-prepare'))) fatal('builder preparation failed');
  writeFileSync(join(dir, 'configured'), 'true');
} else if (args[0] === 'build') {
  resources();
  const tag = args[args.indexOf('--tag') + 1];
  event('enter ' + tag);
  // Apple build performs its own configuration reconciliation, even for a running builder.
  if (readFileSync(join(dir, 'configured'), 'utf8') !== 'true') {
    event('reconfigure ' + tag);
    try { mkdirSync(join(dir, 'deleting')); }
    catch { fatal('failed to delete container: container with ID buildkit not found'); }
    const deadline = Date.now() + 2000;
    while (readFileSync(join(dir, 'events'), 'utf8').split('enter ').length < 3 && Date.now() < deadline) await Bun.sleep(5);
    writeFileSync(join(dir, 'configured'), 'true');
    rmSync(join(dir, 'deleting'), { recursive: true });
  }
  event('build ' + tag);
  process.on('SIGTERM', () => { event('cancel ' + tag); process.exit(0); });
  while (!existsSync(join(dir, tag + '.release'))) await Bun.sleep(5);
  event('end ' + tag);
} else fatal('unexpected fake container command');
`,
    { mode: 0o700 },
  );
  const events = async () => (await readFile(join(dir, "events"), "utf8")).trim().split("\n");
  const until = async (value: string) => {
    const deadline = Date.now() + 3000;
    while (!(await events()).includes(value)) {
      if (Date.now() > deadline) throw Error(`Timed out waiting for ${value}`);
      await Bun.sleep(5);
    }
  };
  return {
    dir,
    root,
    binary,
    events,
    until,
    release: (...tags: string[]) =>
      Promise.all(tags.map((tag) => writeFile(join(dir, `${tag}.release`), ""))),
    clean: () => rm(dir, { recursive: true, force: true }),
  };
}

test("a running builder is reconciled before concurrent builds can race to recreate it", async () => {
  const f = await fixture(false),
    ctx = context(AbortSignal.timeout(5000)),
    apple = new Apple(f.binary);
  try {
    await f.release("one", "two");
    const results = await Promise.allSettled(
      ["one", "two"].map((tag) => apple.build(ctx, f.root, "Dockerfile", tag)),
    );
    expect(results.map((result) => result.status)).toEqual(["fulfilled", "fulfilled"]);
    expect((await f.events()).filter((event) => event.startsWith("reconfigure"))).toEqual([]);
    expect((await f.events()).filter((event) => event === "prepare")).toHaveLength(1);
  } finally {
    await f.clean();
  }
});

test("one deployment builds concurrently and retains its builder resources", async () => {
  const f = await fixture(),
    controller = new AbortController(),
    ctx = context(controller.signal),
    apple = new Apple(f.binary);
  const jobs = Promise.allSettled(
    ["one", "two"].map((tag) => apple.build(ctx, f.root, "Dockerfile", tag)),
  );
  try {
    await Promise.all([f.until("build one"), f.until("build two")]);
    expect((await f.events()).filter((event) => event.startsWith("end "))).toEqual([]);
    await f.release("one", "two");
    expect((await jobs).every((result) => result.status === "fulfilled")).toBe(true);
  } finally {
    controller.abort();
    await jobs;
    await f.clean();
  }
});

test("another deployment waits until the last build in the active session exits", async () => {
  const f = await fixture(),
    controller = new AbortController(),
    ctx = context(controller.signal),
    apple = new Apple(f.binary);
  const a = apple.build(ctx, f.root, "Dockerfile", "one"),
    b = apple.build(ctx, f.root, "Dockerfile", "two");
  const jobs = [a, b];
  try {
    await Promise.all([f.until("build one"), f.until("build two")]);
    const other = new Apple(f.binary).build(
      context(controller.signal),
      f.root,
      "Dockerfile",
      "three",
    );
    jobs.push(other);
    await f.release("one");
    await a;
    await Bun.sleep(200);
    expect(await f.events()).not.toContain("build three");
    expect((await f.events()).filter((event) => event === "prepare")).toHaveLength(1);
    await f.release("two");
    await f.until("build three");
    await f.release("three");
    expect((await Promise.allSettled(jobs)).every((result) => result.status === "fulfilled")).toBe(
      true,
    );
  } finally {
    controller.abort();
    await Promise.allSettled(jobs);
    await f.clean();
  }
});

test("cancelling a build releases the builder only after its subprocess exits", async () => {
  const f = await fixture(),
    cancelled = new AbortController(),
    other = new AbortController();
  const apple = new Apple(f.binary);
  const a = apple.build(context(cancelled.signal), f.root, "Dockerfile", "one");
  const resultA = Promise.allSettled([a]);
  let resultB: Promise<PromiseSettledResult<unknown>[]> | undefined;
  try {
    await f.until("build one");
    resultB = Promise.allSettled([apple.build(context(other.signal), f.root, "Dockerfile", "two")]);
    cancelled.abort();
    expect((await resultA)[0].status).toBe("rejected");
    await f.until("build two");
    const events = await f.events();
    expect(events.indexOf("cancel one")).toBeLessThan(events.lastIndexOf("prepare"));
    await f.release("two");
    expect((await resultB)[0].status).toBe("fulfilled");
  } finally {
    cancelled.abort();
    other.abort();
    await resultA;
    await resultB;
    await f.clean();
  }
});

test("failed builder preparation releases the lock and can be retried", async () => {
  const f = await fixture(),
    apple = new Apple(f.binary),
    ctx = context(AbortSignal.timeout(5000));
  try {
    await writeFile(join(f.dir, "fail-prepare"), "");
    await f.release("one", "two");
    await expect(apple.build(ctx, f.root, "Dockerfile", "one")).rejects.toThrow(
      "builder preparation failed",
    );
    await rm(join(f.dir, "fail-prepare"));
    await expect(apple.build(ctx, f.root, "Dockerfile", "two")).resolves.toMatchObject({
      image: "two",
    });
  } finally {
    await f.clean();
  }
});

test("unchanged builds reuse the existing image without creating a temporary context", async () => {
  const f = await fixture();
  const apple = new Apple(f.binary);
  try {
    await f.release("one");
    const previous = await apple.build(context(), f.root, "Dockerfile", "one");
    const staging = spyOn(fs, "mkdtemp");
    try {
      expect(await apple.build(context(), f.root, "Dockerfile", "two", previous)).toEqual(previous);
      expect(staging).not.toHaveBeenCalled();
      expect((await f.events()).filter((event) => event === "prepare")).toHaveLength(1);
    } finally {
      staging.mockRestore();
    }
  } finally {
    await f.clean();
  }
});

test("changed inputs and missing cached images still produce a fresh build snapshot", async () => {
  const f = await fixture();
  const apple = new Apple(f.binary);
  try {
    await f.release("one", "changed", "missing", "forced");
    const original = await apple.build(context(), f.root, "Dockerfile", "one");
    await writeFile(join(f.root, "new-input"), "changed");
    const changed = await apple.build(context(), f.root, "Dockerfile", "changed", original);
    expect(changed.digest).not.toBe(original.digest);
    expect(changed.image).toBe("changed");
    await writeFile(join(f.dir, "missing-image"), "");
    const missing = await apple.build(context(), f.root, "Dockerfile", "missing", changed);
    expect(missing).toEqual({ digest: changed.digest, image: "missing" });
    await rm(join(f.dir, "missing-image"));
    expect(await apple.build(context(), f.root, "Dockerfile", "forced")).toEqual({
      digest: changed.digest,
      image: "forced",
    });
    expect((await f.events()).filter((event) => event.startsWith("build "))).toEqual([
      "build one",
      "build changed",
      "build missing",
      "build forced",
    ]);
  } finally {
    await f.clean();
  }
});

test("initial source sync updates a reused volume without removing dependencies or interpreting filenames", async () => {
  const base = await mkdtemp(join(tmpdir(), "cm-cached-sync-"));
  const source = join(base, "source"),
    target = join(base, "volume");
  await mkdir(source);
  await mkdir(join(target, "node_modules"), { recursive: true });
  const unusual = "quote'$(touch INJECTED).ts";
  await writeFile(join(source, unusual), "literal filename");
  await mkdir(join(source, "shape"));
  await writeFile(join(source, "shape", "child"), "directory child");
  await writeFile(join(source, "reverse"), "now a file");
  await writeFile(join(target, "shape"), "previously a file");
  await mkdir(join(target, "reverse"));
  await writeFile(join(target, "reverse", "old"), "old child");
  await writeFile(join(target, "obsolete"), "old source");
  await writeFile(join(target, "node_modules", "cached"), "installed dependency");
  const apple = new Apple();
  apple.remove = async () => {};
  apple.run = async (ctx, spec) => {
    const script = spec.service.command?.[2] ?? "";
    const entry = Object.entries(spec.volumes).find(([, path]) => script.startsWith(`${path}/`));
    if (!entry) throw Error("Missing sync control mount");
    const local = join(entry[0], "apply.sh");
    expect((await fs.stat(local)).mode & 0o444).toBe(0o444);
    await run(ctx, ["sh", "-eu", local], { cwd: target, stdin: spec.stdin });
  };
  try {
    await apple.sync(
      context(),
      {
        name: "app",
        image: "app",
        network: "test",
        volumes: {},
        envFile: "",
        service: { kind: "app", dev: { source: ".", target } },
      },
      source,
      [unusual, "shape/child", "reverse"],
      ["obsolete", "reverse/old"],
      true,
    );
    expect(await readFile(join(target, unusual), "utf8")).toBe("literal filename");
    expect(await readFile(join(target, "shape", "child"), "utf8")).toBe("directory child");
    expect(await readFile(join(target, "reverse"), "utf8")).toBe("now a file");
    expect(await readFile(join(target, "node_modules", "cached"), "utf8")).toBe(
      "installed dependency",
    );
    await expect(fs.stat(join(target, "obsolete"))).rejects.toMatchObject({ code: "ENOENT" });
    await expect(fs.stat(join(target, "INJECTED"))).rejects.toMatchObject({ code: "ENOENT" });
  } finally {
    await rm(base, { recursive: true, force: true });
  }
});
