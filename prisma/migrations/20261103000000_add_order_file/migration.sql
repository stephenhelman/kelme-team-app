-- CreateEnum
CREATE TYPE "OrderFileStatus" AS ENUM ('PENDING', 'PROCESSING', 'SENT', 'FAILED');

-- CreateTable
CREATE TABLE "OrderFile" (
    "id" SERIAL NOT NULL,
    "shopifyOrderId" TEXT NOT NULL,
    "orderName" TEXT NOT NULL,
    "status" "OrderFileStatus" NOT NULL DEFAULT 'PENDING',
    "attempts" INTEGER NOT NULL DEFAULT 0,
    "lockedAt" TIMESTAMP(3),
    "lastError" TEXT,
    "auditFlags" JSONB,
    "payload" JSONB NOT NULL,
    "resendEmailId" TEXT,
    "sentAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "OrderFile_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "OrderFile_shopifyOrderId_key" ON "OrderFile"("shopifyOrderId");

-- CreateIndex
CREATE INDEX "OrderFile_status_lockedAt_idx" ON "OrderFile"("status", "lockedAt");

