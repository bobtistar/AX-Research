CREATE TABLE `paper_candidates` (
	`id` varchar(32) NOT NULL,
	`runId` varchar(32) NOT NULL,
	`openAlexId` varchar(128) NOT NULL,
	`doi` varchar(512),
	`title` text NOT NULL,
	`venue` varchar(256) NOT NULL,
	`venueCode` varchar(24) NOT NULL,
	`year` int,
	`citedByCount` int NOT NULL DEFAULT 0,
	`sourceUrl` text NOT NULL,
	`provenance` text NOT NULL,
	`isEligible` boolean NOT NULL DEFAULT true,
	`isSeed` boolean NOT NULL DEFAULT false,
	`createdAt` timestamp NOT NULL DEFAULT (now()),
	CONSTRAINT `paper_candidates_id` PRIMARY KEY(`id`)
);
--> statement-breakpoint
CREATE TABLE `research_queries` (
	`id` varchar(32) NOT NULL,
	`runId` varchar(32) NOT NULL,
	`position` int NOT NULL,
	`text` text NOT NULL,
	`status` enum('PROPOSED','CONFIRMED') NOT NULL DEFAULT 'PROPOSED',
	`createdAt` timestamp NOT NULL DEFAULT (now()),
	CONSTRAINT `research_queries_id` PRIMARY KEY(`id`)
);
--> statement-breakpoint
CREATE TABLE `research_runs` (
	`id` varchar(32) NOT NULL,
	`userId` int NOT NULL,
	`topic` text NOT NULL,
	`desiredSeedCount` int NOT NULL,
	`status` enum('DRAFT','QUERIES_READY','CANDIDATES_READY','SEEDS_LOCKED','FAILED') NOT NULL DEFAULT 'DRAFT',
	`queryCount` int NOT NULL DEFAULT 0,
	`candidateCount` int NOT NULL DEFAULT 0,
	`seedCount` int NOT NULL DEFAULT 0,
	`totalRetrieved` int NOT NULL DEFAULT 0,
	`venueExcluded` int NOT NULL DEFAULT 0,
	`duplicatesRemoved` int NOT NULL DEFAULT 0,
	`failureCount` int NOT NULL DEFAULT 0,
	`errorMessage` text,
	`createdAt` timestamp NOT NULL DEFAULT (now()),
	`updatedAt` timestamp NOT NULL DEFAULT (now()) ON UPDATE CURRENT_TIMESTAMP,
	CONSTRAINT `research_runs_id` PRIMARY KEY(`id`)
);
--> statement-breakpoint
ALTER TABLE `paper_candidates` ADD CONSTRAINT `paper_candidates_runId_research_runs_id_fk` FOREIGN KEY (`runId`) REFERENCES `research_runs`(`id`) ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE `research_queries` ADD CONSTRAINT `research_queries_runId_research_runs_id_fk` FOREIGN KEY (`runId`) REFERENCES `research_runs`(`id`) ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE `research_runs` ADD CONSTRAINT `research_runs_userId_users_id_fk` FOREIGN KEY (`userId`) REFERENCES `users`(`id`) ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX `paper_candidates_run_idx` ON `paper_candidates` (`runId`);--> statement-breakpoint
CREATE INDEX `paper_candidates_openalex_idx` ON `paper_candidates` (`openAlexId`);--> statement-breakpoint
CREATE INDEX `research_queries_run_position_idx` ON `research_queries` (`runId`,`position`);--> statement-breakpoint
CREATE INDEX `research_runs_user_created_idx` ON `research_runs` (`userId`,`createdAt`);