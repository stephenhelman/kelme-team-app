/**
 * Realistic orders/paid payloads (already in sanitized OrderPayload shape).
 * order1028 mirrors the real test order: 25 jerseys, Heat Transfer logo,
 * Logo Placement Both / Number Placement Both, numbers 1-25 (41 digits).
 */
import type { OrderLineItem, OrderPayload } from "../lib/order-types";
import type { TagsByProductId } from "../lib/order-audit";
import type { VariantInfoBySku } from "../lib/order-sheet";

const LOGO = "https://cdn.shopify.com/s/files/1/0612/3456/7890/uploads/riverside-fc-crest.png";

const NAMES = [
  "Alvarez", "Brooks", "Chen", "Diaz", "Edwards", "Foster", "Garcia", "Hughes", "Ito", "Johnson",
  "Kowalski", "Lopez", "Martin", "Nguyen", "O'Brien", "Patel", "Quinn", "Rossi", "Silva", "Turner",
  "Underwood", "Vargas", "Walker", "Xu", "Young",
];

function roster(from: number, to: number, size: string, color = "Black") {
  const out = [];
  for (let n = from; n <= to; n++) out.push({ n: n - from + 1, number: String(n), name: NAMES[n - 1], size, color });
  return out;
}

function customProps(r: ReturnType<typeof roster>, opts: { app?: string; logoPlacement?: string; numberPlacement?: string; status?: string; fields?: string } = {}) {
  const props = [
    { name: "Logo", value: LOGO },
    { name: "Logo Application", value: opts.app ?? "Heat Transfer" },
    { name: "Logo Placement", value: opts.logoPlacement ?? "Both" },
    { name: "Number Placement", value: opts.numberPlacement ?? "Both" },
    { name: "Print Color", value: "Black" },
    { name: "_customize_fields", value: opts.fields ?? "number,name" },
    { name: "_roster_status", value: opts.status ?? "complete" },
  ];
  if (r.length > 0) {
    props.push({ name: "_roster", value: JSON.stringify(r) });
    props.push({ name: "Roster", value: r.map((e) => `#${e.number} ${e.name} (${e.size})`).join(", ") });
  }
  return props;
}

let lineId = 1000;
function line(over: Partial<OrderLineItem> & Pick<OrderLineItem, "title" | "product_id" | "quantity" | "price">): OrderLineItem {
  lineId += 1;
  return {
    id: lineId,
    variant_id: lineId * 10,
    variant_title: null,
    sku: null,
    total_discount: "0.00",
    properties: [],
    ...over,
  };
}

export const JERSEY = 1001;
export const BALL = 1002;
export const HEAT = 2001;
export const PATCH = 2002;
export const NUMBER = 2003;
export const NAME = 2004;
export const OTHER = 3001; // no recognised tag

export const tags: TagsByProductId = new Map([
  [JERSEY, ["core", "Kids"]],
  [BALL, ["core"]],
  [HEAT, ["customize_charge"]],
  [PATCH, ["customize_charge"]],
  [NUMBER, ["customize_charge"]],
  [NAME, ["customize_charge"]],
  [OTHER, ["gift"]],
]);

export const variantInfo: VariantInfoBySku = new Map([
  ["9001-110-M", { styleCode: "9001", colorName: "Black", size: "M" }],
  ["9001-110-L", { styleCode: "9001", colorName: "Black", size: "L" }],
  ["9001-110-S", { styleCode: "9001", colorName: "Black", size: "S" }],
  ["7710-100-4", { styleCode: "7710", colorName: "White", size: "4" }],
]);

export function jerseyLines(): OrderLineItem[] {
  return [
    line({
      title: "Kelme Match Jersey",
      product_id: JERSEY,
      variant_title: "Black / M",
      sku: "9001-110-M",
      quantity: 14,
      price: "21.50",
      properties: customProps(roster(1, 14, "M")),
    }),
    line({
      title: "Kelme Match Jersey",
      product_id: JERSEY,
      variant_title: "Black / L",
      sku: "9001-110-L",
      quantity: 11,
      price: "21.50",
      properties: customProps(roster(15, 25, "L")),
    }),
  ];
}

export function feeLines(o: { heat?: number; number?: number; name?: number } = {}): OrderLineItem[] {
  return [
    line({ title: "Heat Transfer Product", product_id: HEAT, quantity: o.heat ?? 50, price: "2.90" }),
    line({ title: "Number Customization", product_id: NUMBER, quantity: o.number ?? 82, price: "2.00" }),
    line({ title: "Name Customization", product_id: NAME, quantity: o.name ?? 25, price: "2.00" }),
  ];
}

const ball = () =>
  line({ title: "Kelme Training Ball", product_id: BALL, variant_title: "White / 4", sku: "7710-100-4", quantity: 2, price: "14.00" });

const base = { created_at: "2026-11-02T18:41:07-05:00", currency: "USD" };

/** Correct order: 25 jerseys (+2 plain balls), fees exactly right. */
export const order1028: OrderPayload = {
  id: 6251234567890,
  name: "#1028",
  ...base,
  line_items: [...jerseyLines(), ball(), ...feeLines()],
};

/** Same order with every fee line removed. */
export const orderFeesStripped: OrderPayload = {
  ...order1028,
  id: 6251234567891,
  name: "#1029",
  line_items: [...jerseyLines(), ball()],
};

/** Only the Heat Transfer fee reduced to 25 units (placement doubling not paid). */
export const orderHeatShort: OrderPayload = {
  ...order1028,
  id: 6251234567892,
  name: "#1030",
  line_items: [...jerseyLines(), ball(), ...feeLines({ heat: 25 })],
};

/** 12 core items, Patch logo, numbers 1-12 (15 digits), correct fees. */
export const orderUnder25: OrderPayload = {
  id: 6251234567893,
  name: "#1031",
  ...base,
  line_items: [
    line({
      title: "Kelme Match Jersey",
      product_id: JERSEY,
      variant_title: "Black / S",
      sku: "9001-110-S",
      quantity: 12,
      price: "21.50",
      properties: customProps(roster(1, 12, "S"), { app: "Patch", logoPlacement: "", numberPlacement: "", fields: "number" }).filter((p) => p.name !== "Print Color"),
    }),
    line({ title: "Patch Product", product_id: PATCH, quantity: 12, price: "4.00" }),
    line({ title: "Number Customization", product_id: NUMBER, quantity: 15, price: "2.00" }),
    line({ title: "Name Customization", product_id: NAME, quantity: 12, price: "2.00" }),
  ],
};

/** 25 jerseys whose roster hasn't been entered yet. */
export const orderPendingRoster: OrderPayload = {
  id: 6251234567894,
  name: "#1032",
  ...base,
  line_items: [
    line({
      title: "Kelme Match Jersey",
      product_id: JERSEY,
      variant_title: "Black / M",
      sku: "9001-110-M",
      quantity: 25,
      price: "21.50",
      properties: customProps([], { status: "pending", logoPlacement: "", numberPlacement: "" }),
    }),
    line({ title: "Heat Transfer Product", product_id: HEAT, quantity: 25, price: "2.90" }),
  ],
};

/** No customization at all. */
export const orderPlain: OrderPayload = {
  id: 6251234567895,
  name: "#1033",
  ...base,
  line_items: [
    line({ title: "Kelme Match Jersey", product_id: JERSEY, variant_title: "Black / M", sku: "9001-110-M", quantity: 30, price: "21.50" }),
  ],
};
