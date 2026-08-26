import { NextRequest, NextResponse } from "next/server";
import { ORDER_STATUSES, setOrderStatus, type OrderStatus } from "@/lib/orders";

export async function PATCH(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const { status } = await req.json();

  if (!ORDER_STATUSES.includes(status)) {
    return NextResponse.json({ error: "Invalid status" }, { status: 400 });
  }

  const order = await setOrderStatus(Number(id), status as OrderStatus);
  return NextResponse.json({ order });
}
