CREATE TABLE `agent_project_policy` (
	`project_id` text PRIMARY KEY NOT NULL,
	`check_commands` text DEFAULT '[]' NOT NULL,
	`excluded_paths` text DEFAULT '[]' NOT NULL,
	`test_restrictions` text DEFAULT '[]' NOT NULL,
	`defaults` text DEFAULT '{}' NOT NULL,
	`roadmap_source` text,
	`created_at` text DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')) NOT NULL,
	`updated_at` text DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')) NOT NULL,
	FOREIGN KEY (`project_id`) REFERENCES `projects`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE TABLE `agent_run` (
	`id` text PRIMARY KEY NOT NULL,
	`project_id` text NOT NULL,
	`status` text DEFAULT 'queued' NOT NULL,
	`stage` text,
	`request` text DEFAULT '{}' NOT NULL,
	`workspace_kind` text,
	`workspace_path` text,
	`base_ref` text,
	`branch` text,
	`correction_round` integer DEFAULT 0 NOT NULL,
	`outcome` text,
	`runner_epoch` text,
	`created_at` text DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')) NOT NULL,
	`updated_at` text DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')) NOT NULL,
	`ended_at` text,
	FOREIGN KEY (`project_id`) REFERENCES `projects`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `agent_run_project_created_idx` ON `agent_run` (`project_id`,`created_at`);--> statement-breakpoint
CREATE INDEX `agent_run_status_idx` ON `agent_run` (`status`);--> statement-breakpoint
CREATE TABLE `agent_run_event` (
	`run_id` text NOT NULL,
	`seq` integer NOT NULL,
	`ts` text DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')) NOT NULL,
	`stage` text,
	`agent` text NOT NULL,
	`kind` text NOT NULL,
	`payload` text DEFAULT '{}' NOT NULL,
	PRIMARY KEY(`run_id`, `seq`),
	FOREIGN KEY (`run_id`) REFERENCES `agent_run`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE TABLE `agent_run_intent` (
	`id` text PRIMARY KEY NOT NULL,
	`run_id` text NOT NULL,
	`kind` text NOT NULL,
	`payload` text DEFAULT '{}' NOT NULL,
	`created_at` text DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')) NOT NULL,
	`claimed_at` text,
	FOREIGN KEY (`run_id`) REFERENCES `agent_run`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `agent_run_intent_queue_idx` ON `agent_run_intent` (`claimed_at`,`created_at`);--> statement-breakpoint
CREATE TABLE `agent_workspace_lock` (
	`lock_key` text PRIMARY KEY NOT NULL,
	`run_id` text NOT NULL,
	`created_at` text DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')) NOT NULL,
	FOREIGN KEY (`run_id`) REFERENCES `agent_run`(`id`) ON UPDATE no action ON DELETE cascade
);
