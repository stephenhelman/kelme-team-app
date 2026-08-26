import { CATALOG_PAGE_SIZE } from "@/lib/config";
import { getStorefrontPage } from "@/lib/products";
import { CATEGORIES, type ProductCategory } from "@/lib/category";
import { Catalog } from "@/components/Catalog";

export default async function ShopPage({
  searchParams,
}: {
  searchParams: Promise<{ category?: string; search?: string }>;
}) {
  const params = await searchParams;
  const category = CATEGORIES.includes(params.category as ProductCategory)
    ? (params.category as ProductCategory)
    : undefined;

  const { products, hasMore } = await getStorefrontPage(0, CATALOG_PAGE_SIZE, {
    category,
    search: params.search,
  });

  return (
    <Catalog initialProducts={products} initialHasMore={hasMore} initialCategory={category} initialSearch={params.search ?? ""} />
  );
}
