-- AlterTable
ALTER TABLE "Product" ADD COLUMN     "attributesRaw" JSONB,
ADD COLUMN     "attributesSyncedAt" TIMESTAMP(3),
ADD COLUMN     "collection" TEXT,
ADD COLUMN     "composition" TEXT,
ADD COLUMN     "function" TEXT,
ADD COLUMN     "gender" TEXT,
ADD COLUMN     "kelmeDescription" TEXT,
ADD COLUMN     "seasons" TEXT,
ADD COLUMN     "subCategory" TEXT,
ADD COLUMN     "topOrLower" TEXT,
ADD COLUMN     "weightPerPiece" TEXT;
