-- Shared versioned preference records, encrypted through the existing privacy
-- service. A revision comparison prevents a stale device overwriting a newer save.
CREATE TABLE "user_notification_prefs" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "wallet_address" TEXT NOT NULL,
    "category" TEXT NOT NULL,
    "encrypted_pref" JSONB NOT NULL,
    "key_version" INTEGER NOT NULL DEFAULT 1,
    "revision" INTEGER NOT NULL DEFAULT 1 CHECK ("revision" > 0),
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "user_notification_prefs_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "user_notification_prefs_wallet_address_category_key"
    ON "user_notification_prefs"("wallet_address", "category");
CREATE INDEX "user_notification_prefs_wallet_address_idx"
    ON "user_notification_prefs"("wallet_address");
