CREATE TABLE `research_collection_notes` (
	`collectionId` varchar(32) NOT NULL,
	`noteId` varchar(32) NOT NULL,
	`createdAt` timestamp NOT NULL DEFAULT (now()),
	CONSTRAINT `research_collection_notes_collectionId_noteId_pk` PRIMARY KEY(`collectionId`,`noteId`)
);
--> statement-breakpoint
CREATE TABLE `research_collections` (
	`id` varchar(32) NOT NULL,
	`workspaceId` varchar(32) NOT NULL,
	`name` varchar(160) NOT NULL,
	`description` text,
	`createdAt` timestamp NOT NULL DEFAULT (now()),
	`updatedAt` timestamp NOT NULL DEFAULT (now()) ON UPDATE CURRENT_TIMESTAMP,
	CONSTRAINT `research_collections_id` PRIMARY KEY(`id`)
);
--> statement-breakpoint
CREATE TABLE `research_note_sections` (
	`id` varchar(32) NOT NULL,
	`versionId` varchar(32) NOT NULL,
	`rawHeading` varchar(255) NOT NULL,
	`sectionType` enum('FRONTMATTER','CLAIM','SETTING','AUTHOR_LIMITATIONS','REVIEWER_CRITICISMS','USER_OBSERVATIONS','USER_CONTEXT','REPRODUCIBILITY','UNKNOWN') NOT NULL,
	`body` text NOT NULL,
	`explicitEmpty` boolean NOT NULL DEFAULT false,
	`sectionOrder` int NOT NULL,
	`createdAt` timestamp NOT NULL DEFAULT (now()),
	CONSTRAINT `research_note_sections_id` PRIMARY KEY(`id`)
);
--> statement-breakpoint
CREATE TABLE `research_note_versions` (
	`id` varchar(32) NOT NULL,
	`noteId` varchar(32) NOT NULL,
	`contentHash` varchar(64) NOT NULL,
	`rawStorageKey` varchar(512) NOT NULL,
	`parserVersion` varchar(32) NOT NULL,
	`parsedMetadata` text NOT NULL,
	`parseWarnings` text NOT NULL,
	`createdAt` timestamp NOT NULL DEFAULT (now()),
	CONSTRAINT `research_note_versions_id` PRIMARY KEY(`id`)
);
--> statement-breakpoint
CREATE TABLE `research_notes` (
	`id` varchar(32) NOT NULL,
	`workspaceId` varchar(32) NOT NULL,
	`sourcePath` varchar(512) NOT NULL,
	`externalId` varchar(256),
	`title` text NOT NULL,
	`visibility` enum('PRIVATE') NOT NULL DEFAULT 'PRIVATE',
	`createdAt` timestamp NOT NULL DEFAULT (now()),
	`updatedAt` timestamp NOT NULL DEFAULT (now()) ON UPDATE CURRENT_TIMESTAMP,
	CONSTRAINT `research_notes_id` PRIMARY KEY(`id`)
);
--> statement-breakpoint
CREATE TABLE `workspaces` (
	`id` varchar(32) NOT NULL,
	`userId` int NOT NULL,
	`name` varchar(160) NOT NULL,
	`createdAt` timestamp NOT NULL DEFAULT (now()),
	`updatedAt` timestamp NOT NULL DEFAULT (now()) ON UPDATE CURRENT_TIMESTAMP,
	CONSTRAINT `workspaces_id` PRIMARY KEY(`id`),
	CONSTRAINT `workspaces_userId_unique` UNIQUE(`userId`)
);
--> statement-breakpoint
ALTER TABLE `research_collection_notes` ADD CONSTRAINT `research_collection_notes_collectionId_research_collections_id_fk` FOREIGN KEY (`collectionId`) REFERENCES `research_collections`(`id`) ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE `research_collection_notes` ADD CONSTRAINT `research_collection_notes_noteId_research_notes_id_fk` FOREIGN KEY (`noteId`) REFERENCES `research_notes`(`id`) ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE `research_collections` ADD CONSTRAINT `research_collections_workspaceId_workspaces_id_fk` FOREIGN KEY (`workspaceId`) REFERENCES `workspaces`(`id`) ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE `research_note_sections` ADD CONSTRAINT `research_note_sections_versionId_research_note_versions_id_fk` FOREIGN KEY (`versionId`) REFERENCES `research_note_versions`(`id`) ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE `research_note_versions` ADD CONSTRAINT `research_note_versions_noteId_research_notes_id_fk` FOREIGN KEY (`noteId`) REFERENCES `research_notes`(`id`) ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE `research_notes` ADD CONSTRAINT `research_notes_workspaceId_workspaces_id_fk` FOREIGN KEY (`workspaceId`) REFERENCES `workspaces`(`id`) ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE `workspaces` ADD CONSTRAINT `workspaces_userId_users_id_fk` FOREIGN KEY (`userId`) REFERENCES `users`(`id`) ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX `research_collection_notes_note_idx` ON `research_collection_notes` (`noteId`);--> statement-breakpoint
CREATE INDEX `research_collections_workspace_idx` ON `research_collections` (`workspaceId`);--> statement-breakpoint
CREATE INDEX `research_note_sections_version_idx` ON `research_note_sections` (`versionId`);--> statement-breakpoint
CREATE INDEX `research_note_versions_note_idx` ON `research_note_versions` (`noteId`);--> statement-breakpoint
CREATE INDEX `research_note_versions_hash_idx` ON `research_note_versions` (`noteId`,`contentHash`);--> statement-breakpoint
CREATE INDEX `research_notes_workspace_idx` ON `research_notes` (`workspaceId`);--> statement-breakpoint
CREATE INDEX `research_notes_external_idx` ON `research_notes` (`workspaceId`,`externalId`);