-- AlterTable
ALTER TABLE "Product" ADD COLUMN     "colors" TEXT[] DEFAULT ARRAY[]::TEXT[],
ADD COLUMN     "sizes" TEXT[] DEFAULT ARRAY[]::TEXT[];
