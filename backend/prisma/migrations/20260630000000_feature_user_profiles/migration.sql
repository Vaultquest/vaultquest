-- Durable user profile contract (#134)
CREATE TABLE "user_profiles" (
    "id" UUID NOT NULL,
    "wallet_address" TEXT NOT NULL,
    "display_name" VARCHAR(60),
    "bio" VARCHAR(600),
    "badge_id" VARCHAR(120),
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "user_profiles_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "user_profiles_wallet_address_key" ON "user_profiles"("wallet_address");
CREATE UNIQUE INDEX "user_profiles_display_name_key" ON "user_profiles"("display_name");
CREATE INDEX "user_profiles_wallet_address_idx" ON "user_profiles"("wallet_address");
