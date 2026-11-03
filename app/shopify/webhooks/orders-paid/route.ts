import { NextRequest, NextResponse } from "next/server";
import { Prisma } from "@prisma/client";
import { prisma } from "@/lib/prisma";
import { shopDomain } from "@/lib/shopify";
import { verifyShopifyWebhookHmac } from "@/lib/shopify-webhook";
import { sanitizeOrderPayload } from "@/lib/order-types";

// Shopify orders/paid webhook. Entered by Shopify itself, so it carries no
// admin cookie — gated on the HMAC signature + shop domain instead (same idea
// as the OAuth routes). Does the bare minimum and returns 200 fast: verify,
// insert a PENDING OrderFile, done. The audit + vendor email happen in the
// Railway worker (lib/order-file-worker.ts), never inline here — Shopify
// retries/disables subscriptions that respond slowly or with errors.
export async function POST(req: NextRequest) {
  // Raw text, before any JSON parsing: the HMAC covers the exact bytes sent.
  const rawBody = await req.text();

  // API-registered webhooks are signed with the app's client secret.
  const secret = process.env.SHOPIFY_API_SECRET;
  if (!secret) {
    console.error("[webhooks/orders-paid] SHOPIFY_API_SECRET is not set");
    return NextResponse.json({ error: "Server misconfigured" }, { status: 500 });
  }

  if (!verifyShopifyWebhookHmac(rawBody, req.headers.get("x-shopify-hmac-sha256"), secret)) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  if (req.headers.get("x-shopify-shop-domain") !== shopDomain()) {
    console.error(`[webhooks/orders-paid] unexpected shop domain "${req.headers.get("x-shopify-shop-domain")}"`);
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  let payload;
  try {
    payload = sanitizeOrderPayload(JSON.parse(rawBody));
  } catch (err) {
    console.error(`[webhooks/orders-paid] bad payload: ${err instanceof Error ? err.message : String(err)}`);
    return NextResponse.json({ error: "Bad payload" }, { status: 400 });
  }

  try {
    await prisma.orderFile.create({
      data: {
        shopifyOrderId: String(payload.id),
        orderName: payload.name,
        payload: payload as unknown as Prisma.InputJsonValue,
      },
    });
    console.log(`[webhooks/orders-paid] queued ${payload.name} (${payload.id})`);
  } catch (err) {
    // Shopify delivers at-least-once — a duplicate delivery is a success.
    if (err instanceof Prisma.PrismaClientKnownRequestError && err.code === "P2002") {
      console.log(`[webhooks/orders-paid] duplicate delivery for ${payload.name} (${payload.id}) — ignored`);
    } else {
      // 500 so Shopify retries; nothing was stored.
      console.error(`[webhooks/orders-paid] insert failed: ${err instanceof Error ? err.message : String(err)}`);
      return NextResponse.json({ error: "Insert failed" }, { status: 500 });
    }
  }

  return NextResponse.json({ ok: true });
}
