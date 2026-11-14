-- CreateTable
CREATE TABLE "DraftRun" (
    "id" SERIAL NOT NULL,
    "source" TEXT NOT NULL,
    "startedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "finishedAt" TIMESTAMP(3),
    "pending" INTEGER NOT NULL DEFAULT 0,
    "created" INTEGER NOT NULL DEFAULT 0,
    "blocked" INTEGER NOT NULL DEFAULT 0,
    "failed" INTEGER NOT NULL DEFAULT 0,
    "overCap" INTEGER NOT NULL DEFAULT 0,
    "stoppedReason" TEXT,
    "emailedAt" TIMESTAMP(3),
    "emailedTo" TEXT,

    CONSTRAINT "DraftRun_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "DraftJob" (
    "id" SERIAL NOT NULL,
    "styleCode" TEXT NOT NULL,
    "status" TEXT NOT NULL,
    "productGid" TEXT,
    "runId" INTEGER,
    "error" TEXT,
    "summary" JSONB,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "DraftJob_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "DraftJob_styleCode_key" ON "DraftJob"("styleCode");

-- CreateIndex
CREATE INDEX "DraftJob_runId_idx" ON "DraftJob"("runId");

-- AddForeignKey
ALTER TABLE "DraftJob" ADD CONSTRAINT "DraftJob_runId_fkey" FOREIGN KEY ("runId") REFERENCES "DraftRun"("id") ON DELETE SET NULL ON UPDATE CASCADE;
