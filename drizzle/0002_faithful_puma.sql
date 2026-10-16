CREATE TABLE `absence_requests` (
	`id` text PRIMARY KEY NOT NULL,
	`user_id` text NOT NULL,
	`start_date` text NOT NULL,
	`end_date` text NOT NULL,
	`type` text NOT NULL,
	`note` text DEFAULT '' NOT NULL,
	`status` text DEFAULT 'pending' NOT NULL,
	`created_at` integer NOT NULL,
	`decided_at` integer,
	`decided_by` text,
	`decision_note` text DEFAULT '' NOT NULL,
	`absence_id` text,
	`version` integer DEFAULT 1 NOT NULL,
	FOREIGN KEY (`user_id`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`decided_by`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE set null,
	FOREIGN KEY (`absence_id`) REFERENCES `absences`(`id`) ON UPDATE no action ON DELETE set null,
	CONSTRAINT "absence_requests_type_check" CHECK("absence_requests"."type" IN ('vacation', 'day_off')),
	CONSTRAINT "absence_requests_status_check" CHECK("absence_requests"."status" IN ('pending', 'approved', 'rejected', 'cancelled')),
	CONSTRAINT "absence_requests_date_check" CHECK("absence_requests"."end_date" >= "absence_requests"."start_date")
);
--> statement-breakpoint
CREATE INDEX `absence_requests_user_status_dates` ON `absence_requests` (`user_id`,`status`,`start_date`,`end_date`);--> statement-breakpoint
CREATE INDEX `absence_requests_status_created` ON `absence_requests` (`status`,`created_at`);