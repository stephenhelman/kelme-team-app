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
