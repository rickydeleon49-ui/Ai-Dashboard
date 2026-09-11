CREATE TABLE "milestone" (
	"id" text PRIMARY KEY NOT NULL,
	"workspace_id" text NOT NULL,
	"project_id" text NOT NULL,
	"title" text NOT NULL,
	"description" text,
	"status" text DEFAULT 'open' NOT NULL,
	"due_date" timestamp,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL,
	"completed_at" timestamp,
	CONSTRAINT "milestone_status_check" CHECK ("milestone"."status" in ('open', 'completed', 'cancelled'))
);
--> statement-breakpoint
CREATE TABLE "task" (
	"id" text PRIMARY KEY NOT NULL,
	"workspace_id" text NOT NULL,
	"project_id" text NOT NULL,
	"milestone_id" text,
	"parent_task_id" text,
	"title" text NOT NULL,
	"description" text,
	"status" text DEFAULT 'todo' NOT NULL,
	"priority" text DEFAULT 'medium' NOT NULL,
	"assignee_id" text,
	"due_date" timestamp,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL,
	"completed_at" timestamp,
	CONSTRAINT "task_status_check" CHECK ("task"."status" in ('todo', 'in_progress', 'done', 'cancelled')),
	CONSTRAINT "task_priority_check" CHECK ("task"."priority" in ('low', 'medium', 'high', 'urgent'))
);
--> statement-breakpoint
ALTER TABLE "milestone" ADD CONSTRAINT "milestone_workspace_id_workspace_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspace"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "milestone" ADD CONSTRAINT "milestone_project_id_project_id_fk" FOREIGN KEY ("project_id") REFERENCES "public"."project"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "task" ADD CONSTRAINT "task_workspace_id_workspace_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspace"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "task" ADD CONSTRAINT "task_project_id_project_id_fk" FOREIGN KEY ("project_id") REFERENCES "public"."project"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "task" ADD CONSTRAINT "task_milestone_id_milestone_id_fk" FOREIGN KEY ("milestone_id") REFERENCES "public"."milestone"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "task" ADD CONSTRAINT "task_parent_task_id_task_id_fk" FOREIGN KEY ("parent_task_id") REFERENCES "public"."task"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "task" ADD CONSTRAINT "task_assignee_id_user_id_fk" FOREIGN KEY ("assignee_id") REFERENCES "public"."user"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "milestone_project_idx" ON "milestone" USING btree ("project_id");--> statement-breakpoint
CREATE INDEX "milestone_workspace_due_idx" ON "milestone" USING btree ("workspace_id","due_date");--> statement-breakpoint
CREATE INDEX "task_project_idx" ON "task" USING btree ("project_id");--> statement-breakpoint
CREATE INDEX "task_milestone_idx" ON "task" USING btree ("milestone_id");--> statement-breakpoint
CREATE INDEX "task_parent_idx" ON "task" USING btree ("parent_task_id");--> statement-breakpoint
CREATE INDEX "task_workspace_assignee_idx" ON "task" USING btree ("workspace_id","assignee_id");--> statement-breakpoint
CREATE INDEX "task_workspace_due_idx" ON "task" USING btree ("workspace_id","due_date");