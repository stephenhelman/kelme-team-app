-- CreateTable
CREATE TABLE "SyncStatus" (
    "id" INTEGER NOT NULL DEFAULT 1,
    "lastSuccessfulSyncAt" TIMESTAMP(3),
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "SyncStatus_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "SyncAlert" (
    "kind" TEXT NOT NULL,
    "active" BOOLEAN NOT NULL DEFAULT false,
    "firstSeenAt" TIMESTAMP(3),
    "lastNotifiedAt" TIMESTAMP(3),
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "SyncAlert_pkey" PRIMARY KEY ("kind")
);
