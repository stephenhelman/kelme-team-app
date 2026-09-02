-- DropForeignKey
ALTER TABLE "OrderItem" DROP CONSTRAINT "OrderItem_orderId_fkey";

-- DropForeignKey
ALTER TABLE "OrderItem" DROP CONSTRAINT "OrderItem_productId_fkey";

-- AlterTable
ALTER TABLE "Product" DROP COLUMN "active",
DROP COLUMN "categoryOverride",
DROP COLUMN "colorImages",
DROP COLUMN "colors",
DROP COLUMN "discount",
DROP COLUMN "imageUrl",
DROP COLUMN "isPublished",
DROP COLUMN "sellPrice",
DROP COLUMN "stock",
DROP COLUMN "stockSyncedAt",
ADD COLUMN     "mainpic" TEXT NOT NULL DEFAULT '',
ADD COLUMN     "syncedAt" TIMESTAMP(3),
ALTER COLUMN "kelmeCatalogPrice" DROP NOT NULL,
ALTER COLUMN "kelmeFobCost" DROP NOT NULL;

-- DropTable
DROP TABLE "Order";

-- DropTable
DROP TABLE "OrderItem";

-- DropTable
DROP TABLE "Settings";

-- CreateTable
CREATE TABLE "Color" (
    "colorCode" TEXT NOT NULL,
    "colorName" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "Color_pkey" PRIMARY KEY ("colorCode")
);

-- CreateTable
CREATE TABLE "Variant" (
    "id" SERIAL NOT NULL,
    "productId" INTEGER NOT NULL,
    "colorCode" TEXT NOT NULL,
    "colorName" TEXT NOT NULL,
    "kelmeSize" TEXT NOT NULL,
    "shopifySize" TEXT NOT NULL,
    "qty" INTEGER NOT NULL DEFAULT 0,
    "imageUrl" TEXT,
    "sku" TEXT NOT NULL,
    "shopifyVariantId" TEXT,
    "shopifyInventoryItemId" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "Variant_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "Variant_productId_idx" ON "Variant"("productId");

-- CreateIndex
CREATE INDEX "Variant_sku_idx" ON "Variant"("sku");

-- CreateIndex
CREATE UNIQUE INDEX "Variant_productId_colorCode_shopifySize_key" ON "Variant"("productId", "colorCode", "shopifySize");

-- AddForeignKey
ALTER TABLE "Variant" ADD CONSTRAINT "Variant_productId_fkey" FOREIGN KEY ("productId") REFERENCES "Product"("id") ON DELETE CASCADE ON UPDATE CASCADE;

