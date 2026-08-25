import { NextRequest, NextResponse } from "next/server";
import { CATALOG_PAGE_SIZE } from "@/lib/config";
import { getCatalogPage } from "@/lib/catalog-cache";

export async function GET(req: NextRequest) {
  const { searchParams } = new URL(req.url);
  const page = Math.max(0, Number(searchParams.get("page") ?? "0") || 0);
  const search = searchParams.get("search") || undefined;
  const color = searchParams.get("color") || undefined;

  const result = await getCatalogPage(page, CATALOG_PAGE_SIZE, { search, color });

  return NextResponse.json(result);
}
