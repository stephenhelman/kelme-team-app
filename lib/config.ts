/**
 * Single swappable pointer to the inventory data source.
 * Sprint 1 reads this straight from the Express POC — swap this constant
 * (or set KELME_INVENTORY_URL) when the source changes in a later sprint.
 */
export const INVENTORY_SOURCE_URL =
  process.env.KELME_INVENTORY_URL ?? "http://localhost:3000/inventory";

// Matches the POC's own page size against the Kelme API (start/range paging).
export const INVENTORY_PAGE_RANGE = 100;

// The vendor's favorited product catalog (name/price/colors/image) — the
// PRIMARY catalog source as of Sprint 1.5. Small (~158 items), unlike the
// raw inventory feed, so it's fetched in full and cached once.
export const CATALOG_SOURCE_URL =
  process.env.KELME_CATALOG_URL ?? "http://localhost:3000/products";

// Mirrors the POC's own pagesize against Kelme's b2b.pdt.search.
export const CATALOG_SOURCE_PAGE_SIZE = 60;

// How many products the catalog grid renders per page/scroll batch.
export const CATALOG_PAGE_SIZE = 24;

export type ImageDeliveryMode = "hotlink" | "proxy";

/**
 * "proxy" (default): product images are served through our own /api/image
 * route so the storefront never hotlinks the plain-http China host directly
 * — required once the store is served over https (mixed content would be
 * blocked), and it also means we can cache/placeholder on failure. Flip to
 * "hotlink" only for quick local dev against the raw mainpic URL.
 */
export const IMAGE_DELIVERY_MODE: ImageDeliveryMode = "proxy";

// Only this host is allowed through the image proxy.
export const IMAGE_PROXY_ALLOWED_HOST = "gkemb2b.kelmechina.com";
