import { expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { parseManifest } from "@contremaitre/projects/config";
import { dockerfilePort, importCompose, initProject } from "@contremaitre/projects/init";

test("monorepo init discovers named Dockerfiles without a root start script", () => {
  const root = mkdtempSync(join(tmpdir(), "cm-init-"));
  try {
    mkdirSync(join(root, "docker"));
    writeFileSync(
      join(root, "package.json"),
      JSON.stringify({ scripts: { build: "turbo build" } }),
    );
    writeFileSync(
      join(root, "docker", "api.Dockerfile"),
      "FROM node:22 AS base\nEXPOSE 3000\nFROM base AS runtime\n",
    );
    writeFileSync(join(root, "docker", "worker.Dockerfile"), "FROM node:22\n");
    const path = initProject(root),
      manifest = parseManifest(readFileSync(path, "utf8"));
    expect(manifest.services.api.port).toBe(3000);
    expect(manifest.services.api.build).toBe(".");
    expect(manifest.services.worker.http).toBe(false);
    expect(() => initProject(root)).toThrow("already exists");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
test("port inference rejects ambiguous and variable ports", () => {
  expect(() => dockerfilePort("FROM node:22\nEXPOSE 3000 4000")).toThrow("Multiple TCP");
  expect(() => dockerfilePort("FROM node:22\nEXPOSE $PORT")).toThrow("literal");
  expect(dockerfilePort("FROM scratch\nEXPOSE 123/udp")).toBe(0);
});
test("Compose import preserves arguments and rejects unsupported database semantics", () => {
  const manifest = importCompose(
    'services:\n  web:\n    build: {context: app, dockerfile: Dockerfile.prod}\n    ports: ["8080:3000"]\n    command: [node, server.js]\n    volumes: ["uploads:/files"]\n',
    "example",
  );
  expect(manifest.services.web.dockerfile).toBe("app/Dockerfile.prod");
  expect(manifest.services.web.port).toBe(3000);
  expect(manifest.services.web.command).toEqual(["node", "server.js"]);
  expect(() => importCompose("services:\n  db: {image: 'postgres:17'}\n", "example")).toThrow(
    "managed",
  );
  expect(() =>
    importCompose("services:\n  web: {image: nginx, privileged: true}\n", "example"),
  ).toThrow("unsupported");
});
