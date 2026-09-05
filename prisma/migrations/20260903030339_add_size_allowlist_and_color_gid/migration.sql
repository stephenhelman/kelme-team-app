-- AlterTable
ALTER TABLE "Color" ADD COLUMN     "shopifyGid" TEXT;

-- CreateTable
CREATE TABLE "Size" (
    "shopifySize" TEXT NOT NULL,
    "shopifyGid" TEXT,
    "kind" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "Size_pkey" PRIMARY KEY ("shopifySize")
);
