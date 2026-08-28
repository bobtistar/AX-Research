CREATE TABLE `research_note_links` (
	`id` varchar(32) NOT NULL,
	`versionId` varchar(32) NOT NULL,
	`linkType` enum('WIKILINK','MARKDOWN_URL','IDENTIFIER') NOT NULL,
	`target` varchar(1024) NOT NULL,
	`label` text,
	`sourceLocator` varchar(255) NOT NULL,
	`createdAt` timestamp NOT NULL DEFAULT (now()),
	CONSTRAINT `research_note_links_id` PRIMARY KEY(`id`)
);
--> statement-breakpoint
ALTER TABLE `research_note_links` ADD CONSTRAINT `rnl_version_fk` FOREIGN KEY (`versionId`) REFERENCES `research_note_versions`(`id`) ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX `research_note_links_version_idx` ON `research_note_links` (`versionId`);