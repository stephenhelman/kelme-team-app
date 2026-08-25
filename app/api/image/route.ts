import { NextRequest, NextResponse } from "next/server";
import { IMAGE_PROXY_ALLOWED_HOST } from "@/lib/config";

// Proxies (and lets the browser + Next cache) Kelme product images so we
// never hotlink the plain-http China host, and mixed content isn't an issue
// once the storefront is served over https.
export async function GET(req: NextRequest) {
  const src = req.nextUrl.searchParams.get("src");
  if (!src) {
    return new NextResponse(null, { status: 400 });
  }

  let url: URL;
  try {
    url = new URL(src);
  } catch {
    return new NextResponse(null, { status: 400 });
  }

  if (url.hostname !== IMAGE_PROXY_ALLOWED_HOST) {
    return new NextResponse(null, { status: 403 });
  }

  let upstream: Response;
  try {
    upstream = await fetch(url.toString(), { next: { revalidate: 3600 } });
  } catch {
    return new NextResponse(null, { status: 502 });
  }

  if (!upstream.ok) {
    return new NextResponse(null, { status: 502 });
  }

  const buffer = await upstream.arrayBuffer();
  return new NextResponse(buffer, {
    headers: {
      "Content-Type": upstream.headers.get("content-type") ?? "image/jpeg",
      "Cache-Control": "public, max-age=86400, stale-while-revalidate=604800",
    },
  });
}
