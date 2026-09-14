import type { Environment } from "@contremaitre/environments/model";

export const listStatuses = [
  "running",
  "deploying",
  "pending",
  "stopping",
  "deleting",
  "failed",
  "stopped",
];

export function selectEnvironments(
  environments: Environment[],
  filters: { status: string[]; project: string; branch: string },
) {
  const rank = (status: string) => {
    const index = listStatuses.indexOf(status);
    return index < 0 ? listStatuses.length : index;
  };
  return environments
    .filter(
      (env) =>
        (!filters.status.length || filters.status.includes(env.Status)) &&
        (!filters.project || env.Identity.Project === filters.project) &&
        (!filters.branch || env.Identity.Branch === filters.branch),
    )
    .sort(
      (a, b) =>
        rank(a.Status) - rank(b.Status) ||
        a.Status.localeCompare(b.Status) ||
        a.Identity.Name.localeCompare(b.Identity.Name) ||
        a.Identity.ID.localeCompare(b.Identity.ID),
    );
}

export function formatEnvironments(environments: Environment[]) {
  const rows = [
    ["ID", "STATUS", "NAME", "PROJECT", "BRANCH", "DIRECTORY"],
    ...environments.map((env) => [
      env.Identity.ID,
      env.Status,
      env.Identity.Name,
      env.Identity.Project,
      env.Identity.Branch,
      env.Root,
    ]),
  ];
  const widths = rows[0].map((_, column) =>
    rows.reduce((width, row) => Math.max(width, Bun.stringWidth(row[column])), 0),
  );
  return rows
    .map((row) =>
      row
        .map((value, column) =>
          column === row.length - 1
            ? value
            : value + " ".repeat(widths[column] - Bun.stringWidth(value)),
        )
        .join("  "),
    )
    .join("\n");
}
