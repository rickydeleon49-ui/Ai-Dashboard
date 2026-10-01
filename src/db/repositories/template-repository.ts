/**
 * Persistence contract for Release 2D.3 reusable templates
 * (docs/design/2D.3-reusable-templates.md). PostgreSQL scopes every query by
 * workspace; SQLite serves only `LOCAL_WORKSPACE_ID`.
 */
import type { DateOnly } from "@/core/calendar/dates";
import type { StoredTemplate, TemplateContent, TemplateIssue, TemplateSummary } from "@/core/templates/types";

/** Stages after which a test can inject a failure to prove rollback. Never set by routes. */
export type ApplyFailurePoint =
  | "application"
  | "project"
  | "milestones"
  | "tasks"
  | "dependencies"
  | "checklist"
  | "documents"
  | "activity";

export interface ApplyRequest {
  startDate: DateOnly;
  /** Overrides the template's project name when set. */
  name?: string;
  idempotencyKey: string;
  /** SHA-256 of the canonical { templateId, startDate, name }. */
  requestHash: string;
}

export interface ApplyActor {
  /** null on desktop. */
  userId: string | null;
  /** The user id in hosted mode, "local" on desktop. */
  actorKey: string;
}

export type ApplyResult =
  | {
      kind: "created";
      project: { id: string; name: string };
      milestones: Record<string, string>;
      tasks: Record<string, string>;
    }
  | { kind: "replayed"; project: { id: string; name: string } }
  | { kind: "conflict"; reason: "different_request" | "project_deleted" }
  | { kind: "not_found" }
  | { kind: "forbidden" }
  | { kind: "invalid"; issues: TemplateIssue[] };

export type CreateResult = { kind: "created"; id: string } | { kind: "limit_reached" };

export interface TemplateRepository {
  list(workspaceId: string): Promise<TemplateSummary[]>;
  get(workspaceId: string, id: string): Promise<StoredTemplate | null>;
  create(workspaceId: string, content: TemplateContent, createdBy: string | null): Promise<CreateResult>;
  /** Replaces the whole template atomically. false when it does not exist in the workspace. */
  replace(workspaceId: string, id: string, content: TemplateContent): Promise<boolean>;
  /** Deletes the template and its own child rows only. */
  delete(workspaceId: string, id: string): Promise<boolean>;
  apply(
    workspaceId: string,
    templateId: string,
    request: ApplyRequest,
    actor: ApplyActor,
    testFailAfter?: ApplyFailurePoint,
  ): Promise<ApplyResult>;
}

/** Thrown by a test-only failure injection point. */
export class InjectedApplyFailure extends Error {
  constructor(point: ApplyFailurePoint) {
    super(`Injected failure after ${point}`);
    this.name = "InjectedApplyFailure";
  }
}
