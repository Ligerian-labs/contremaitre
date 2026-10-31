import { expect, spyOn, test } from "bun:test";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Docker } from "@contremaitre/environments/docker";
import { context } from "@contremaitre/execution/context";
import { serviceRuntime } from "@contremaitre/projects/model";

test("native runtime defaults follow the host and explicit runtimes win", () => {
  expect(serviceRuntime({}, "linux")).toBe("docker");
  expect(serviceRuntime({}, "darwin")).toBe("apple");
  expect(serviceRuntime({ runtime: "wasm" }, "linux")).toBe("wasm");
  expect(serviceRuntime({ runtime: "docker" }, "darwin")).toBe("docker");
});

test("Docker inspection decodes state and bridge address and distinguishes missing from denied", async () => {
  const docker = new Docker();
  const output = spyOn(docker, "output").mockResolvedValue(
    Buffer.from(
      JSON.stringify([
        {
          State: { Running: true },
          NetworkSettings: { Networks: { private: { IPAddress: "172.19.0.2" } } },
        },
      ]),
    ),
  );
  try {
    expect(await docker.inspect(context(), "web")).toEqual({ Running: true, Host: "172.19.0.2" });
    output.mockRejectedValueOnce(Error("Error: No such container: web"));
    expect(await docker.inspect(context(), "web")).toBeUndefined();
    output.mockRejectedValueOnce(Error("permission denied"));
    await expect(docker.inspect(context(), "web")).rejects.toThrow("permission denied");
  } finally {
    output.mockRestore();
  }
});

test("Docker creates bridge networks and removes only named resources with Docker commands", async () => {
  const docker = new Docker();
  const output = spyOn(docker, "output").mockResolvedValue(Buffer.from("[]"));
  try {
    output.mockRejectedValueOnce(Error("network private not found"));
    await docker.network(context(), "private");
    await docker.removeNetwork(context(), "private");
    await docker.removeVolume(context(), "data");
    await docker.removeImage(context(), "image");
    expect(output.mock.calls.map((c) => c[1])).toEqual([
      ["network", "inspect", "private"],
      [
        "network",
        "create",
        "--driver",
        "bridge",
        "--label",
        "dev.contremaitre.managed=true",
        "private",
      ],
      ["network", "rm", "private"],
      ["volume", "rm", "data"],
      ["image", "rm", "image"],
    ]);
    output.mockRejectedValueOnce(Error("network private has active endpoints"));
    await expect(docker.removeNetwork(context(), "private")).rejects.toThrow("active endpoints");
    output.mockRejectedValueOnce(Error("Error: No such volume: data"));
    await docker.removeVolume(context(), "data");
  } finally {
    output.mockRestore();
  }
});

test("Docker preflight rejects remote and rootless engines before deploying", async () => {
  const originalHost = process.env.DOCKER_HOST;
  const originalContext = process.env.DOCKER_CONTEXT;
  delete process.env.DOCKER_HOST;
  delete process.env.DOCKER_CONTEXT;
  const docker = new Docker("docker", "linux");
  const output = spyOn(docker, "output").mockImplementation(async (_ctx, args) =>
    Buffer.from(
      args[0] === "context"
        ? "unix:///var/run/docker.sock"
        : JSON.stringify({
            OSType: "linux",
            SecurityOptions: ["name=seccomp"],
            OperatingSystem: "Ubuntu",
          }),
    ),
  );
  try {
    await docker.startSystem(context());
    output.mockResolvedValueOnce(Buffer.from("ssh://remote"));
    await expect(docker.startSystem(context())).rejects.toThrow("local Unix socket");
    output.mockResolvedValueOnce(Buffer.from("unix:///run/user/1000/docker.sock"));
    output.mockResolvedValueOnce(
      Buffer.from(JSON.stringify({ OSType: "linux", SecurityOptions: ["name=rootless"] })),
    );
    await expect(docker.startSystem(context())).rejects.toThrow("rootless");
    process.env.DOCKER_HOST = "tcp://remote:2375";
    process.env.DOCKER_CONTEXT = "local";
    await docker.startSystem(context());
    delete process.env.DOCKER_CONTEXT;
    await expect(docker.startSystem(context())).rejects.toThrow("local Unix socket");
  } finally {
    output.mockRestore();
    if (originalHost === undefined) delete process.env.DOCKER_HOST;
    else process.env.DOCKER_HOST = originalHost;
    if (originalContext === undefined) delete process.env.DOCKER_CONTEXT;
    else process.env.DOCKER_CONTEXT = originalContext;
  }
});

test("Docker starts task containers with stdin, limits, private env and persistent mounts", async () => {
  const docker = new Docker();
  const output = spyOn(docker, "output").mockResolvedValue(Buffer.alloc(0));
  try {
    await docker.run(context(), {
      name: "migration",
      network: "private",
      image: "app:latest",
      service: { command: ["bun", "migrate.mjs"], working_dir: "/app", cpus: 2, memory: "1G" },
      envFile: "/private/env",
      volumes: { data: "/data" },
      task: true,
      timeout: 5000,
    });
    expect(output.mock.calls[0][1]).toEqual([
      "run",
      "--name",
      "migration",
      "--network",
      "private",
      "--label",
      "dev.contremaitre.managed=true",
      "--cpus",
      "2",
      "--memory",
      "1G",
      "--rm",
      "--env-file",
      "/private/env",
      "--workdir",
      "/app",
      "--volume",
      "data:/data",
      "app:latest",
      "bun",
      "migrate.mjs",
    ]);
    expect(output.mock.calls[0][2]?.timeout).toBe(5000);
    output.mockRejectedValueOnce(Error("exit code 7"));
    await expect(
      docker.run(context(), {
        name: "failed",
        network: "private",
        image: "app",
        service: {},
        volumes: {},
        envFile: "",
        task: true,
      }),
    ).rejects.toThrow("exit code 7");
  } finally {
    output.mockRestore();
  }
});

test("Docker builds filter secrets, clean staging and reuse only existing unchanged images", async () => {
  const root = mkdtempSync(join(tmpdir(), "cm-docker-build-"));
  writeFileSync(join(root, "Dockerfile"), "FROM scratch\nCOPY input /input\n");
  writeFileSync(join(root, "input"), "one");
  writeFileSync(join(root, "secret.txt"), "excluded");
  writeFileSync(join(root, ".dockerignore"), "secret.txt\n");
  const docker = new Docker();
  const staged: string[] = [];
  const output = spyOn(docker, "output").mockImplementation(async (_ctx, args) => {
    if (args[0] === "build") {
      const directory = args.at(-1);
      if (!directory) throw Error("Missing build context");
      staged.push(directory);
      expect(existsSync(join(directory, "secret.txt"))).toBe(false);
      expect(readFileSync(join(directory, "input"), "utf8")).toBe("one");
      expect(args).not.toContain("--cpus");
      expect(args).not.toContain("builder");
    }
    return Buffer.alloc(0);
  });
  try {
    const first = await docker.build(context(), root, join(root, "Dockerfile"), "image-1");
    expect(existsSync(staged[0])).toBe(false);
    const reused = await docker.build(context(), root, join(root, "Dockerfile"), "image-2", first);
    expect(reused).toEqual(first);
    expect(staged).toHaveLength(1);
    output.mockRejectedValueOnce(Error("permission denied"));
    await expect(
      docker.build(context(), root, join(root, "Dockerfile"), "image-3", first),
    ).rejects.toThrow("permission denied");
    output.mockRejectedValueOnce(Error("No such image: image-1"));
    expect(
      (await docker.build(context(), root, join(root, "Dockerfile"), "image-4", first)).image,
    ).toBe("image-4");
    expect(staged).toHaveLength(2);
    output.mockImplementationOnce(async (_ctx, args) => {
      const directory = args.at(-1);
      if (!directory) throw Error("Missing build context");
      staged.push(directory);
      throw Error("build failed");
    });
    await expect(docker.build(context(), root, join(root, "Dockerfile"), "bad")).rejects.toThrow(
      "build failed",
    );
    expect(staged.every((path) => !existsSync(path))).toBe(true);
  } finally {
    output.mockRestore();
    rmSync(root, { recursive: true, force: true });
  }
});

test("Docker removal requests anonymous-volume cleanup while named volumes remain engine-owned", async () => {
  const docker = new Docker();
  const output = spyOn(docker, "output").mockResolvedValue(Buffer.alloc(0));
  try {
    await docker.remove(context(), "web");
    expect(output.mock.calls[0][1]).toEqual(["rm", "--force", "--volumes", "web"]);
  } finally {
    output.mockRestore();
  }
});

test("Docker rebuilds an existing image when a filtered build input changes", async () => {
  const root = mkdtempSync(join(tmpdir(), "cm-docker-rebuild-"));
  writeFileSync(join(root, "Dockerfile"), "FROM scratch\nCOPY input /input\n");
  writeFileSync(join(root, "input"), "one");
  const docker = new Docker();
  const built: string[] = [];
  const output = spyOn(docker, "output").mockImplementation(async (_ctx, args) => {
    if (args[0] === "build") {
      const directory = args.at(-1);
      if (!directory) throw Error("Missing build context");
      built.push(readFileSync(join(directory, "input"), "utf8"));
    }
    return Buffer.alloc(0);
  });
  try {
    const first = await docker.build(context(), root, join(root, "Dockerfile"), "image-1");
    expect(await docker.build(context(), root, join(root, "Dockerfile"), "unused", first)).toEqual(
      first,
    );
    writeFileSync(join(root, "input"), "two");
    const changed = await docker.build(context(), root, join(root, "Dockerfile"), "image-2", first);
    expect(changed.image).toBe("image-2");
    expect(changed.digest).not.toBe(first.digest);
    expect(built).toEqual(["one", "two"]);
  } finally {
    output.mockRestore();
    rmSync(root, { recursive: true, force: true });
  }
});
