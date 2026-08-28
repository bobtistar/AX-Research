CREATE TABLE `research_inference_runs` (
	`id` varchar(32) NOT NULL,
	`workspaceId` varchar(32) NOT NULL,
	`question` text NOT NULL,
	`noteVersionIds` text NOT NULL,
	`model` varchar(160) NOT NULL,
	`promptVersion` varchar(32) NOT NULL,
	`status` enum('RUNNING','SUCCEEDED','PARTIAL','FAILED','STALE') NOT NULL DEFAULT 'RUNNING',
	`resultJson` text,
	`evidenceCount` int NOT NULL DEFAULT 0,
	`missingCount` int NOT NULL DEFAULT 0,
	`createdAt` timestamp NOT NULL DEFAULT (now()),
	`updatedAt` timestamp NOT NULL DEFAULT (now()) ON UPDATE CURRENT_TIMESTAMP,
	CONSTRAINT `research_inference_runs_id` PRIMARY KEY(`id`)
);
--> statement-breakpoint
ALTER TABLE `research_inference_runs` ADD CONSTRAINT `rir_workspace_fk` FOREIGN KEY (`workspaceId`) REFERENCES `workspaces`(`id`) ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX `inference_runs_workspace_idx` ON `research_inference_runs` (`workspaceId`,`createdAt`);