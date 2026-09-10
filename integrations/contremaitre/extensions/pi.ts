import { label, report } from "../common.ts";

interface Context {
  cwd: string;
  ui: {
    setStatus(key: string, value: string | undefined): void;
    notify(message: string, level: "info" | "warning"): void;
  };
}
interface Pi {
  on(event: "agent_end", handler: (event: unknown, ctx: Context) => Promise<void>): void;
  registerCommand(
    name: string,
    command: { description: string; handler: (args: string, ctx: Context) => Promise<void> },
  ): void;
}
export default function contremaitre(pi: Pi) {
  pi.on("agent_end", async (_event, ctx) => {
    const value = await report(ctx.cwd);
    ctx.ui.setStatus("contremaitre", value ? label(value) : undefined);
  });
  pi.registerCommand("contremaitre", {
    description: "Show local preview verification and review link",
    handler: async (_args, ctx) => {
      const value = await report(ctx.cwd);
      ctx.ui.notify(
        value
          ? `${label(value)}\n${value.review_url}`
          : "No Contremaitre report. Configure the project and run ensure.",
        value ? "info" : "warning",
      );
    },
  });
}
