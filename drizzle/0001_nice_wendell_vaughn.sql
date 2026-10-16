CREATE TABLE `absences` (
	`id` text PRIMARY KEY NOT NULL,
	`user_id` text NOT NULL,
	`start_date` text NOT NULL,
	`end_date` text NOT NULL,
	`type` text NOT NULL,
	`note` text DEFAULT '' NOT NULL,
	`created_at` integer NOT NULL,
	`version` integer DEFAULT 1 NOT NULL,
	FOREIGN KEY (`user_id`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE no action,
	CONSTRAINT "absences_type_check" CHECK("absences"."type" IN ('vacation', 'day_off', 'other')),
	CONSTRAINT "absences_date_check" CHECK("absences"."end_date" >= "absences"."start_date")
);
--> statement-breakpoint
CREATE INDEX `absences_user_dates` ON `absences` (`user_id`,`start_date`,`end_date`);