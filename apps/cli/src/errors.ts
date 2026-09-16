import { HubError } from "@contremaitre/execution/context";
import { exitCodeFor } from "@structure-ai/cli";
import { Cause } from "effect";
import { AgentResultError } from "./agents.js";
import { UsageError } from "./help.js";

// A process boundary owns complete causes. Never let one expected failure hide
// a sibling defect, cleanup failure or interruption.
export function commandFailure(cause: Cause.Cause<unknown>): { code: number; text?: string } {
  if (Cause.isEmpty(cause)) return { code: 0 };
  const failures = Array.from(Cause.failures(cause));
  const details = failures.map((error) =>
    error instanceof HubError || error instanceof UsageError ? error.message : "Command failed",
  );
  if (Cause.isDie(cause)) details.push("Unexpected internal error");
  if (Cause.isInterrupted(cause)) details.push("Command interrupted");
  const text = details.join("\n");
  if (Cause.isInterrupted(cause)) return { code: 130, text };
  if (Cause.isDie(cause)) return { code: 70, text };
  if (failures.length !== 1) return { code: 1, text };
  const error = failures[0];
  if (error instanceof AgentResultError) return { code: 1 };
  if (error instanceof UsageError) return { code: 64, text: error.message };
  if (error instanceof HubError) {
    const child = error.exitCode;
    const code =
      child !== undefined && Number.isInteger(child) && child > 0 && child <= 255
        ? child
        : exitCodeFor(error);
    return { code, text: error.message };
  }
  const code = exitCodeFor(error);
  return {
    code,
    ...(code === 64 ? {} : { text: error instanceof Error ? error.message : "Command failed" }),
  };
}
