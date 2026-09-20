-- CreateTable
CREATE TABLE "KelmeTokenHistory" (
    "id" SERIAL NOT NULL,
    "mintedAt" TIMESTAMP(3) NOT NULL,
    "diedAt" TIMESTAMP(3),
    "deathReason" TEXT,
    "refreshCount" INTEGER NOT NULL DEFAULT 0,
    "lastRefreshedAt" TIMESTAMP(3),
    "source" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "KelmeTokenHistory_pkey" PRIMARY KEY ("id")
);
