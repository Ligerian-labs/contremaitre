import { HubError } from "@contremaitre/execution/context";

export class AgentResultError extends HubError {
  constructor() {
    super({ message: "Agent operation did not pass", classification: "permanent", exitCode: 1 });
  }
}
