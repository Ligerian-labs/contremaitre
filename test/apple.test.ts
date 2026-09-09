import { expect, test } from "bun:test";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Apple } from "@contremaitre/environments/apple";
import { context } from "@contremaitre/execution/context";

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
if (args[0] === 'inspect') {
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
