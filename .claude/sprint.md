# Kelme Storefront — Sprint Plan

**Owner:** Stephen Helman (OP Web Studio)
**Client:** manufacturer rep / soccer-uniform vendor (Kelme dealer)
**Goal (whole project):** replace a manual Shopify + PayPal-link flow with a custom
Next.js storefront that reads Kelme dealer inventory automatically, lets clubs place
orders, and later grows a club portal for personalized (per-player) ordering.

**Goal (right now, Sprint 1 only):** stand up a Next.js storefront skeleton that reads
the inventory we can _already_ pull from Kelme and renders it as a browsable catalog, so
we can visually see the data and start layering in more endpoints. Nothing else.

---

## Guiding decisions (already made — do not re-litigate in code)

1. **No payment processing in this system.** Checkout = capture the order + generate a
   PayPal or Stripe _payment link_. This is the single biggest scope-saver: no PCI, no
   card handling, no tax engine, no fraud. Hold this line hard in every sprint.
2. **Render straight from Kelme's data model.** The storefront's catalog _is_ Kelme's
   catalog (style / color / size, pulled from the feed). We are NOT reconciling against a
   separately-built Shopify variant list, so there is no SKU-mapping layer to build. The
   Kelme `style + colorCode + sizeLabel` tuple _is_ the variant identity.
3. **Stock is a garnish, not a gate.** Kelme on-hand is mostly zeros because this is a
   made-to-order supplier. DO NOT hide out-of-stock items — that would hide most of the
   catalog and read as a broken site. Render everything; let stock drive an availability
   _badge / lead-time note_, not visibility.
4. **Paginate / lazy-load against Kelme; never pull all ~165k rows at once.** Page on
   demand as the user browses, mirroring how the portal itself behaves.
5. **Sprint 1 has no database and no auth.** It reads from the existing Express
   proof-of-concept (or a thin API route that wraps the same Kelme call). DB and auth
   arrive in later sprints when orders/portal need them. Let the data model reveal itself
   before committing a schema.

---

## Known data shape (from the working proof-of-concept)

The Kelme inventory call returns rows in this positional form:

```
[ recordId, recordId, [warehouseId, warehouseName], styleCode, name,
  colorName, colorCode, [sizeId, sizeLabel], availableQty, secondQty ]
```

Already parsed by the POC into:

```json
{
  "style": "0151ZB1014",
  "color": "White",
  "colorCode": "100",
  "size": "L",
  "warehouse": "专业装备备货仓",
  "qty": 2
}
```

Notes that matter for the UI:

- Colors and sizes come back in English already. Only **warehouse names are Chinese**
  (two known: `专业装备备货仓` and `专业装备京易仓`) — map these to display labels.
- A product = one `style`. Its variants = the `color × size` combinations under it.
- Stock is split across warehouses; for display, **sum qty across warehouses** per
  color/size unless told otherwise.
- `qty` is usually 0, occasionally 1–2. Normal for made-to-order. This drives the badge,
  not visibility.

---

## SPRINT 1 — Inventory Visualizer (build this now)

**Outcome:** a running Next.js app where Stephen can browse the Kelme inventory as a
storefront-style catalog — product grid, product detail with a color/size variant matrix,
and an availability badge per variant. Data comes from the existing POC endpoint.

### 1.1 Project scaffold

- Next.js (App Router) + TypeScript + Tailwind.
- No auth, no database, no payment anything.
- A single config constant for the data source URL (the Express POC, default
  `http://localhost:3000/inventory`), so it's swappable.

### 1.2 Data layer

- One server-side data module that fetches from the POC endpoint and returns typed rows.
- A `Product` shape assembled in-app by **grouping rows by `style`**, then nesting
  `variants` (color + size + summed qty + per-warehouse breakdown).
- A warehouse display-name map (`专业装备备货仓` → e.g. "Main Warehouse",
  `专业装备京易仓` → e.g. "JD Express Warehouse") — leave the labels as clearly-marked
  constants Stephen can rename.
- An `availability` helper: `qty > 5` → "In stock", `1–5` → "Low stock",
  `0` → "Made to order" (thresholds as named constants).

### 1.3 Storefront UI

- **Catalog page:** responsive product grid. Each card = one style, showing style code,
  available color swatches, and a summary availability badge. Lazy-load / paginate as the
  grid scrolls — do not render all styles at once.
- **Product detail page:** the color × size **variant matrix** (sizes as columns, colors
  as rows, or similar), each cell showing size + availability badge. This is the core
  "visualize the data" view.
- **Filtering:** by color and by availability at minimum; style-code search.
- Everything renders regardless of stock (garnish-not-gate).

### 1.4 Definition of done for Sprint 1

- `npm run dev` → browse a catalog of real Kelme styles.
- Open a style → see its full color/size matrix with correct summed quantities.
- Zero-stock items are visible and badged, not hidden.
- No orders, no cart, no DB, no auth — and that's correct for this sprint.

---

## LATER SPRINTS (context for the whole arc — DO NOT build yet)

Listed so the shape of the project is visible; Sprint 1 stands alone.

- **Sprint 2 — Persistence & sync.** Introduce Postgres (Neon) + Prisma. Move from
  live-reading the POC to a scheduled Kelme sync writing snapshots into the DB; storefront
  reads the DB. Add the server-side login flow (RSA-encrypted password → token) and
  session-expiry handling. Add the style-filter `condition` so sync pulls only the
  vendor's actual styles.
- **Sprint 3 — Cart & order capture.** Cart, order model, "place order" that creates an
  order record and generates a PayPal/Stripe **payment link** (no processing). Order
  status lifecycle (new → quoted → paid → shipped).
- **Sprint 4 — Vendor admin.** Order dashboard, product/catalog management, availability
  overrides, lead-time messaging.
- **Sprint 5 — Club portal (the real differentiator).** Multi-tenant: club onboarding,
  member accounts scoped to a club, roster, personalized per-player ordering
  (name / number / size). Built on the auth + catalog foundation from earlier sprints.
- **Sprint 6 — If Kelme grants real API access.** Swap the reverse-engineered portal
  calls for the official API; likely enables live shipping quotes and programmatic order
  placement, retiring parts of the manual flow.

---

## Design direction (so it doesn't look like a template)

This is athletic teamwear for soccer clubs — the visual world is kit, pitch, numbers on
jerseys, club identity. Lean into that rather than a generic e-commerce grid:

- Treat the variant matrix like a **kit selector / roster sheet**, not a spec table.
- Type: a strong, slightly athletic display face for style names paired with a clean
  utility face for the data-dense variant grid.
- Availability badges should read like team/jersey language, not warehouse jargon
  ("Made to order" beats "0 in stock").
- Keep it disciplined: one signature element (the kit/variant selector), everything else
  quiet. Responsive, keyboard-focusable, reduced-motion respected.

---

## Out of scope for Sprint 1 (say no if asked)

Payments/processing of any kind • real-time shipping quotes • database • auth/accounts •
order placement • the club portal • pushing anything back to Kelme or Shopify.
