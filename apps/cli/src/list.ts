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
