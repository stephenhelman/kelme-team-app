import { NextRequest, NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import { sanitizeProductPatch } from "@/lib/admin-product-patch";

interface BatchItem {
  id: number;
  [key: string]: unknown;
}

interface BatchResult {
  id: number;
  ok: boolean;
  error?: string;
}

// One request updates every dirty product in a single serverless invocation.
// Best-effort: one item failing (e.g. bad input, deleted product) doesn't
// block the rest — each result is reported back individually.
export async function PATCH(req: NextRequest) {
  const body = (await req.json()) as { items?: BatchItem[] };
  const items = Array.isArray(body.items) ? body.items : [];

  const results: BatchResult[] = await Promise.all(
    items.map(async (item): Promise<BatchResult> => {
      const id = Number(item.id);
      if (!Number.isInteger(id)) return { id: item.id, ok: false, error: "Invalid id" };

      try {
        const data = sanitizeProductPatch(item);
        await prisma.product.update({ where: { id }, data });
        return { id, ok: true };
      } catch {
        return { id, ok: false, error: "Update failed" };
      }
    }),
  );

  return NextResponse.json({ results });
}
