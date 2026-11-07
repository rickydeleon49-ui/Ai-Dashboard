CREATE TABLE `agent_run_comment` (
	`id` text PRIMARY KEY NOT NULL,
	`run_id` text NOT NULL,
	`round` integer NOT NULL,
	`file` text,
	`line` integer,
	`body` text NOT NULL,
	`created_at` text DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')) NOT NULL,
	FOREIGN KEY (`run_id`) REFERENCES `agent_run`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `agent_run_comment_run_round_idx` ON `agent_run_comment` (`run_id`,`round`,`created_at`);