import { expect, test } from "bun:test";
import { HubError } from "@contremaitre/execution/context";
import { attempt } from "@contremaitre/execution/effect";
import { Cause, Effect, Exit, Option } from "effect";

test("Promise adapters preserve typed HubError failures for catchTag", async () => {
  const failure = new HubError({ message: "temporary outage", classification: "transient" });
  const result = await Effect.runPromise(
    attempt(async () => {
      throw failure;
    }).pipe(Effect.catchTag("HubError", (error) => Effect.succeed(error))),
  );
  expect(result).toBe(failure);
});

test("unknown exceptions and forged tags stay defects across Promise adapters", async () => {
  for (const failure of [
    new TypeError("programming error"),
    { _tag: "HubError", message: "forged", classification: "transient" },
  ]) {
    const result = await Effect.runPromiseExit(
      attempt(async () => {
        throw failure;
      }),
    );
    expect(Exit.isFailure(result)).toBe(true);
    if (Exit.isFailure(result)) {
      expect(Option.getOrUndefined(Cause.dieOption(result.cause))).toBe(failure);
      expect(Cause.isFailure(result.cause)).toBe(false);
    }
  }
});

test("cleanup preserves typed failures, defects and interruption as complete causes", async () => {
  const { withCleanup } = await import("@contremaitre/execution/effect");
  const original = new HubError({ message: "work failed", classification: "permanent" });
  const cleanup = new HubError({ message: "stop failed", classification: "transient" });
  const defect = new Error("unexpected cleanup bug");
  const result = await Effect.runPromiseExit(
    withCleanup(Effect.fail(original), Effect.fail(cleanup)),
  );
  if (!Exit.isFailure(result)) throw Error("Expected failure");
  expect(Array.from(Cause.failures(result.cause))).toEqual([original, cleanup]);
  expect(Cause.isDie(result.cause)).toBe(false);
  const interrupted = await Effect.runPromiseExit(
    withCleanup(Effect.interrupt, Effect.die(defect)),
  );
  if (!Exit.isFailure(interrupted)) throw Error("Expected interruption");
  expect(Cause.isInterrupted(interrupted.cause)).toBe(true);
  expect(Option.getOrUndefined(Cause.dieOption(interrupted.cause))).toBe(defect);
  expect(
    await Effect.runPromise(
      withCleanup(Effect.succeed("done"), Effect.fail(cleanup)).pipe(
        Effect.catchTag("HubError", (error) => Effect.succeed(error.message)),
      ),
    ),
  ).toBe("stop failed");
});

test("CLI reporting does not hide cleanup failures or let a child code override interruption", async () => {
  const { commandFailure } = await import("../apps/cli/src/errors.js");
  const { AgentResultError } = await import("../apps/cli/src/agents.js");
  const { FiberId } = await import("effect");
  const reported = new AgentResultError();
  const child = new HubError({
    message: "child failed",
    classification: "permanent",
    exitCode: 23,
  });
  const defect = new Error("cleanup bug");
  expect(commandFailure(Cause.fail(reported))).toEqual({ code: 1 });
  expect(commandFailure(Cause.fail(child))).toEqual({ code: 23, text: "child failed" });
  const combined = commandFailure(Cause.sequential(Cause.fail(reported), Cause.die(defect)));
  expect(combined.code).toBe(70);
  expect(combined.text).toContain("Unexpected internal error");
  expect(combined.text).not.toContain("cleanup bug");
  expect(
    commandFailure(Cause.parallel(Cause.interrupt(FiberId.none), Cause.fail(child))).code,
  ).toBe(130);
  expect(commandFailure(Cause.fail({ exitCode: 23 })).code).toBe(1);
  expect(commandFailure(Cause.sequential(Cause.fail(reported), Cause.fail(child))).text).toContain(
    "child failed",
  );
});

test("native I/O failures retain their cause without erasing programmer errors", async () => {
  const { readFileSync } = await import("node:fs");
  const io = await Effect.runPromise(
    attempt(async () => readFileSync("/no-such-contremaitre-file")).pipe(
      Effect.catchTag("HubError", (error) => Effect.succeed(error)),
    ),
  );
  expect(io).toBeInstanceOf(HubError);
  if (io instanceof HubError) {
    expect(io.cause).toBeInstanceOf(Error);
    expect(io.message).toContain("ENOENT");
  }
  const programmer = Object.assign(new TypeError("wrong API usage"), {
    code: "ERR_INVALID_ARG_TYPE",
  });
  const result = await Effect.runPromiseExit(
    attempt(async () => {
      throw programmer;
    }),
  );
  if (!Exit.isFailure(result)) throw Error("Expected defect");
  expect(Option.getOrUndefined(Cause.dieOption(result.cause))).toBe(programmer);
});

test("CLI does not expose raw error causes, including combined failures", async () => {
  const { commandFailure } = await import("../apps/cli/src/errors.js");
  const failure = new HubError({
    message: "Provider unavailable",
    classification: "transient",
    cause: new Error("private-provider-token"),
  });
  expect(commandFailure(Cause.fail(failure)).text).toBe("Provider unavailable");
  const combined = commandFailure(
    Cause.sequential(Cause.fail(failure), Cause.die(new Error("private-defect-token"))),
  );
  expect(combined.code).toBe(70);
  expect(combined.text).toContain("Provider unavailable");
  expect(combined.text).not.toContain("private-");
});

test("schema validation does not turn decoder defects into validation failures", async () => {
  const { decode } = await import("@contremaitre/execution/context");
  const { Schema } = await import("effect");
  const defect = new TypeError("decoder bug");
  const schema = Schema.transform(Schema.String, Schema.String, {
    strict: true,
    decode: () => {
      throw defect;
    },
    encode: (value) => value,
  });
  expect(() => decode(schema, "valid input", "value")).toThrow(defect);
  expect(() => decode(Schema.String, 42, "value")).toThrow("Invalid value");
});

test("Promise adapters preserve every failure and defect in aggregate and fiber errors", async () => {
  const failure = new HubError({ message: "stop failed", classification: "transient" });
  const defect = new TypeError("cleanup bug");
  const nested = Effect.runPromise(Effect.fail(failure));
  const result = await Effect.runPromiseExit(attempt(() => nested));
  if (!Exit.isFailure(result)) throw Error("Expected failure");
  expect(Array.from(Cause.failures(result.cause))).toEqual([failure]);
  expect(Cause.isDie(result.cause)).toBe(false);
  const aggregate = await Effect.runPromiseExit(
    attempt(async () => {
      throw new AggregateError([failure, defect], "shutdown failed");
    }),
  );
  if (!Exit.isFailure(aggregate)) throw Error("Expected failure");
  expect(Array.from(Cause.failures(aggregate.cause))).toEqual([failure]);
  expect(Array.from(Cause.defects(aggregate.cause))).toEqual([defect]);
  const died = await Effect.runPromiseExit(attempt(() => Effect.runPromise(Effect.die(failure))));
  if (!Exit.isFailure(died)) throw Error("Expected defect");
  expect(Cause.isFailure(died.cause)).toBe(false);
  expect(Array.from(Cause.defects(died.cause))).toEqual([failure]);
});

test("socket resets and Node request timeouts remain operational failures", async () => {
  const { request } = await import("node:http");
  const reset = Object.assign(new Error("socket hang up"), { code: "ECONNRESET" });
  const result = await Effect.runPromise(
    attempt(async () => {
      throw reset;
    }).pipe(Effect.catchTag("HubError", (error) => Effect.succeed(error))),
  );
  expect(result.cause).toBe(reset);
  const aborted = await Effect.runPromise(
    attempt(
      () =>
        new Promise<never>((_, reject) => {
          const req = request("http://127.0.0.1:1", { signal: AbortSignal.abort() });
          req.on("error", reject);
          req.end();
        }),
    ).pipe(Effect.catchTag("HubError", (error) => Effect.succeed(error))),
  );
  expect(aborted.classification).toBe("transient");
  expect(aborted.cause).toBeInstanceOf(Error);
});
