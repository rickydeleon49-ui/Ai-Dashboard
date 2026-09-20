-- Phase 2C.2: Task assignment provenance (assigned_by, assigned_at)
ALTER TABLE "task" ADD COLUMN IF NOT EXISTS "assigned_by" text;
--> statement-breakpoint
ALTER TABLE "task" ADD COLUMN IF NOT EXISTS "assigned_at" timestamp;
--> statement-breakpoint
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'task_assigned_by_user_id_fk'
  ) THEN
    ALTER TABLE "task" ADD CONSTRAINT "task_assigned_by_user_id_fk" FOREIGN KEY ("assigned_by") REFERENCES "public"."user"("id") ON DELETE set null ON UPDATE no action;
  END IF;
END $$;
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "task_workspace_assigned_by_idx" ON "task" USING btree ("workspace_id","assigned_by");
