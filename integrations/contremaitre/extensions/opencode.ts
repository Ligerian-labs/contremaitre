import { label, report } from "../common.ts";

interface Host {
  directory: string;
  client: {
    tui: {
      showToast(input: {
        body: { title: string; message: string; variant: "info" | "warning" };
      }): Promise<unknown>;
    };
  };
}
// OpenCode 1.x event API. The shared skill also works without this optional UI adapter.
export const ContremaitrePlugin = async ({ directory, client }: Host) => {
  let previous = "",
    active = false;
  return {
    event: async ({ event }: { event: { type: string } }) => {
      if (event.type !== "session.idle" || active) return;
      active = true;
      try {
        const value = await report(directory);
        if (!value) return;
        const state = label(value);
        if (state === previous) return;
        previous = state;
        await client.tui.showToast({
          body: {
            title: state,
            message: value.review_url,
            variant:
              value.stale ||
              !value.source_current ||
              !value.ready ||
              value.verification !== "passed"
                ? "warning"
                : "info",
          },
        });
      } catch {
      } finally {
        active = false;
      }
    },
  };
};
