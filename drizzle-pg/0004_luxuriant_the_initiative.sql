CREATE TABLE "ownership_claim" (
	"id" text PRIMARY KEY NOT NULL,
	"claimed_by" text NOT NULL,
	"workspace_id" text NOT NULL,
	"projects_imported" integer DEFAULT 0 NOT NULL,
	"claimed_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "ownership_claim" ADD CONSTRAINT "ownership_claim_claimed_by_user_id_fk" FOREIGN KEY ("claimed_by") REFERENCES "public"."user"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "ownership_claim" ADD CONSTRAINT "ownership_claim_workspace_id_workspace_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspace"("id") ON DELETE cascade ON UPDATE no action;