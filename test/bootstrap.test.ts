import { expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { mkdir, mkdtemp, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

async function bootstrap(
  options: {
    corrupt?: boolean;
    failure?: boolean;
    platform?: string;
    version?: string;
    release?: string;
    arch?: string;
    uid?: number;
    truncated?: boolean;
  } = {},
) {
  const dir = await mkdtemp(join(tmpdir(), "cm-bootstrap-"));
  const bin = join(dir, "bin");
  const destination = join(dir, "install with spaces");
  const artifact =
    '#!/bin/sh\n[ "$1" = self-install ] || exit 42\nmkdir -p "$2"\ncp "$0" "$2/contremaitre"\n';
  try {
    await mkdir(bin);
    await mkdir(destination);
    await writeFile(join(destination, "contremaitre"), "old binary");
    await writeFile(join(dir, "artifact"), artifact);
    await writeFile(
      join(dir, "checksum"),
      `${options.corrupt ? "0".repeat(64) : createHash("sha256").update(artifact).digest("hex")}  contremaitre-darwin-arm64\n`,
    );
    for (const [name, contents] of Object.entries({
      uname: `#!/bin/sh\n[ "$1" = -s ] && echo ${options.platform ?? "Darwin"} || echo ${options.arch ?? "arm64"}\n`,
      sw_vers: `#!/bin/sh\necho ${options.version ?? "26.0"}\n`,
      id: `#!/bin/sh\necho ${options.uid ?? 501}\n`,
      curl: `#!/bin/sh
echo "$*" >> "$FIXTURE/requests"
out=''
while [ "$#" -gt 0 ]; do
  case "$1" in
    -o) out=$2; shift ;;
    https://*) url=$1 ;;
  esac
  shift
done
case "$url" in
  */releases/latest) printf '%s' 'https://github.com/Ligerian-labs/contremaitre/releases/tag/v0.2.0' ;;
  */v0.2.0/contremaitre-darwin-arm64.sha256) cp "$FIXTURE/checksum" "$out" ;;
  */v0.2.0/contremaitre-darwin-arm64) ${options.failure ? "exit 22" : 'cp "$FIXTURE/artifact" "$out"'} ;;
  *) exit 43 ;;
esac
`,
    }))
      await writeFile(join(bin, name), contents, { mode: 0o755 });
    const script = await readFile(resolve("scripts/install.sh"), "utf8");
    const command = Bun.spawn(["sh"], {
      stdin: new Blob([
        options.truncated ? script.slice(0, script.indexOf("  chmod 700")) : script,
      ]),
      stdout: "pipe",
      stderr: "pipe",
      env: {
        ...process.env,
        PATH: `${bin}:/usr/bin:/bin`,
        HOME: dir,
        TMPDIR: dir,
        FIXTURE: dir,
        CONTREMAITRE_INSTALL_DIR: destination,
        CONTREMAITRE_VERSION: options.release ?? "",
      },
    });
    const [code, stdout, stderr] = await Promise.all([
      command.exited,
      new Response(command.stdout).text(),
      new Response(command.stderr).text(),
    ]);
    expect((await readdir(dir)).filter((name) => name.startsWith("contremaitre-install."))).toEqual(
      [],
    );
    return {
      code,
      stdout,
      stderr,
      binary: await readFile(join(destination, "contremaitre"), "utf8"),
      requests: await readFile(join(dir, "requests"), "utf8").catch(() => ""),
    };
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

test("piped installer resolves one release and installs a verified binary into a path with spaces", async () => {
  const result = await bootstrap();
  expect(result.code).toBe(0);
  expect(result.binary).toStartWith("#!/bin/sh");
  expect(result.requests).toContain("/releases/latest");
  expect(result.stdout).toContain("PATH");
});

test("pinned installation skips latest-release resolution", async () => {
  const result = await bootstrap({ release: "v0.2.0" });
  expect(result.code).toBe(0);
  expect(result.binary).toStartWith("#!/bin/sh");
  expect(result.requests).not.toContain("/releases/latest");
});

test("bad checksums and failed downloads preserve the installed CLI", async () => {
  for (const options of [{ corrupt: true }, { failure: true }]) {
    const result = await bootstrap(options);
    expect(result.code).not.toBe(0);
    expect(result.binary).toBe("old binary");
  }
});

test("unsupported systems, root and invalid release names fail before downloading", async () => {
  for (const options of [
    { platform: "Linux" },
    { arch: "x86_64" },
    { version: "15.0" },
    { uid: 0 },
    { release: "../../main" },
  ]) {
    const result = await bootstrap(options);
    expect(result.code).not.toBe(0);
    expect(result.requests).toBe("");
    expect(result.binary).toBe("old binary");
  }
});

test("a truncated installer never executes its partial function body", async () => {
  const result = await bootstrap({ truncated: true });
  expect(result.code).not.toBe(0);
  expect(result.requests).toBe("");
  expect(result.binary).toBe("old binary");
});
