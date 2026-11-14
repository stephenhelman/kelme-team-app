/**
 * Category for a draft whose Kelme sub-category has no hard-coded rule: reuse
 * the category the live catalog already uses for that sub-category. Read-only
 * (one Shopify product scan + one DB read).
 */
import { prisma } from "@/lib/prisma";
import { shopifyGraphQL } from "@/lib/shopify";
import { matchingStyleCodes } from "@/lib/style-match";
import { buildCategoryMap, type CategoryMap } from "@/lib/draft-rules";

const QUERY = `
  query liveCategories($cursor: String) {
    products(first: 250, after: $cursor) {
      pageInfo { hasNextPage endCursor }
      nodes { title category { id fullName } }
    }
  }
`;

export async function fetchLiveCategoryMap(): Promise<CategoryMap> {
  const db = await prisma.product.findMany({ select: { styleCode: true, subCategory: true } });
  const subByCode = new Map(db.map((p) => [p.styleCode, p.subCategory]));
  const codes = [...subByCode.keys()];
  const rows: { subCategory: string | null; category: { id: string; fullName: string } | null }[] = [];
  let cursor: string | null = null;
  for (;;) {
    const res: { data?: { products: { pageInfo: { hasNextPage: boolean; endCursor: string | null }; nodes: { title: string; category: { id: string; fullName: string } | null }[] } }; errors?: unknown } =
      await shopifyGraphQL(QUERY, { cursor });
    if (res.errors || !res.data) throw new Error(`live category query failed: ${JSON.stringify(res.errors)}`);
    for (const n of res.data.products.nodes) {
      const matches = matchingStyleCodes(n.title, codes);
      if (matches.length === 1) rows.push({ subCategory: subByCode.get(matches[0]) ?? null, category: n.category });
    }
    if (!res.data.products.pageInfo.hasNextPage) break;
    cursor = res.data.products.pageInfo.endCursor;
  }
  return buildCategoryMap(rows);
}
