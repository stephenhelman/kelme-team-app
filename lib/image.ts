import { IMAGE_DELIVERY_MODE } from "./config";

// Resolves a raw Kelme image URL (mainpic) to what the browser should
// actually request, per IMAGE_DELIVERY_MODE.
export function resolveImageSrc(raw: string): string {
  if (!raw) return "";
  if (IMAGE_DELIVERY_MODE === "hotlink") return raw;
  return `/api/image?src=${encodeURIComponent(raw)}`;
}
