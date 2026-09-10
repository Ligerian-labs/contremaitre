import { randomBytes } from "node:crypto";
import { createReadStream } from "node:fs";
import * as fs from "node:fs/promises";
import { createServer } from "node:http";
import { extname, join } from "node:path";
import { context } from "@contremaitre/execution/context";
import { inside } from "@contremaitre/projects/config";
import type { AgentWorkflow } from "./workflow.js";

const html = (value: unknown) =>
  String(value ?? "").replace(
    /[&<>"']/g,
    (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c] ?? c,
  );
const names: Record<string, string> = {
  "not-run": "Not run",
  passed: "Passed",
  failed: "Failed",
  running: "Running",
  interrupted: "Interrupted",
  skipped: "Skipped",
};
export async function startReview(workflow: AgentWorkflow) {
  const token = randomBytes(24).toString("hex");
  const server = createServer((req, res) => {
    res.setHeader("Cache-Control", "no-store");
    res.setHeader("Referrer-Policy", "no-referrer");
    res.setHeader("X-Content-Type-Options", "nosniff");
    res.setHeader(
      "Content-Security-Policy",
      "default-src 'none'; style-src 'unsafe-inline'; img-src 'self'; base-uri 'none'; frame-ancestors 'none'; form-action 'none'",
    );
    void (async () => {
      const address = server.address();
      if (!address || typeof address === "string") throw Error();
      const expected = `127.0.0.1:${address.port}`;
      if (
        req.headers.host !== expected ||
        !["127.0.0.1", "::ffff:127.0.0.1"].includes(req.socket.remoteAddress ?? "") ||
        req.method !== "GET"
      ) {
        res.writeHead(403);
        res.end("Forbidden");
        return;
      }
      const parts = new URL(req.url ?? "/", `http://${expected}`).pathname
        .split("/")
        .filter(Boolean)
        .map(decodeURIComponent);
      if (parts[0] !== token) {
        res.writeHead(404);
        res.end("Not found");
        return;
      }
      const ctx = context(AbortSignal.timeout(10_000));
      if ((parts[1] === "artifact" || parts[1] === "log") && parts.length >= 5) {
        const [, , id, check, ...segments] = parts;
        const record = workflow.evidence.get(id),
          result = record.checks.find((c) => c.name === check),
          relative = segments.join("/");
        const log = parts[1] === "log" && relative === "output.log";
        if (!result || (!log && !result.artifacts.includes(relative))) throw Error();
        const path = log
          ? join(workflow.evidence.path(id), `${check}.log`)
          : join(workflow.evidence.path(id), check, relative);
        const real = await fs.realpath(path);
        if (!inside(workflow.evidence.path(id), real) || !(await fs.stat(real)).isFile())
          throw Error();
        const types: Record<string, string> = {
          ".png": "image/png",
          ".jpg": "image/jpeg",
          ".jpeg": "image/jpeg",
          ".webp": "image/webp",
          ".txt": "text/plain; charset=utf-8",
          ".log": "text/plain; charset=utf-8",
          ".json": "application/json",
        };
        const type = types[extname(path)] ?? "application/octet-stream";
        res.setHeader("Content-Type", type);
        if (type === "application/octet-stream") res.setHeader("Content-Disposition", "attachment");
        const stream = createReadStream(real);
        stream.on("error", () => res.destroy());
        res.on("close", () => stream.destroy());
        stream.pipe(res);
        return;
      }
      if (parts.length !== 2 || !/^[a-f0-9]{16}$/.test(parts[1])) throw Error();
      const report = await workflow.report(ctx, { env: parts[1] });
      const env = workflow.manager.resolve(parts[1]),
        record = report.run_id ? workflow.evidence.get(report.run_id) : undefined;
      const artifactURL = (check: string, file: string) =>
        `/${token}/artifact/${record?.id}/${encodeURIComponent(check)}/${file.split("/").map(encodeURIComponent).join("/")}`;
      const checks =
        record?.checks
          .map(
            (check) =>
              `<article><div class="row"><h3>${html(check.name)}</h3><span class="badge ${check.status}">${names[check.status]}</span></div><p>${check.duration_ms ?? 0} ms${check.exit_code === undefined ? "" : ` · exit ${check.exit_code}`}</p>${check.error ? `<p class="error">${html(check.error)}</p>` : ""}<a href="${artifactURL(check.name, "output.log").replace("/artifact/", "/log/")}">Execution log${check.log_truncated ? " (size limit reached)" : ""}</a><div class="artifacts">${check.artifacts.map((file) => `<a href="${artifactURL(check.name, file)}">${/\.(png|jpe?g|webp)$/i.test(file) ? `<img loading="lazy" src="${artifactURL(check.name, file)}" alt="${html(file)}">` : ""}<span>${html(file)}</span></a>`).join("")}</div></article>`,
          )
          .join("") ??
        "<article><p>No verification has run. Readiness only confirms that services started.</p></article>";
      res.setHeader("Content-Type", "text/html; charset=utf-8");
      res.end(`<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><meta http-equiv="refresh" content="10"><title>${html(env.Identity.Project)} · Contremaître</title><style>
:root{font-family:system-ui,sans-serif;color:#e7edf4;background:#111820;color-scheme:dark}*{box-sizing:border-box}body{margin:0}main{max-width:1000px;margin:0 auto;padding:40px 24px}header{border-bottom:1px solid #33404c;padding-bottom:24px;margin-bottom:24px}.eyebrow{color:#98acbb;font-size:13px;letter-spacing:.08em}h1{font-size:36px;margin:12px 0}h2{font-size:20px;margin-top:32px}h3{font-size:16px;margin:0}p{color:#aebdcc;line-height:1.6;overflow-wrap:anywhere}a{color:#81c5ff;text-underline-offset:3px;overflow-wrap:anywhere}.row{display:flex;align-items:center;justify-content:space-between;gap:16px;flex-wrap:wrap}.badge{font-size:13px;border-radius:6px;padding:6px 10px;background:#303d4b}.passed{color:#a6e9c0;background:#183b2b}.failed,.interrupted{color:#ffb3ac;background:#492521}.warning{padding:16px;border:1px solid #af863d;border-radius:8px;color:#f2d292;background:#342b1b}.previews{display:flex;gap:12px;flex-wrap:wrap}.preview{border:1px solid #456884;border-radius:8px;padding:14px 20px;text-decoration:none}article{background:#1a2530;border:1px solid #33404c;border-radius:10px;padding:20px;margin:14px 0}.error{color:#ffb3ac}dl{display:grid;grid-template-columns:110px 1fr;gap:10px;font-size:13px;color:#aebdcc}dt{color:#e7edf4}dd{margin:0;overflow-wrap:anywhere}.artifacts{display:flex;flex-wrap:wrap;gap:14px;margin-top:16px}.artifacts a{display:flex;flex-direction:column;gap:8px}.artifacts img{width:240px;max-width:100%;border-radius:6px}footer{margin-top:32px;color:#879bab;font-size:12px}@media(max-width:600px){main{padding:24px 16px}h1{font-size:28px}dl{grid-template-columns:1fr}}
</style></head><body><main><header><div class="eyebrow">CONTREMAÎTRE · LOCAL REVIEW</div><div class="row"><h1>${html(env.Identity.Project)}</h1><span class="badge ${report.ready ? "passed" : "failed"}">${report.ready ? "Services ready" : "Services not ready"}</span></div><p>${html(env.Identity.Branch)} · ${html(env.Identity.Workspace)}</p><div class="previews">${
        Object.entries(workflow.urls(env))
          .map(
            ([name, url]) =>
              `<a class="preview" href="${html(url)}" target="_blank" rel="noreferrer">Open ${html(name)} ↗</a>`,
          )
          .join("") || "No browser services configured."
      }</div></header>${report.stale || !report.source_current ? '<div class="warning">Evidence is stale or the running source is unconfirmed. Run ensure and verify again before reviewing these results.</div>' : ""}<div class="row"><h2>Verification</h2><span class="badge ${report.verification}">${names[report.verification]}</span></div>${record ? `<p>${report.counts?.passed} passed · ${report.counts?.failed} failed · ${report.counts?.skipped} skipped</p>` : ""}${checks}<h2>Source and evidence</h2><dl><dt>Revision</dt><dd>${html(record?.source.revision ?? env.source?.revision ?? "No VCS revision")}</dd><dt>Fingerprint</dt><dd>${html(record?.source.fingerprint ?? env.source?.fingerprint ?? "Unconfirmed")}</dd><dt>Profile</dt><dd>${html(record?.profile ?? "Not run")}</dd><dt>Started</dt><dd>${html(record?.started_at ?? "Not run")}</dd><dt>Finished</dt><dd>${html(record?.finished_at ?? "Not finished")}</dd><dt>Run</dt><dd>${html(record?.id ?? "None")}</dd></dl><footer>Local to this Mac. Refreshes every 10 seconds. Test results describe the recorded run; application data may have changed since.</footer></main></body></html>`);
    })().catch(() => {
      if (!res.headersSent) {
        res.writeHead(404);
        res.end("Review or artifact unavailable");
      } else res.destroy();
    });
  });
  server.requestTimeout = 15000;
  server.headersTimeout = 5000;
  server.maxConnections = 32;
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  const address = server.address();
  if (!address || typeof address === "string") throw Error("Invalid review listener");
  workflow.reviewURL = `http://127.0.0.1:${address.port}/${token}`;
  return {
    close: async () => {
      server.closeAllConnections();
      await new Promise<void>((resolve) => server.close(() => resolve()));
    },
  };
}
