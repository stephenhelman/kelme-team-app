import { NextResponse } from "next/server";
import { writeFile } from "fs/promises";
import path from "path";
import { shopifyAdminFetch, parseNextPageUrl } from "@/lib/shopify";

interface ShopifyVariant {
  id: number;
  inventory_item_id: number;
  sku: string;
  option1: string | null;
  option2: string | null;
  option3: string | null;
}

interface ShopifyImage {
  src: string;
}

interface ShopifyProduct {
  id: number;
  title: string;
  handle: string;
  status: string;
  tags: string;
  images: ShopifyImage[];
  variants: ShopifyVariant[];
}

interface TrimmedProduct {
  id: number;
  title: string;
  handle: string;
  status: string;
  tags: string;
  images: string[];
  variants: {
    id: number;
    inventory_item_id: number;
    sku: string;
    option1: string | null;
    option2: string | null;
    option3: string | null;
  }[];
}

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

export async function GET() {
  const products: TrimmedProduct[] = [];
  let nextUrl: string | null = "/products.json?limit=250";
  let page = 0;

  try {
    while (nextUrl) {
      const res: Response = await shopifyAdminFetch(nextUrl);

      if (!res.ok) {
        const body = await res.text();
        throw new Error(`Shopify request failed: HTTP ${res.status} ${body}`);
      }

      const callLimit = res.headers.get("X-Shopify-Shop-Api-Call-Limit");
      console.log(`[shopify/products] page ${page} status=${res.status} call-limit=${callLimit}`);

      const json = (await res.json()) as { products: ShopifyProduct[] };
      for (const p of json.products) {
        products.push({
          id: p.id,
          title: p.title,
          handle: p.handle,
          status: p.status,
          tags: p.tags,
          images: (p.images ?? []).map((img) => img.src),
          variants: (p.variants ?? []).map((v) => ({
            id: v.id,
            inventory_item_id: v.inventory_item_id,
            sku: v.sku,
            option1: v.option1,
            option2: v.option2,
            option3: v.option3,
          })),
        });
      }

      nextUrl = parseNextPageUrl(res.headers.get("Link"));
      page += 1;

      if (nextUrl) await sleep(400);
    }
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    console.error(`[shopify/products] failed: ${message}`);
    return NextResponse.json({ error: message }, { status: 400 });
  }

  const variantCount = products.reduce((sum, p) => sum + p.variants.length, 0);

  const outPath = path.join(process.cwd(), "shopify-products-live.json");
  await writeFile(outPath, JSON.stringify(products, null, 2), "utf8");

  console.log(
    `[shopify/products] wrote ${products.length} products / ${variantCount} variants to ${outPath}`,
  );

  return NextResponse.json({
    products: products.length,
    variants: variantCount,
    pages: page,
    file: "shopify-products-live.json",
  });
}
