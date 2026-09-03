CREATE TABLE `research_inference_reviews` (
	`id` varchar(32) NOT NULL,
	`workspaceId` varchar(32) NOT NULL,
	`runId` varchar(32) NOT NULL,
	`targetKind` enum('CLAIM','MISSING') NOT NULL,
	`noteId` varchar(32) NOT NULL,
	`sectionType` varchar(32) NOT NULL,
	`verdict` enum('APPROVED','REJECTED') NOT NULL,
	`correctedQuote` text,
	`reviewerNote` text,
	`sourceVersionIds` text NOT NULL,
	`promptVersion` varchar(32) NOT NULL,
	`model` varchar(160) NOT NULL,
	`createdAt` timestamp NOT NULL DEFAULT (now()),
	`updatedAt` timestamp NOT NULL DEFAULT (now()) ON UPDATE CURRENT_TIMESTAMP,
	CONSTRAINT `research_inference_reviews_id` PRIMARY KEY(`id`),
	CONSTRAINT `inference_reviews_cell_idx` UNIQUE(`runId`,`targetKind`,`noteId`,`sectionType`)
);
--> statement-breakpoint
ALTER TABLE `research_inference_reviews` ADD CONSTRAINT `rirev_workspace_fk` FOREIGN KEY (`workspaceId`) REFERENCES `workspaces`(`id`) ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE `research_inference_reviews` ADD CONSTRAINT `rirev_run_fk` FOREIGN KEY (`runId`) REFERENCES `research_inference_runs`(`id`) ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX `inference_reviews_workspace_idx` ON `research_inference_reviews` (`workspaceId`,`createdAt`);