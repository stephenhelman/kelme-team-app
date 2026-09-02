-- CreateTable
CREATE TABLE "ShopifyToken" (
    "id" INTEGER NOT NULL DEFAULT 1,
    "encryptedToken" TEXT NOT NULL,
    "scope" TEXT NOT NULL,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "ShopifyToken_pkey" PRIMARY KEY ("id")
);
