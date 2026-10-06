-- Distributed job leases for scheduled workers (#93)
CREATE TABLE "job_leases" (
    "job_name" TEXT NOT NULL,
    "owner_id" TEXT NOT NULL,
    "fence_token" BIGINT NOT NULL,
    "expires_at" TIMESTAMP(3) NOT NULL,
    "heartbeat_at" TIMESTAMP(3) NOT NULL,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "job_leases_pkey" PRIMARY KEY ("job_name")
);

CREATE INDEX "job_leases_expires_at_idx" ON "job_leases"("expires_at");
