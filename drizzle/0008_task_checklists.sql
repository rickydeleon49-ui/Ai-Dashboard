CREATE TABLE `task_checklist_item` (
	`id` text PRIMARY KEY NOT NULL,
	`workspace_id` text DEFAULT 'default' NOT NULL,
	`task_id` text NOT NULL,
	`position` integer NOT NULL,
	`text` text NOT NULL,
	`done` integer DEFAULT 0 NOT NULL,
	`done_by` text,
	`done_at` text,
	`created_by` text,
	`created_at` text DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')) NOT NULL,
	`updated_at` text DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')) NOT NULL,
	FOREIGN KEY (`task_id`) REFERENCES `tasks`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `task_checklist_item_task_pos_idx` ON `task_checklist_item` (`task_id`,`position`);--> statement-breakpoint
CREATE INDEX `task_checklist_item_workspace_task_idx` ON `task_checklist_item` (`workspace_id`,`task_id`);
