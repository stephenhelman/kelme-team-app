import { NextRequest, NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import { sanitizeProductPatch } from "@/lib/admin-product-patch";

// Vendor-owned commerce fields only — never touches Kelme-owned columns.
export async function PATCH(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const data = sanitizeProductPatch(await req.json());

  const product = await prisma.product.update({ where: { id: Number(id) }, data });
  return NextResponse.json({ product });
}
