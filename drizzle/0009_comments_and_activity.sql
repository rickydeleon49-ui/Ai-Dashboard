CREATE TABLE `task_comment` (
	`id` text PRIMARY KEY NOT NULL,
	`workspace_id` text DEFAULT 'default' NOT NULL,
	`task_id` text NOT NULL,
	`author_id` text,
	`body` text NOT NULL,
	`deleted_at` text,
	`deleted_by` text,
	`created_at` text DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')) NOT NULL,
	`updated_at` text DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')) NOT NULL,
	FOREIGN KEY (`task_id`) REFERENCES `tasks`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `task_comment_task_created_idx` ON `task_comment` (`task_id`,`created_at`);--> statement-breakpoint
CREATE INDEX `task_comment_workspace_task_idx` ON `task_comment` (`workspace_id`,`task_id`);--> statement-breakpoint
CREATE TABLE `task_comment_edit` (
	`id` text PRIMARY KEY NOT NULL,
	`comment_id` text NOT NULL,
	`edited_by` text,
	`previous_body` text NOT NULL,
	`created_at` text DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')) NOT NULL,
	FOREIGN KEY (`comment_id`) REFERENCES `task_comment`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `task_comment_edit_comment_idx` ON `task_comment_edit` (`comment_id`,`created_at`);--> statement-breakpoint
CREATE TABLE `task_activity_event` (
	`id` text PRIMARY KEY NOT NULL,
	`workspace_id` text DEFAULT 'default' NOT NULL,
	`project_id` text NOT NULL,
	`task_id` text NOT NULL,
	`actor_id` text,
	`type` text NOT NULL,
	`details` text DEFAULT '{}' NOT NULL,
	`created_at` text DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')) NOT NULL,
	FOREIGN KEY (`project_id`) REFERENCES `projects`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`task_id`) REFERENCES `tasks`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `task_activity_event_task_idx` ON `task_activity_event` (`task_id`,`created_at`);--> statement-breakpoint
CREATE INDEX `task_activity_event_project_idx` ON `task_activity_event` (`project_id`,`created_at`);--> statement-breakpoint
CREATE INDEX `task_activity_event_workspace_idx` ON `task_activity_event` (`workspace_id`,`created_at`);
