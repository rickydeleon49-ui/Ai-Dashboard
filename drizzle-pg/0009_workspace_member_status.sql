-- Phase 2C.1: Add membership status lifecycle to workspace_member
ALTER TABLE "workspace_member" ADD COLUMN IF NOT EXISTS "status" text DEFAULT 'active' NOT NULL;
--> statement-breakpoint
UPDATE "workspace_member" SET "status" = 'active' WHERE "status" IS NULL;
--> statement-breakpoint
ALTER TABLE "workspace_member" ADD CONSTRAINT "workspace_member_status_check" CHECK ("status" in ('active', 'invited', 'suspended', 'removed'));
