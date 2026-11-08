ALTER TABLE `agent_run` ADD `task_id` text REFERENCES tasks(id) ON DELETE set null;--> statement-breakpoint
CREATE INDEX `agent_run_task_idx` ON `agent_run` (`task_id`);