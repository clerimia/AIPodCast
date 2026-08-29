CREATE TABLE "synthesis_jobs" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"episode_id" uuid NOT NULL,
	"status" text DEFAULT 'pending' NOT NULL,
	"stage" text,
	"plan" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"done_line_ids" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"current_line" jsonb,
	"error" jsonb,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "synthesis_jobs" ADD CONSTRAINT "synthesis_jobs_episode_id_episodes_id_fk" FOREIGN KEY ("episode_id") REFERENCES "public"."episodes"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "synthesis_jobs_episode_idx" ON "synthesis_jobs" USING btree ("episode_id");