"use client";

import { useTransition } from "react";
import { usePathname, useRouter, useSearchParams } from "next/navigation";
import { Select } from "@/components/ui/field";
import { TASK_PRIORITIES, TASK_STATUSES } from "@/core/tasks/types";
import { TASK_PRIORITY_META, TASK_STATUS_META } from "@/core/tasks/labels";

/** Search/filter controls for My Work — all state lives in the URL, same as ProjectFilters. */
export function MyWorkFilters({
  projects,
  accountsMode = false,
}: {
  projects: { id: string; name: string }[];
  accountsMode?: boolean;
}) {
  const router = useRouter();
  const pathname = usePathname();
  const params = useSearchParams();
  const [, startTransition] = useTransition();

  function push(next: URLSearchParams) {
    const qs = next.toString();
    startTransition(() => {
      router.replace(qs ? `${pathname}?${qs}` : pathname, { scroll: false });
    });
  }

  function setParam(key: string, value: string) {
    const next = new URLSearchParams(params.toString());
    if (!value || value === "all" || (key === "assignment" && value === "to_me")) {
      next.delete(key);
    } else {
      next.set(key, value);
    }
    push(next);
  }

  const activeCount = ["status", "priority", "project", "assignment"].filter((key) => params.get(key)).length;

  return (
    <div className="flex flex-wrap items-center gap-2 min-w-0">
      {accountsMode ? (
        <Select
          aria-label="Filter by assignment"
          value={params.get("assignment") ?? "to_me"}
          onChange={(e) => setParam("assignment", e.target.value)}
          className="w-auto min-w-36 min-h-[40px] md:min-h-0"
        >
          <option value="to_me">Assigned to me</option>
          <option value="by_me">Assigned by me</option>
          <option value="unassigned">Unassigned</option>
          <option value="all">All assignments</option>
        </Select>
      ) : null}

      <Select
        aria-label="Filter by status"
        value={params.get("status") ?? "all"}
        onChange={(e) => setParam("status", e.target.value)}
        className="w-auto min-w-28 min-h-[40px] md:min-h-0"
      >
        <option value="all">All statuses</option>
        {TASK_STATUSES.map((status) => (
          <option key={status} value={status}>
            {TASK_STATUS_META[status].label}
          </option>
        ))}
      </Select>

      <Select
        aria-label="Filter by priority"
        value={params.get("priority") ?? "all"}
        onChange={(e) => setParam("priority", e.target.value)}
        className="w-auto min-w-28 min-h-[40px] md:min-h-0"
      >
        <option value="all">All priorities</option>
        {TASK_PRIORITIES.map((priority) => (
          <option key={priority} value={priority}>
            {TASK_PRIORITY_META[priority].label}
          </option>
        ))}
      </Select>

      <Select
        aria-label="Filter by project"
        value={params.get("project") ?? "all"}
        onChange={(e) => setParam("project", e.target.value)}
        className="w-auto min-w-32 min-h-[40px] md:min-h-0"
      >
        <option value="all">All projects</option>
        {projects.map((project) => (
          <option key={project.id} value={project.id}>
            {project.name}
          </option>
        ))}
      </Select>

      {activeCount > 0 ? (
        <button
          type="button"
          onClick={() => push(new URLSearchParams())}
          className="h-8 min-h-[40px] md:min-h-0 md:h-8 rounded-md px-2 text-[12.5px] text-faint transition-colors hover:text-fg inline-flex items-center"
        >
          Clear
        </button>
      ) : null}
    </div>
  );
}
