-- CreateTable
CREATE TABLE "Product" (
    "id" SERIAL NOT NULL,
    "pdtid" INTEGER NOT NULL,
    "styleCode" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "colors" TEXT NOT NULL,
    "imageUrl" TEXT NOT NULL,
    "kelmeCatalogPrice" DOUBLE PRECISION NOT NULL,
    "kelmeFobCost" DOUBLE PRECISION NOT NULL,
    "categoryIds" TEXT NOT NULL DEFAULT '',
    "active" BOOLEAN NOT NULL DEFAULT true,
    "sellPrice" DOUBLE PRECISION,
    "discount" DOUBLE PRECISION,
    "isPublished" BOOLEAN NOT NULL DEFAULT false,
    "categoryOverride" TEXT,
    "stock" TEXT NOT NULL DEFAULT '[]',
    "stockSyncedAt" TIMESTAMP(3),
    "colorImages" TEXT NOT NULL DEFAULT '{}',
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "Product_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Order" (
    "id" SERIAL NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'new',
    "unitCount" INTEGER NOT NULL,
    "shippingTotal" DOUBLE PRECISION NOT NULL,
    "orderTotal" DOUBLE PRECISION NOT NULL,
    "paymentLink" TEXT NOT NULL,
    "customerName" TEXT NOT NULL,
    "customerEmail" TEXT NOT NULL,
    "customerNote" TEXT NOT NULL DEFAULT '',
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "Order_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "OrderItem" (
    "id" SERIAL NOT NULL,
    "orderId" INTEGER NOT NULL,
    "productId" INTEGER NOT NULL,
    "styleCode" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "color" TEXT NOT NULL,
    "size" TEXT NOT NULL,
    "qty" INTEGER NOT NULL,
    "unitPrice" DOUBLE PRECISION NOT NULL,

    CONSTRAINT "OrderItem_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Settings" (
    "id" INTEGER NOT NULL DEFAULT 1,
    "shippingPerUnit" DOUBLE PRECISION NOT NULL DEFAULT 3.0,
    "minOrderUnits" INTEGER NOT NULL DEFAULT 25,

    CONSTRAINT "Settings_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "Product_pdtid_key" ON "Product"("pdtid");

-- AddForeignKey
ALTER TABLE "OrderItem" ADD CONSTRAINT "OrderItem_orderId_fkey" FOREIGN KEY ("orderId") REFERENCES "Order"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "OrderItem" ADD CONSTRAINT "OrderItem_productId_fkey" FOREIGN KEY ("productId") REFERENCES "Product"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
