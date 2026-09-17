-- Phase 2 hardening: Replace workspace creator deletion cascade with safe ownership lifecycle
ALTER TABLE "workspace" DROP CONSTRAINT IF EXISTS "workspace_created_by_user_id_fk";
--> statement-breakpoint
ALTER TABLE "workspace" ALTER COLUMN "created_by" DROP NOT NULL;
--> statement-breakpoint
ALTER TABLE "workspace" ADD CONSTRAINT "workspace_created_by_user_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."user"("id") ON DELETE SET NULL ON UPDATE no action;
--> statement-breakpoint
-- Pending invitations: allow invited_by to be null if inviter account is deleted
ALTER TABLE "workspace_invitation" DROP CONSTRAINT IF EXISTS "workspace_invitation_invited_by_user_id_fk";
--> statement-breakpoint
ALTER TABLE "workspace_invitation" ALTER COLUMN "invited_by" DROP NOT NULL;
--> statement-breakpoint
ALTER TABLE "workspace_invitation" ADD CONSTRAINT "workspace_invitation_invited_by_user_id_fk" FOREIGN KEY ("invited_by") REFERENCES "public"."user"("id") ON DELETE SET NULL ON UPDATE no action;
--> statement-breakpoint
-- Resumable and idempotent ownership claims
ALTER TABLE "ownership_claim" ADD COLUMN IF NOT EXISTS "status" text DEFAULT 'pending' NOT NULL;
--> statement-breakpoint
UPDATE "ownership_claim" SET "status" = 'completed';
--> statement-breakpoint
ALTER TABLE "ownership_claim" ADD CONSTRAINT "ownership_claim_status_check" CHECK ("status" in ('pending', 'running', 'partially_completed', 'completed', 'failed'));
--> statement-breakpoint
ALTER TABLE "ownership_claim" ADD COLUMN IF NOT EXISTS "imported_project_ids" jsonb DEFAULT '[]'::jsonb NOT NULL;
--> statement-breakpoint
ALTER TABLE "ownership_claim" ADD COLUMN IF NOT EXISTS "last_error" text;
--> statement-breakpoint
ALTER TABLE "ownership_claim" ADD COLUMN IF NOT EXISTS "updated_at" timestamp DEFAULT now() NOT NULL;
