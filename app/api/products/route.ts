import { NextRequest, NextResponse } from "next/server";
import { CATALOG_PAGE_SIZE } from "@/lib/config";
import { getStorefrontPage } from "@/lib/products";
import { CATEGORIES, type ProductCategory } from "@/lib/category";

export async function GET(req: NextRequest) {
  const { searchParams } = new URL(req.url);
  const page = Math.max(0, Number(searchParams.get("page") ?? "0") || 0);
  const search = searchParams.get("search") || undefined;
  const color = searchParams.get("color") || undefined;
  const categoryParam = searchParams.get("category");
  const category = CATEGORIES.includes(categoryParam as ProductCategory)
    ? (categoryParam as ProductCategory)
    : undefined;

  const result = await getStorefrontPage(page, CATALOG_PAGE_SIZE, { search, color, category });

  return NextResponse.json(result);
}
