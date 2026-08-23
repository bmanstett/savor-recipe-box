CREATE TABLE `attachments` (
	`id` text PRIMARY KEY NOT NULL,
	`household_id` text NOT NULL,
	`recipe_id` text,
	`storage_key` text NOT NULL,
	`mime_type` text NOT NULL,
	`original_filename` text NOT NULL,
	`byte_size` integer NOT NULL,
	`created_at` text NOT NULL
);
--> statement-breakpoint
CREATE INDEX `idx_attachments_household_recipe` ON `attachments` (`household_id`,`recipe_id`);--> statement-breakpoint
CREATE TABLE `grocery_items` (
	`id` text PRIMARY KEY NOT NULL,
	`household_id` text NOT NULL,
	`ingredient_name` text NOT NULL,
	`normalized_ingredient` text NOT NULL,
	`quantity` text,
	`unit` text,
	`grocery_category` text NOT NULL,
	`checked` integer DEFAULT false NOT NULL,
	`manual` integer DEFAULT false NOT NULL,
	`recipe_contributions` text NOT NULL,
	`sort_order` integer DEFAULT 0 NOT NULL,
	`revision` integer DEFAULT 1 NOT NULL,
	`date_modified` text NOT NULL
);
--> statement-breakpoint
CREATE INDEX `idx_grocery_household_category` ON `grocery_items` (`household_id`,`grocery_category`,`sort_order`);--> statement-breakpoint
CREATE TABLE `household_preferences` (
	`household_id` text PRIMARY KEY NOT NULL,
	`preferences` text NOT NULL,
	`revision` integer DEFAULT 1 NOT NULL,
	`date_modified` text NOT NULL
);
--> statement-breakpoint
CREATE TABLE `meal_plan_entries` (
	`id` text PRIMARY KEY NOT NULL,
	`household_id` text NOT NULL,
	`date` text NOT NULL,
	`meal_type` text NOT NULL,
	`recipe_id` text NOT NULL,
	`servings` integer,
	`revision` integer DEFAULT 1 NOT NULL,
	`date_modified` text NOT NULL
);
--> statement-breakpoint
CREATE INDEX `idx_meal_plan_household_date` ON `meal_plan_entries` (`household_id`,`date`);--> statement-breakpoint
CREATE INDEX `idx_meal_plan_recipe` ON `meal_plan_entries` (`recipe_id`);--> statement-breakpoint
CREATE TABLE `recipes` (
	`id` text PRIMARY KEY NOT NULL,
	`household_id` text NOT NULL,
	`title` text NOT NULL,
	`description` text DEFAULT '' NOT NULL,
	`hero_image` text,
	`source_type` text NOT NULL,
	`source_url` text,
	`source_name` text,
	`author` text,
	`servings` integer,
	`prep_time` integer,
	`cook_time` integer,
	`total_time` integer,
	`cuisine` text,
	`categories` text NOT NULL,
	`tags` text NOT NULL,
	`ingredients` text NOT NULL,
	`instructions` text NOT NULL,
	`rating` integer,
	`favorite` integer DEFAULT false NOT NULL,
	`notes` text DEFAULT '' NOT NULL,
	`attachments` text NOT NULL,
	`date_added` text NOT NULL,
	`date_modified` text NOT NULL,
	`last_cooked` text,
	`times_cooked` integer DEFAULT 0 NOT NULL,
	`revision` integer DEFAULT 1 NOT NULL,
	`deleted_at` text
);
--> statement-breakpoint
CREATE INDEX `idx_recipes_household_modified` ON `recipes` (`household_id`,`date_modified`);--> statement-breakpoint
CREATE INDEX `idx_recipes_household_title` ON `recipes` (`household_id`,`title`);