import { execFile } from "node:child_process";
import { existsSync } from "node:fs";
import { dirname, join } from "node:path";
export function project(cwd: string): string | undefined {
  for (let path = cwd; ; path = dirname(path)) {
    if ([".contremaitre.yaml", ".contremaitre.yml"].some((name) => existsSync(join(path, name))))
      return path;
    if (dirname(path) === path) return;
  }
}
export interface Report {
  ready: boolean;
  source_current: boolean;
  stale: boolean;
  verification: string;
  review_url: string;
}
export function report(cwd: string): Promise<Report | undefined> {
  const root = project(cwd);
  if (!root) return Promise.resolve(undefined);
  return new Promise((resolve) =>
    execFile(
      "contremaitre",
      ["report", "--json"],
      { cwd: root, timeout: 12000, maxBuffer: 16384 },
      (error, stdout) => {
        if (error) {
          resolve(undefined);
          return;
        }
        try {
          const result = JSON.parse(stdout);
          resolve(
            result.version === 1 && typeof result.data?.review_url === "string"
              ? result.data
              : undefined,
          );
        } catch {
          resolve(undefined);
        }
      },
    ),
  );
}
export function label(value: Report) {
  return value.stale || !value.source_current
    ? "Contremaitre: stale evidence"
    : !value.ready
      ? "Contremaitre: services not ready"
      : `Contremaitre: ${value.verification}`;
}
