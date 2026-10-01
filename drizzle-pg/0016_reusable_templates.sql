-- Moved first by hand: drizzle-kit emits this last, but project_template_application_project_fk below references it.
ALTER TABLE "project" ADD CONSTRAINT "project_id_workspace_uq" UNIQUE("id","workspace_id");--> statement-breakpoint
CREATE TABLE "project_template_application" (
	"id" text PRIMARY KEY NOT NULL,
	"workspace_id" text NOT NULL,
	"actor_key" text NOT NULL,
	"idempotency_key" text NOT NULL,
	"request_hash" text NOT NULL,
	"template_id" text,
	"template_workspace_id" text,
	"project_id" text,
	"project_workspace_id" text,
	"created_at" timestamp DEFAULT now() NOT NULL,
	CONSTRAINT "project_template_application_template_ws_check" CHECK (("project_template_application"."template_id" is null and "project_template_application"."template_workspace_id" is null) or ("project_template_application"."template_id" is not null and "project_template_application"."template_workspace_id" is not null and "project_template_application"."template_workspace_id" = "project_template_application"."workspace_id")),
	CONSTRAINT "project_template_application_project_ws_check" CHECK (("project_template_application"."project_id" is null and "project_template_application"."project_workspace_id" is null) or ("project_template_application"."project_id" is not null and "project_template_application"."project_workspace_id" is not null and "project_template_application"."project_workspace_id" = "project_template_application"."workspace_id"))
);
--> statement-breakpoint
CREATE TABLE "project_template_checklist_item" (
	"id" text PRIMARY KEY NOT NULL,
	"template_id" text NOT NULL,
	"workspace_id" text NOT NULL,
	"task_key" text NOT NULL,
	"position" integer NOT NULL,
	"text" text NOT NULL
);
--> statement-breakpoint
CREATE TABLE "project_template_dependency" (
	"template_id" text NOT NULL,
	"workspace_id" text NOT NULL,
	"task_key" text NOT NULL,
	"depends_on_key" text NOT NULL,
	CONSTRAINT "project_template_dependency_pk" PRIMARY KEY("template_id","task_key","depends_on_key"),
	CONSTRAINT "project_template_dependency_no_self_check" CHECK ("project_template_dependency"."task_key" <> "project_template_dependency"."depends_on_key")
);
--> statement-breakpoint
CREATE TABLE "project_template_document" (
	"id" text PRIMARY KEY NOT NULL,
	"template_id" text NOT NULL,
	"workspace_id" text NOT NULL,
	"position" integer NOT NULL,
	"title" text NOT NULL,
	"content" text DEFAULT '' NOT NULL,
	"category" text,
	"pinned" boolean DEFAULT false NOT NULL
);
--> statement-breakpoint
CREATE TABLE "project_template_milestone" (
	"id" text PRIMARY KEY NOT NULL,
	"template_id" text NOT NULL,
	"workspace_id" text NOT NULL,
	"key" text NOT NULL,
	"position" integer NOT NULL,
	"title" text NOT NULL,
	"description" text,
	"target_offset" integer,
	CONSTRAINT "project_template_milestone_key_uq" UNIQUE("template_id","workspace_id","key"),
	CONSTRAINT "project_template_milestone_offset_check" CHECK ("project_template_milestone"."target_offset" is null or ("project_template_milestone"."target_offset" >= 0 and "project_template_milestone"."target_offset" <= 3650))
);
--> statement-breakpoint
CREATE TABLE "project_template_task" (
	"id" text PRIMARY KEY NOT NULL,
	"template_id" text NOT NULL,
	"workspace_id" text NOT NULL,
	"key" text NOT NULL,
	"position" integer NOT NULL,
	"title" text NOT NULL,
	"description" text,
	"priority" text DEFAULT 'medium' NOT NULL,
	"due_offset" integer,
	"milestone_key" text,
	"parent_key" text,
	CONSTRAINT "project_template_task_key_uq" UNIQUE("template_id","workspace_id","key"),
	CONSTRAINT "project_template_task_priority_check" CHECK ("project_template_task"."priority" in ('low', 'medium', 'high', 'urgent')),
	CONSTRAINT "project_template_task_offset_check" CHECK ("project_template_task"."due_offset" is null or ("project_template_task"."due_offset" >= 0 and "project_template_task"."due_offset" <= 3650)),
	CONSTRAINT "project_template_task_not_own_parent_check" CHECK ("project_template_task"."parent_key" is null or "project_template_task"."parent_key" <> "project_template_task"."key")
);
--> statement-breakpoint
CREATE TABLE "project_template" (
	"id" text PRIMARY KEY NOT NULL,
	"workspace_id" text NOT NULL,
	"name" text NOT NULL,
	"description" text,
	"project_name" text NOT NULL,
	"project_description" text,
	"project_type" text DEFAULT 'software' NOT NULL,
	"project_status" text DEFAULT 'idea' NOT NULL,
	"created_by" text,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL,
	CONSTRAINT "project_template_id_workspace_uq" UNIQUE("id","workspace_id"),
	CONSTRAINT "project_template_status_check" CHECK ("project_template"."project_status" in ('idea', 'planning', 'active'))
);
--> statement-breakpoint
ALTER TABLE "project_template_application" ADD CONSTRAINT "project_template_application_workspace_id_workspace_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspace"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "project_template_application" ADD CONSTRAINT "project_template_application_template_fk" FOREIGN KEY ("template_id","template_workspace_id") REFERENCES "public"."project_template"("id","workspace_id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "project_template_application" ADD CONSTRAINT "project_template_application_project_fk" FOREIGN KEY ("project_id","project_workspace_id") REFERENCES "public"."project"("id","workspace_id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "project_template_checklist_item" ADD CONSTRAINT "project_template_checklist_item_workspace_id_workspace_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspace"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "project_template_checklist_item" ADD CONSTRAINT "project_template_checklist_item_template_fk" FOREIGN KEY ("template_id","workspace_id") REFERENCES "public"."project_template"("id","workspace_id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "project_template_checklist_item" ADD CONSTRAINT "project_template_checklist_item_task_fk" FOREIGN KEY ("template_id","workspace_id","task_key") REFERENCES "public"."project_template_task"("template_id","workspace_id","key") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "project_template_dependency" ADD CONSTRAINT "project_template_dependency_workspace_id_workspace_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspace"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "project_template_dependency" ADD CONSTRAINT "project_template_dependency_template_fk" FOREIGN KEY ("template_id","workspace_id") REFERENCES "public"."project_template"("id","workspace_id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "project_template_dependency" ADD CONSTRAINT "project_template_dependency_task_fk" FOREIGN KEY ("template_id","workspace_id","task_key") REFERENCES "public"."project_template_task"("template_id","workspace_id","key") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "project_template_dependency" ADD CONSTRAINT "project_template_dependency_depends_on_fk" FOREIGN KEY ("template_id","workspace_id","depends_on_key") REFERENCES "public"."project_template_task"("template_id","workspace_id","key") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "project_template_document" ADD CONSTRAINT "project_template_document_workspace_id_workspace_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspace"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "project_template_document" ADD CONSTRAINT "project_template_document_template_fk" FOREIGN KEY ("template_id","workspace_id") REFERENCES "public"."project_template"("id","workspace_id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "project_template_milestone" ADD CONSTRAINT "project_template_milestone_workspace_id_workspace_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspace"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "project_template_milestone" ADD CONSTRAINT "project_template_milestone_template_fk" FOREIGN KEY ("template_id","workspace_id") REFERENCES "public"."project_template"("id","workspace_id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "project_template_task" ADD CONSTRAINT "project_template_task_workspace_id_workspace_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspace"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "project_template_task" ADD CONSTRAINT "project_template_task_template_fk" FOREIGN KEY ("template_id","workspace_id") REFERENCES "public"."project_template"("id","workspace_id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "project_template_task" ADD CONSTRAINT "project_template_task_milestone_fk" FOREIGN KEY ("template_id","workspace_id","milestone_key") REFERENCES "public"."project_template_milestone"("template_id","workspace_id","key") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "project_template_task" ADD CONSTRAINT "project_template_task_parent_fk" FOREIGN KEY ("template_id","workspace_id","parent_key") REFERENCES "public"."project_template_task"("template_id","workspace_id","key") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "project_template" ADD CONSTRAINT "project_template_workspace_id_workspace_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspace"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "project_template" ADD CONSTRAINT "project_template_created_by_user_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."user"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "project_template_application_key_uq" ON "project_template_application" USING btree ("workspace_id","actor_key","idempotency_key");--> statement-breakpoint
CREATE UNIQUE INDEX "project_template_checklist_item_pos_uq" ON "project_template_checklist_item" USING btree ("template_id","task_key","position");--> statement-breakpoint
CREATE UNIQUE INDEX "project_template_document_pos_uq" ON "project_template_document" USING btree ("template_id","position");--> statement-breakpoint
CREATE INDEX "project_template_milestone_workspace_idx" ON "project_template_milestone" USING btree ("workspace_id","template_id");--> statement-breakpoint
CREATE INDEX "project_template_task_workspace_idx" ON "project_template_task" USING btree ("workspace_id","template_id");--> statement-breakpoint
CREATE INDEX "project_template_workspace_name_idx" ON "project_template" USING btree ("workspace_id","name");