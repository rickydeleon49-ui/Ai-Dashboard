CREATE TABLE "notification" (
	"id" text PRIMARY KEY NOT NULL,
	"workspace_id" text NOT NULL,
	"recipient_id" text NOT NULL,
	"actor_id" text,
	"category" text NOT NULL,
	"source_event_id" text NOT NULL,
	"task_id" text,
	"project_id" text,
	"comment_id" text,
	"details" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"read_at" timestamp,
	"archived_at" timestamp,
	"created_at" timestamp DEFAULT now() NOT NULL,
	CONSTRAINT "notification_category_check" CHECK ("notification"."category" in ('assignment', 'mention', 'comment', 'due_date'))
);
--> statement-breakpoint
CREATE TABLE "notification_preference" (
	"workspace_id" text NOT NULL,
	"user_id" text NOT NULL,
	"category" text NOT NULL,
	"enabled" boolean NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL,
	CONSTRAINT "notification_preference_workspace_id_user_id_category_pk" PRIMARY KEY("workspace_id","user_id","category"),
	CONSTRAINT "notification_preference_category_check" CHECK ("notification_preference"."category" in ('assignment', 'mention', 'comment', 'due_date'))
);
--> statement-breakpoint
ALTER TABLE "notification" ADD CONSTRAINT "notification_workspace_id_workspace_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspace"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "notification" ADD CONSTRAINT "notification_recipient_id_user_id_fk" FOREIGN KEY ("recipient_id") REFERENCES "public"."user"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "notification" ADD CONSTRAINT "notification_actor_id_user_id_fk" FOREIGN KEY ("actor_id") REFERENCES "public"."user"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "notification" ADD CONSTRAINT "notification_task_id_task_id_fk" FOREIGN KEY ("task_id") REFERENCES "public"."task"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "notification" ADD CONSTRAINT "notification_project_id_project_id_fk" FOREIGN KEY ("project_id") REFERENCES "public"."project"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "notification" ADD CONSTRAINT "notification_comment_id_task_comment_id_fk" FOREIGN KEY ("comment_id") REFERENCES "public"."task_comment"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "notification_preference" ADD CONSTRAINT "notification_preference_workspace_id_workspace_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspace"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "notification_preference" ADD CONSTRAINT "notification_preference_user_id_user_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."user"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "notification_recipient_source_uq" ON "notification" USING btree ("recipient_id","source_event_id");--> statement-breakpoint
CREATE INDEX "notification_inbox_idx" ON "notification" USING btree ("recipient_id","workspace_id","created_at" DESC NULLS LAST,"id" DESC NULLS LAST);--> statement-breakpoint
CREATE INDEX "notification_unread_idx" ON "notification" USING btree ("recipient_id","workspace_id") WHERE "notification"."read_at" is null and "notification"."archived_at" is null;--> statement-breakpoint
CREATE INDEX "notification_workspace_idx" ON "notification" USING btree ("workspace_id");--> statement-breakpoint
CREATE INDEX "notification_task_idx" ON "notification" USING btree ("task_id") WHERE "notification"."task_id" is not null;--> statement-breakpoint
CREATE INDEX "notification_project_idx" ON "notification" USING btree ("project_id") WHERE "notification"."project_id" is not null;--> statement-breakpoint
CREATE INDEX "notification_comment_idx" ON "notification" USING btree ("comment_id") WHERE "notification"."comment_id" is not null;--> statement-breakpoint
CREATE INDEX "notification_actor_idx" ON "notification" USING btree ("actor_id") WHERE "notification"."actor_id" is not null;
