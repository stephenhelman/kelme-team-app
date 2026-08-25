import { CATALOG_PAGE_SIZE } from "@/lib/config";
import { getCatalogPage } from "@/lib/catalog-cache";
import { Catalog } from "@/components/Catalog";

export default async function Home() {
  const { products, hasMore } = await getCatalogPage(0, CATALOG_PAGE_SIZE);

  return <Catalog initialProducts={products} initialHasMore={hasMore} />;
}
