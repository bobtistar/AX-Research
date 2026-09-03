CREATE TABLE `deleted_storage_objects` (
	`id` varchar(32) NOT NULL,
	`workspaceId` varchar(32) NOT NULL,
	`noteId` varchar(32) NOT NULL,
	`storageKey` varchar(512) NOT NULL,
	`reason` enum('NOTE_DELETED','COLLECTION_DELETED') NOT NULL DEFAULT 'NOTE_DELETED',
	`purgedAt` timestamp,
	`createdAt` timestamp NOT NULL DEFAULT (now()),
	CONSTRAINT `deleted_storage_objects_id` PRIMARY KEY(`id`)
);
--> statement-breakpoint
CREATE INDEX `deleted_storage_objects_purged_idx` ON `deleted_storage_objects` (`purgedAt`,`createdAt`);--> statement-breakpoint
CREATE INDEX `deleted_storage_objects_workspace_idx` ON `deleted_storage_objects` (`workspaceId`);