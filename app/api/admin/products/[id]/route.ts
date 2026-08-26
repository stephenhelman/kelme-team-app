import { NextRequest, NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import { CATEGORIES, type ProductCategory } from "@/lib/category";

interface PatchBody {
  sellPrice?: number | null;
  discount?: number | null;
  isPublished?: boolean;
  categoryOverride?: ProductCategory | null;
}

// Vendor-owned commerce fields only — never touches Kelme-owned columns.
export async function PATCH(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const body = (await req.json()) as PatchBody;

  const data: PatchBody = {};
  if ("sellPrice" in body) data.sellPrice = body.sellPrice === null ? null : Number(body.sellPrice);
  if ("discount" in body) data.discount = body.discount === null ? null : Number(body.discount);
  if ("isPublished" in body) data.isPublished = Boolean(body.isPublished);
  if ("categoryOverride" in body) {
    data.categoryOverride =
      body.categoryOverride && CATEGORIES.includes(body.categoryOverride) ? body.categoryOverride : null;
  }

  const product = await prisma.product.update({ where: { id: Number(id) }, data });
  return NextResponse.json({ product });
}
