/** Release 2D.3 template workload limits (docs/design/2D.3-reusable-templates.md §11). */

export const MAX_TEMPLATES_PER_WORKSPACE = 200;
export const MAX_TEMPLATE_MILESTONES = 50;
export const MAX_TEMPLATE_TASKS = 300;
export const MAX_TEMPLATE_DEPENDENCIES = 600;
export const MAX_CHECKLIST_ITEMS_PER_TASK = 50;
export const MAX_TEMPLATE_CHECKLIST_ITEMS = 1000;
export const MAX_TEMPLATE_DOCUMENTS = 25;

export const MAX_TEMPLATE_NAME = 160;
export const MAX_PROJECT_NAME = 160;
export const MAX_ITEM_TITLE = 200;
export const MAX_SHORT_DESCRIPTION = 2000;
export const MAX_TASK_DESCRIPTION = 20_000;
export const MAX_CHECKLIST_TEXT = 500;
export const MAX_DOCUMENT_CONTENT = 50_000;
export const MAX_TOTAL_DOCUMENT_CONTENT = 500_000;
export const MAX_DOCUMENT_CATEGORY = 120;

/** Relative offsets are whole days from the project start, 0 … 3650. */
export const MIN_DAY_OFFSET = 0;
export const MAX_DAY_OFFSET = 3650;

/** Largest accepted JSON request body for template writes. */
export const MAX_TEMPLATE_BODY_BYTES = 1_000_000;

/** Upper bound on rows one application can create (project + activity + application + items). */
export const MAX_RECORDS_PER_APPLICATION =
  1 +
  MAX_TEMPLATE_MILESTONES +
  MAX_TEMPLATE_TASKS +
  MAX_TEMPLATE_DEPENDENCIES +
  MAX_TEMPLATE_CHECKLIST_ITEMS +
  MAX_TEMPLATE_DOCUMENTS +
  2;
