import {
  closeSync,
  existsSync,
  mkdirSync,
  openSync,
  readdirSync,
  readFileSync,
  readSync,
  rmSync,
  statSync,
  writeSync,
} from "node:fs";
import { join } from "node:path";
import { stripVTControlCharacters } from "node:util";
import { fail } from "@contremaitre/execution/context";
import { atomicWrite } from "@contremaitre/execution/files";

export interface CheckResult {
  name: string;
  status: "running" | "passed" | "failed" | "skipped" | "interrupted";
  exit_code?: number;
  duration_ms?: number;
  error?: string;
  log_truncated?: boolean;
  artifacts: string[];
}
export interface VerificationRun {
  version: 1;
  id: string;
  environment_id: string;
  generation?: string;
  profile: string;
  source: { fingerprint: string; revision?: string };
  status: "running" | "passed" | "failed" | "interrupted";
  started_at: string;
  finished_at?: string;
  stale: boolean;
  checks: CheckResult[];
}
export const runID = /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/;
export const clean = (s: string, limit = 500) =>
  stripVTControlCharacters(s)
    .replace(/\p{Cc}/gu, (character) => (character === "\n" || character === "\t" ? character : ""))
    .slice(0, limit);
export class Evidence {
  readonly directory: string;
  constructor(home: string) {
    this.directory = join(home, "verification");
    mkdirSync(this.directory, { recursive: true, mode: 0o700 });
    for (const record of this.list())
      if (record.status === "running") {
        record.status = "interrupted";
        record.finished_at = new Date().toISOString();
        for (const check of record.checks)
          if (check.status === "running") check.status = "interrupted";
        this.save(record);
      }
    this.trim();
  }
  path(id: string) {
    if (!runID.test(id)) fail("Invalid run ID");
    return join(this.directory, id);
  }
  save(record: VerificationRun) {
    const dir = this.path(record.id);
    mkdirSync(dir, { recursive: true, mode: 0o700 });
    atomicWrite(join(dir, "run.json"), JSON.stringify(record));
  }
  get(id: string): VerificationRun {
    const file = join(this.path(id), "run.json");
    if (!existsSync(file)) fail("Unknown verification run");
    const record = JSON.parse(readFileSync(file, "utf8")) as VerificationRun;
    if (record.version !== 1 || record.id !== id || !Array.isArray(record.checks))
      fail("Invalid verification record");
    return record;
  }
  list() {
    return readdirSync(this.directory)
      .filter((id) => runID.test(id))
      .map((id) => this.get(id))
      .sort((a, b) => b.started_at.localeCompare(a.started_at));
  }
  latest(id: string) {
    return this.list().find((r) => r.environment_id === id);
  }
  trim() {
    for (const r of this.list()
      .filter((r) => r.status !== "running")
      .slice(20))
      rmSync(this.path(r.id), { recursive: true, force: true });
  }
  logger(id: string, name: string) {
    const path = join(this.path(id), `${name}.log`),
      fd = openSync(path, "w", 0o600);
    let size = 0,
      truncated = false;
    return {
      write(data: Buffer) {
        const remaining = 4 * 1048576 - size;
        if (data.length > remaining) truncated = true;
        const chunk = data.subarray(0, Math.max(0, remaining));
        if (chunk.length) {
          writeSync(fd, chunk);
          size += chunk.length;
        }
      },
      close() {
        closeSync(fd);
        return truncated;
      },
    };
  }
  diagnose(id: string, offset = 0, check?: string) {
    const run = this.get(id);
    if (!Number.isSafeInteger(offset) || offset < 0) fail("Invalid diagnostic cursor");
    const selected = check
      ? run.checks.find((c) => c.name === check)
      : (run.checks.find((c) => c.status === "failed" || c.status === "interrupted") ??
        run.checks[0]);
    if (check && !selected) fail("Unknown check");
    const path = selected && join(this.path(id), `${selected.name}.log`);
    const size = path && existsSync(path) ? statSync(path).size : 0;
    const data = Buffer.alloc(Math.min(3000, Math.max(0, size - offset)));
    if (path && data.length) {
      const fd = openSync(path, "r");
      try {
        readSync(fd, data, 0, data.length, offset);
      } finally {
        closeSync(fd);
      }
    }
    return {
      run_id: id,
      status: run.status,
      check: selected?.name,
      error: selected?.error,
      output: clean(data.toString(), 3000),
      offset: offset + data.length,
      truncated: offset + data.length < size,
      log_truncated: selected?.log_truncated ?? false,
    };
  }
}
