import { NextRequest, NextResponse } from "next/server";
import { getSettings, updateSettings } from "@/lib/settings";

export async function GET() {
  return NextResponse.json(await getSettings());
}

export async function PUT(req: NextRequest) {
  const body = await req.json();
  const patch: { shippingPerUnit?: number; minOrderUnits?: number } = {};
  if (body.shippingPerUnit != null) patch.shippingPerUnit = Number(body.shippingPerUnit);
  if (body.minOrderUnits != null) patch.minOrderUnits = Number(body.minOrderUnits);

  return NextResponse.json(await updateSettings(patch));
}
