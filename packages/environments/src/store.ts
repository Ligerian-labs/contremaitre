import { existsSync, mkdirSync, readFileSync, realpathSync } from "node:fs";
import { join, resolve } from "node:path";
import { fail, hash } from "@contremaitre/execution/context";
import { atomicWrite } from "@contremaitre/execution/files";
import type { Environment, State } from "./model.js";
export class Store {
  readonly home: string;
  constructor(home: string) {
    mkdirSync(home, { recursive: true, mode: 0o700 });
    this.home = realpathSync(resolve(home));
  }
  namespace(): string {
    return `cm-${hash(this.home).slice(0, 6)}`;
  }
  load(): State {
    const path = join(this.home, "state.json");
    if (!existsSync(path)) return { Version: 1, Environments: {}, Main: {} };
    const state: State = JSON.parse(readFileSync(path, "utf8"));
    if (
      state.Version !== 1 ||
      !state.Environments ||
      !state.Main ||
      typeof state.Environments !== "object" ||
      typeof state.Main !== "object"
    )
      fail("Unsupported or invalid state file");
    for (const [id, e] of Object.entries(state.Environments)) {
      if (
        !/^[a-f0-9]{16}$/.test(id) ||
        e.Identity?.ID !== id ||
        typeof e.Identity.Project !== "string" ||
        typeof e.Root !== "string" ||
        !/^cm-[a-f0-9]{6}-[a-f0-9]{16}$/.test(e.Network)
      )
        fail("Invalid environment state");
      e.Services ??= {};
      e.Images ??= [];
      e.Volumes ??= [];
      e.credentials ??= {};
      e.tunnels ??= {};
      e.builds ??= {};
    }
    return state;
  }
  save(state: State): void {
    atomicWrite(join(this.home, "state.json"), JSON.stringify(state, null, 2));
  }
}
export function publicEnvironment(env: Environment): Environment {
  const out: Environment = structuredClone(env);
  delete out.credentials;
  for (const s of Object.values(out.Services)) {
    delete s.raw_environment;
    delete s.deployment;
    s.Spec = { ...s.Spec, environment: undefined, env_file: "" };
  }
  return out;
}
