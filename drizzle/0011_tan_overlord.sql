CREATE TABLE `inference_usage` (
	`id` varchar(32) NOT NULL,
	`userId` int NOT NULL,
	`period` varchar(7) NOT NULL,
	`billedToOperator` boolean NOT NULL DEFAULT true,
	`model` varchar(160) NOT NULL,
	`createdAt` timestamp NOT NULL DEFAULT (now()),
	CONSTRAINT `inference_usage_id` PRIMARY KEY(`id`)
);
--> statement-breakpoint
CREATE TABLE `user_settings` (
	`userId` int NOT NULL,
	`geminiKeyCipher` text,
	`geminiKeyHint` varchar(8),
	`plan` enum('FREE','PRO') NOT NULL DEFAULT 'FREE',
	`createdAt` timestamp NOT NULL DEFAULT (now()),
	`updatedAt` timestamp NOT NULL DEFAULT (now()) ON UPDATE CURRENT_TIMESTAMP,
	CONSTRAINT `user_settings_userId` PRIMARY KEY(`userId`)
);
--> statement-breakpoint
ALTER TABLE `inference_usage` ADD CONSTRAINT `iu_user_fk` FOREIGN KEY (`userId`) REFERENCES `users`(`id`) ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE `user_settings` ADD CONSTRAINT `us_user_fk` FOREIGN KEY (`userId`) REFERENCES `users`(`id`) ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX `inference_usage_user_period_idx` ON `inference_usage` (`userId`,`period`,`billedToOperator`);