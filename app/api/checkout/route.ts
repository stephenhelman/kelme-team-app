import { NextRequest, NextResponse } from "next/server";
import { placeSimulatedOrder, type CartLineInput } from "@/lib/orders";

interface CheckoutBody {
  items: CartLineInput[];
  customerName: string;
  customerEmail: string;
  customerNote?: string;
}

export async function POST(req: NextRequest) {
  const body = (await req.json()) as CheckoutBody;

  if (!body.customerName?.trim() || !body.customerEmail?.trim()) {
    return NextResponse.json({ error: "Name and email are required" }, { status: 400 });
  }

  try {
    const order = await placeSimulatedOrder({
      items: body.items,
      customerName: body.customerName.trim(),
      customerEmail: body.customerEmail.trim(),
      customerNote: body.customerNote?.trim(),
    });
    return NextResponse.json({ order });
  } catch (err) {
    const message = err instanceof Error ? err.message : "Checkout failed";
    return NextResponse.json({ error: message }, { status: 400 });
  }
}
