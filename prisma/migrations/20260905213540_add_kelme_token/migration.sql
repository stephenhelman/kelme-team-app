-- CreateTable
CREATE TABLE "KelmeToken" (
    "id" INTEGER NOT NULL DEFAULT 1,
    "accessToken" TEXT NOT NULL,
    "refreshToken" TEXT,
    "status" TEXT NOT NULL DEFAULT 'alive',
    "obtainedAt" TIMESTAMP(3) NOT NULL,
    "lastRefreshedAt" TIMESTAMP(3) NOT NULL,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "KelmeToken_pkey" PRIMARY KEY ("id")
);
