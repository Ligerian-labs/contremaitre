import { expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Manager } from "@contremaitre/environments/manager";
import { Store } from "@contremaitre/environments/store";
import { Tunnels } from "@contremaitre/environments/tunnel";
import { context } from "@contremaitre/execution/context";
import { newIdentity } from "@contremaitre/projects/model";
import { FakeRuntime } from "./fake-runtime.js";

test("provider reservations remain stable across connector stop and hub restart", async () => {
  const home = mkdtempSync(join(tmpdir(), "cm-tunnel-")),
    path = join(home, "provider");
  writeFileSync(
    path,
    `#!${process.execPath}\nimport {appendFileSync} from 'node:fs';\nconst r=JSON.parse(await Bun.stdin.text()),op=process.argv[2];appendFileSync(r.config.calls,op+'\\n');if(op==='start'){console.log(JSON.stringify({version:1,ready:true}));setInterval(()=>{},1000);}else console.log(JSON.stringify({version:1,capabilities:{stable_urls:true,https:true},reservation_id:'stable-reservation',url:'https://demo.example.test'}));`,
    { mode: 0o700 },
  );
  writeFileSync(
    join(home, "tunnels.json"),
    JSON.stringify({
      default: "fake",
      providers: { fake: { executable: path, config: { calls: join(home, "calls") } } },
    }),
  );
  const m = new Manager(new Store(home), new FakeRuntime()),
    env = m.fresh(newIdentity("example", home, "main"), home);
  env.Status = "running";
  env.Services.web = {
    Name: "web",
    Container: "",
    Image: "",
    Volume: "",
    IP: "127.0.0.1",
    Port: 3000,
    HTTP: true,
    Spec: { kind: "app" },
    Initialized: true,
  };
  m.state.Environments[env.Identity.ID] = env;
  let tunnels = new Tunnels(m, () => ({ upstream: "http://127.0.0.1:3000" }));
  try {
    const first = await tunnels.start(context(), env, "web");
    expect(first.ID).toBe("stable-reservation");
    await tunnels.stop(context(), env, "web", false);
    expect(env.tunnels?.web.Desired).toBe(false);
    await tunnels.start(context(), env, "web");
    await tunnels.shutdown();
    expect(env.tunnels?.web.Desired).toBe(true);
    tunnels = new Tunnels(m, () => ({ upstream: "http://127.0.0.1:3000" }));
    await tunnels.restore(context());
    expect(tunnels.running(env.Identity.ID, "web")).toBe(true);
    expect(
      readFileSync(join(home, "calls"), "utf8")
        .split("\n")
        .filter((x) => x === "reserve").length,
    ).toBe(1);
    await tunnels.stop(context(), env, "web", true);
    expect(env.tunnels?.web).toBeUndefined();
  } finally {
    await tunnels.shutdown();
    rmSync(home, { recursive: true, force: true });
  }
});
