import { expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { order, parseManifest, prepareManifest } from "@contremaitre/projects/config";

const manifest =
  'version: 1\nproject: shop\nservices:\n  postgres:\n    kind: postgres\n  api:\n    image: api\n    port: 3000\n    http: true\n    depends_on: [postgres]\n    environment:\n      DATABASE_URL: "{{postgres.url}}"\n      CORS: "{{web.local_url}}"\n  web:\n    image: web\n    port: 80\n    http: true\n    depends_on: [api]\n';
test("managed defaults, dependency order and forward browser URL references", () => {
  const m = prepareManifest(".", parseManifest(manifest));
  expect(m.services.postgres.image).toBe("postgres:17");
  expect(order(m.services)).toEqual(["postgres", "api", "web"]);
});
test("ordered env files preserve development defaults and local overrides", () => {
  const root = mkdtempSync(join(tmpdir(), "cm-env-files-"));
  try {
    writeFileSync(join(root, ".env.dev"), "VALUE=default\nKEEP=yes\nFINAL=file\n");
    writeFileSync(join(root, ".env.dev.local"), "VALUE=local\nFINAL=local\n");
    const text =
      "version: 1\nproject: env\nservices:\n  app: {image: node:22, env_file: [.env.dev, .env.dev.local], environment: {FINAL: explicit}}\n";
    expect(prepareManifest(root, parseManifest(text)).services.app.environment).toEqual({
      VALUE: "local",
      KEEP: "yes",
      FINAL: "explicit",
    });
    expect(() => parseManifest(text.replace(".env.dev.local", "../outside"))).toThrow(
      "paths must stay",
    );
    expect(() =>
      prepareManifest(root, parseManifest(text.replace(".env.dev.local", ".env.missing"))),
    ).toThrow();
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
test("rejects unknown fields, cycles, credentials on managed databases and missing references", () => {
  for (const text of [
    `${manifest}unknown: true\n`,
    manifest.replace("depends_on: [postgres]", "depends_on: [web]"),
    manifest.replace("kind: postgres", "kind: postgres\n    environment: {PASSWORD: bad}"),
    manifest.replace('"{{postgres.url}}"', '"{{missing.url}}"'),
  ])
    expect(() => prepareManifest(".", parseManifest(text))).toThrow();
});
