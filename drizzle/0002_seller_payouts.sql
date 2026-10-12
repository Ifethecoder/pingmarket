ALTER TABLE "orders" ADD COLUMN IF NOT EXISTS "paid_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "orders" ADD COLUMN IF NOT EXISTS "stripe_payment_intent_id" text;--> statement-breakpoint
ALTER TABLE "orders" ADD COLUMN IF NOT EXISTS "payout_status" text DEFAULT 'not_started' NOT NULL;--> statement-breakpoint
ALTER TABLE "orders" ADD COLUMN IF NOT EXISTS "stripe_transfer_id" text;--> statement-breakpoint
ALTER TABLE "orders" ADD COLUMN IF NOT EXISTS "payout_amount_cents" integer;--> statement-breakpoint
ALTER TABLE "orders" ADD COLUMN IF NOT EXISTS "platform_fee_cents" integer;--> statement-breakpoint
ALTER TABLE "orders" ADD COLUMN IF NOT EXISTS "payout_currency" text;--> statement-breakpoint
ALTER TABLE "orders" ADD COLUMN IF NOT EXISTS "payout_error" text;--> statement-breakpoint
ALTER TABLE "orders" ADD COLUMN IF NOT EXISTS "payout_attempts" integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE "orders" ADD COLUMN IF NOT EXISTS "payout_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "users" ADD COLUMN IF NOT EXISTS "stripe_account_id" text;--> statement-breakpoint
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'users_stripe_account_id_unique') THEN
    ALTER TABLE "users" ADD CONSTRAINT "users_stripe_account_id_unique" UNIQUE("stripe_account_id");
  END IF;
END $$;