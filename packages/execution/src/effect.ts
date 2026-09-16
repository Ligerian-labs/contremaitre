import { getSystemErrorMap } from "node:util";
import { Cause, Effect, Exit, Runtime } from "effect";
import { HubError, message } from "./context.js";

const systemErrorCodes = new Set(Array.from(getSystemErrorMap().values(), ([code]) => code));

// Only this Promise boundary classifies unknown rejections. Fiber failures retain
// their full cause; aggregate errors retain each failure and defect in order.
function rejectionCause(error: unknown): Cause.Cause<HubError> {
  if (Runtime.isFiberFailure(error))
    return Cause.flatMap(error[Runtime.FiberFailureCauseId], rejectionCause);
  if (error instanceof AggregateError && error.errors.length)
    return error.errors.map(rejectionCause).reduce(Cause.sequential);
  if (error instanceof HubError) return Cause.fail(error);
  if (
    error instanceof Error &&
    "code" in error &&
    typeof error.code === "string" &&
    systemErrorCodes.has(error.code)
  )
    return Cause.fail(
      new HubError({ message: message(error), classification: "permanent", cause: error }),
    );
  if (
    (error instanceof DOMException && ["AbortError", "TimeoutError"].includes(error.name)) ||
    (error instanceof Error &&
      error.name === "AbortError" &&
      "code" in error &&
      error.code === "ABORT_ERR")
  )
    return Cause.fail(
      new HubError({ message: message(error), classification: "transient", cause: error }),
    );
  return Cause.die(error);
}

export const attempt = <A>(work: (signal: AbortSignal) => Promise<A>): Effect.Effect<A, HubError> =>
  Effect.tryPromise({ try: work, catch: rejectionCause }).pipe(Effect.catchAll(Effect.failCause));

// Cleanup can fail operationally. Preserve both outcomes without turning its
// typed failure into a defect just to satisfy an infallible finalizer signature.
export const withCleanup = <A, E, R, E2, R2>(
  work: Effect.Effect<A, E, R>,
  cleanup: Effect.Effect<unknown, E2, R2>,
): Effect.Effect<A, E | E2, R | R2> =>
  Effect.uninterruptibleMask((restore) =>
    Effect.gen(function* () {
      const result = yield* Effect.exit(restore(work));
      const released = yield* Effect.exit(cleanup);
      return yield* Exit.zipLeft(result, released);
    }),
  );
