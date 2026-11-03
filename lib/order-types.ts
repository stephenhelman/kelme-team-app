/**
 * The slice of the Shopify orders/paid webhook payload this app uses.
 *
 * sanitizeOrderPayload is an allowlist: the webhook body carries customer
 * PII (email, addresses, phone, ...) that the order sheet doesn't need, so
 * only these fields are ever persisted to OrderFile.payload. Add a field here
 * deliberately if the sheet starts needing it (and, for customer fields,
 * check the app's Protected Customer Data approval covers it).
 */
export interface OrderLineProperty {
  name: string;
  value: string;
}

export interface OrderLineItem {
  id: number;
  product_id: number | null;
  variant_id: number | null;
  title: string;
  variant_title: string | null;
  sku: string | null;
  quantity: number;
  /** Unit price as a decimal string, e.g. "2.90". */
  price: string;
  /** Line-level discount total as a decimal string. */
  total_discount: string;
  properties: OrderLineProperty[];
}

export interface OrderPayload {
  id: number;
  name: string; // "#1028"
  created_at: string;
  currency: string;
  line_items: OrderLineItem[];
}

function str(v: unknown): string {
  return typeof v === "string" ? v : v == null ? "" : String(v);
}

function num(v: unknown): number | null {
  const n = typeof v === "number" ? v : Number(v);
  return Number.isFinite(n) ? n : null;
}

/** Throws if the body lacks an order id — callers treat that as a bad request. */
export function sanitizeOrderPayload(raw: unknown): OrderPayload {
  const o = (raw ?? {}) as Record<string, unknown>;
  const id = num(o.id);
  if (id == null) throw new Error("order payload has no id");

  const lines = Array.isArray(o.line_items) ? o.line_items : [];
  return {
    id,
    name: str(o.name) || `#${str(o.order_number) || id}`,
    created_at: str(o.created_at),
    currency: str(o.currency),
    line_items: lines.map((l: Record<string, unknown>) => ({
      id: num(l.id) ?? 0,
      product_id: num(l.product_id),
      variant_id: num(l.variant_id),
      title: str(l.title),
      variant_title: l.variant_title == null ? null : str(l.variant_title),
      sku: l.sku == null || l.sku === "" ? null : str(l.sku),
      quantity: num(l.quantity) ?? 0,
      price: str(l.price) || "0",
      total_discount: str(l.total_discount) || "0",
      properties: (Array.isArray(l.properties) ? l.properties : []).map(
        (p: Record<string, unknown>) => ({ name: str(p.name), value: str(p.value) }),
      ),
    })),
  };
}
