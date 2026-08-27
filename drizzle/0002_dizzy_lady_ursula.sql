DROP INDEX `research_runs_user_created_idx` ON `research_runs`;--> statement-breakpoint
ALTER TABLE `research_runs` MODIFY COLUMN `userId` int;--> statement-breakpoint
ALTER TABLE `research_runs` ADD `guestKey` varchar(64);--> statement-breakpoint
CREATE INDEX `research_runs_guest_created_idx` ON `research_runs` (`guestKey`,`createdAt`);