/**
 * Checklist items domain types (Phase 2C, release C.3).
 */
export interface TaskChecklistItem {
  id: string;
  taskId: string;
  workspaceId: string;
  position: number;
  text: string;
  done: boolean;
  doneBy: string | null;
  doneAt: string | null;
  createdBy: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface CreateChecklistItemInput {
  text: string;
}

export interface UpdateChecklistItemInput {
  text?: string;
}

export interface ChecklistItemActorOptions {
  actorUserId?: string;
}
