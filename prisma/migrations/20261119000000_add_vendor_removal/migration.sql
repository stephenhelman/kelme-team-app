-- CreateTable
CREATE TABLE "VendorRemoval" (
    "id" SERIAL NOT NULL,
    "styleCode" TEXT NOT NULL,
    "colorCode" TEXT NOT NULL,
    "shopifySize" TEXT NOT NULL DEFAULT '*',
    "reason" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "VendorRemoval_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "VendorRemoval_styleCode_colorCode_shopifySize_key" ON "VendorRemoval"("styleCode", "colorCode", "shopifySize");
