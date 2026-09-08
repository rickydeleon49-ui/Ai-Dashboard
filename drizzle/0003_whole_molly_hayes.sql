CREATE TABLE `ai_conversations` (
	`id` text PRIMARY KEY NOT NULL,
	`title` text DEFAULT 'New chat' NOT NULL,
	`provider` text DEFAULT 'local' NOT NULL,
	`mode` text DEFAULT 'chat' NOT NULL,
	`model` text,
	`project_id` text,
	`created_at` text DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')) NOT NULL,
	`updated_at` text DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')) NOT NULL,
	FOREIGN KEY (`project_id`) REFERENCES `projects`(`id`) ON UPDATE no action ON DELETE set null
);
--> statement-breakpoint
CREATE INDEX `ai_conversations_updated_idx` ON `ai_conversations` (`updated_at`);--> statement-breakpoint
CREATE TABLE `ai_messages` (
	`id` text PRIMARY KEY NOT NULL,
	`conversation_id` text NOT NULL,
	`role` text NOT NULL,
	`content` text DEFAULT '' NOT NULL,
	`model` text,
	`stopped_reason` text,
	`prompt_tokens` integer,
	`completion_tokens` integer,
	`duration_ms` integer,
	`created_at` text DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')) NOT NULL,
	FOREIGN KEY (`conversation_id`) REFERENCES `ai_conversations`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `ai_messages_conversation_idx` ON `ai_messages` (`conversation_id`,`created_at`);