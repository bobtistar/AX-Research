ALTER TABLE `research_collection_notes` ADD CONSTRAINT `rcn_collection_fk` FOREIGN KEY (`collectionId`) REFERENCES `research_collections`(`id`) ON DELETE cascade ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE `research_collection_notes` ADD CONSTRAINT `rcn_note_fk` FOREIGN KEY (`noteId`) REFERENCES `research_notes`(`id`) ON DELETE cascade ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE `research_collections` ADD CONSTRAINT `rc_workspace_fk` FOREIGN KEY (`workspaceId`) REFERENCES `workspaces`(`id`) ON DELETE cascade ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE `research_note_sections` ADD CONSTRAINT `rns_version_fk` FOREIGN KEY (`versionId`) REFERENCES `research_note_versions`(`id`) ON DELETE cascade ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE `research_note_versions` ADD CONSTRAINT `rnv_note_fk` FOREIGN KEY (`noteId`) REFERENCES `research_notes`(`id`) ON DELETE cascade ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE `research_notes` ADD CONSTRAINT `rn_workspace_fk` FOREIGN KEY (`workspaceId`) REFERENCES `workspaces`(`id`) ON DELETE cascade ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE `workspaces` ADD CONSTRAINT `ws_user_fk` FOREIGN KEY (`userId`) REFERENCES `users`(`id`) ON DELETE cascade ON UPDATE no action;
