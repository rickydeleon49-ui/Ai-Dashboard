CREATE TABLE `agent_run_approval` (
	`id` text PRIMARY KEY NOT NULL,
	`run_id` text NOT NULL,
	`kind` text NOT NULL,
	`status` text DEFAULT 'pending' NOT NULL,
	`preview` text DEFAULT '{}' NOT NULL,
	`target` text DEFAULT '{}' NOT NULL,
	`result` text,
	`error` text,
	`requested_at` text DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')) NOT NULL,
	`decided_at` text,
	`executed_at` text,
	FOREIGN KEY (`run_id`) REFERENCES `agent_run`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `agent_run_approval_run_idx` ON `agent_run_approval` (`run_id`,`requested_at`);--> statement-breakpoint
CREATE INDEX `agent_run_approval_status_idx` ON `agent_run_approval` (`status`);