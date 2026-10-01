CREATE TABLE `project_template_applications` (
	`id` text PRIMARY KEY NOT NULL,
	`actor_key` text NOT NULL,
	`idempotency_key` text NOT NULL,
	`request_hash` text NOT NULL,
	`template_id` text,
	`project_id` text,
	`created_at` text DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')) NOT NULL,
	FOREIGN KEY (`template_id`) REFERENCES `project_templates`(`id`) ON UPDATE no action ON DELETE set null,
	FOREIGN KEY (`project_id`) REFERENCES `projects`(`id`) ON UPDATE no action ON DELETE set null
);
--> statement-breakpoint
CREATE UNIQUE INDEX `project_template_applications_key_uq` ON `project_template_applications` (`actor_key`,`idempotency_key`);--> statement-breakpoint
CREATE TABLE `project_template_checklist_items` (
	`id` text PRIMARY KEY NOT NULL,
	`template_id` text NOT NULL,
	`task_key` text NOT NULL,
	`position` integer NOT NULL,
	`text` text NOT NULL,
	FOREIGN KEY (`template_id`) REFERENCES `project_templates`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`template_id`,`task_key`) REFERENCES `project_template_tasks`(`template_id`,`key`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE UNIQUE INDEX `project_template_checklist_items_pos_uq` ON `project_template_checklist_items` (`template_id`,`task_key`,`position`);--> statement-breakpoint
CREATE TABLE `project_template_dependencies` (
	`template_id` text NOT NULL,
	`task_key` text NOT NULL,
	`depends_on_key` text NOT NULL,
	PRIMARY KEY(`template_id`, `task_key`, `depends_on_key`),
	FOREIGN KEY (`template_id`) REFERENCES `project_templates`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`template_id`,`task_key`) REFERENCES `project_template_tasks`(`template_id`,`key`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`template_id`,`depends_on_key`) REFERENCES `project_template_tasks`(`template_id`,`key`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE TABLE `project_template_documents` (
	`id` text PRIMARY KEY NOT NULL,
	`template_id` text NOT NULL,
	`position` integer NOT NULL,
	`title` text NOT NULL,
	`content` text DEFAULT '' NOT NULL,
	`category` text,
	`pinned` integer DEFAULT false NOT NULL,
	FOREIGN KEY (`template_id`) REFERENCES `project_templates`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE UNIQUE INDEX `project_template_documents_pos_uq` ON `project_template_documents` (`template_id`,`position`);--> statement-breakpoint
CREATE TABLE `project_template_milestones` (
	`id` text PRIMARY KEY NOT NULL,
	`template_id` text NOT NULL,
	`key` text NOT NULL,
	`position` integer NOT NULL,
	`title` text NOT NULL,
	`description` text,
	`target_offset` integer,
	FOREIGN KEY (`template_id`) REFERENCES `project_templates`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE UNIQUE INDEX `project_template_milestones_key_uq` ON `project_template_milestones` (`template_id`,`key`);--> statement-breakpoint
CREATE TABLE `project_template_tasks` (
	`id` text PRIMARY KEY NOT NULL,
	`template_id` text NOT NULL,
	`key` text NOT NULL,
	`position` integer NOT NULL,
	`title` text NOT NULL,
	`description` text,
	`priority` text DEFAULT 'medium' NOT NULL,
	`due_offset` integer,
	`milestone_key` text,
	`parent_key` text,
	FOREIGN KEY (`template_id`) REFERENCES `project_templates`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`template_id`,`milestone_key`) REFERENCES `project_template_milestones`(`template_id`,`key`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`template_id`,`parent_key`) REFERENCES `project_template_tasks`(`template_id`,`key`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE UNIQUE INDEX `project_template_tasks_key_uq` ON `project_template_tasks` (`template_id`,`key`);--> statement-breakpoint
CREATE TABLE `project_templates` (
	`id` text PRIMARY KEY NOT NULL,
	`name` text NOT NULL,
	`description` text,
	`project_name` text NOT NULL,
	`project_description` text,
	`project_type` text DEFAULT 'software' NOT NULL,
	`project_status` text DEFAULT 'idea' NOT NULL,
	`created_at` text DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')) NOT NULL,
	`updated_at` text DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')) NOT NULL
);
--> statement-breakpoint
CREATE INDEX `project_templates_name_idx` ON `project_templates` (`name`);