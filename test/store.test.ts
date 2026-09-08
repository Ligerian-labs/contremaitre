import { expect, test } from "bun:test";
import { mkdtempSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { publicEnvironment, Store } from "@contremaitre/environments/store";
import { newIdentity } from "@contremaitre/projects/model";

test("version 1 Go null collections normalize without losing credentials or leaking them", () => {
  const home = mkdtempSync(join(tmpdir(), "cm-state-")),
    identity = newIdentity("example", home, "main");
  try {
    const store = new Store(home);
    const env = {
      Identity: identity,
      Root: home,
      Status: "stopped",
      Error: "",
      Network: `${store.namespace()}-${identity.ID}`,
      Services: {
        db: {
          Name: "db",
          Container: "example",
          Image: "postgres:17",
          IP: "",
          Volume: "",
          Port: 5432,
          HTTP: false,
          Initialized: true,
          Spec: { kind: "postgres", environment: { SECRET: "private" } },
          raw_environment: { SECRET: "private" },
        },
      },
      credentials: { db: "secret-password" },
      Images: null,
      Volumes: null,
      CloneComplete: true,
      CreatedAt: "2026-09-08T00:00:00Z",
      UpdatedAt: "2026-09-08T00:00:00Z",
    };
    writeFileSync(
      join(home, "state.json"),
      JSON.stringify({
        Version: 1,
        Environments: { [identity.ID]: env },
        Main: { example: identity.ID },
      }),
    );
    const loaded = store.load();
    expect(loaded.Environments[identity.ID].Images).toEqual([]);
    expect(loaded.Environments[identity.ID].credentials?.db).toBe("secret-password");
    const view = JSON.stringify(publicEnvironment(loaded.Environments[identity.ID]));
    expect(view).not.toContain("secret-password");
    expect(view).not.toContain("private");
    store.save(loaded);
    expect(statSync(join(home, "state.json")).mode & 0o777).toBe(0o600);
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});
