# Size standardization — Phase A impact plan (read-only)

Generated 2026-11-11. **Nothing was written** to Shopify or the DB. Live data pulled read-only from Shopify (294 products, 7,259 variants), the Postgres DB (313 products), and the 2026-11-10 Kelme gap reports. Supporting files in the repo root:

- `size-std-110cm-removals.csv` — every 110cm variant that would be removed (283), with SKU and current Shopify qty
- `size-std-additions.csv` — per live product: variants to add per size (XXS, 4XL–7XL), and whether it passes 100 variants

## Decisions I need from you (these change the plan)

1. **110cm kids: delete, or keep as label "2"?** On the chart's pattern (+10cm = +2 labels), 110cm is "2" and 170cm is "14". Keeping 110cm (`KIDS_EXTRA = ["110cm"]`) turns the whole kids change into a pure in-place relabel with **zero deletions**. Dropping it deletes 283 live variants carrying **12,989 units** of listed stock, and that cannot be undone with the same variant ids. I recommend either keeping 110cm for now, or approving the deletion explicitly. Detail in §2a.
2. **Include 4XL–7XL (`ADULT_EXTENDED`)?** It decides whether the favorites backlog moves at all: with the chart-only list **0 of 34** blocked favorites become clean; with 4XL–7XL **13** do (§3).
3. **Off-chart sizes must not count as "dropped".** Pre-flight and `drafts create` refuse any product with a dropped size. Any off-chart kids size (110cm/170cm) has to be reported as "excluded by policy" instead, or every kids product with a 110cm column becomes undraftable.

## Proposed config (one file, `lib/size-config.ts`, not created yet)

```ts
export const KIDS_CM_TO_LABEL = { "120cm": "4", "130cm": "6", "140cm": "8", "150cm": "10", "160cm": "12" };
export const KIDS_EXTRA: string[] = [];          // e.g. ["110cm"] -> "2", ["170cm"] -> "14", ["100cm"] -> "0"
export const KIDS_EXTRA_LABELS = { "100cm": "0", "110cm": "2", "170cm": "14" };
export const ADULT_BASE = ["XXS","XS","S","M","L","XL","2XL","3XL"];
export const ADULT_EXTENDED: string[] = [];      // or ["4XL","5XL","6XL","7XL"]
export const ADULT_ALIASES = { "2XS": "XXS" };
// derived: allow-list, CANONICAL_SIZE_ORDER (lib/sizes.ts), Size seed rows
```

Applies to all apparel: nothing I found stops a category following the chart. The ball-size and One Size paths are untouched. One thing to know: kids bibs/vests (8051BX3001/3002) carry a single kids size (140cm → "10" today → "8"); they just follow the same shift.

---

## 1. Shopify size values (metaobject `shopify--size`)

The store has 18 entries. Needed vs found:

| Label | Status | GID |
|---|---|---|
| 4 / 6 / 8 / 10 / 12 | **exists** | 96105889988 / 96105791684 / 96105988292 / 96105922756 / 96105955524 |
| 14 | exists (kept only if 170cm → 14) | 96105824452 |
| XS, S, M, L, XL, 2XL, 3XL | exist | 96043630788, …696324, …729092, …827396, …794628, …761860, 98032550084 |
| **XXS** | **MISSING** | — |
| **4XL, 5XL, 6XL, 7XL** | **MISSING** (extended only) | — |
| 2 (110cm, if kept) / 0 (100cm) | MISSING | — |

All gids are `gid://shopify/Metaobject/<n>`. The missing entries **can be created**: the Size definition is `PUBLIC_READ_WRITE`, our token has `write_metaobjects`, and Shopify's own taxonomy already has the base values: XXS = TaxonomyValue/2911, 4XL = 2919, 5XL = 2920, 6XL = 2921, 7XL = 81407 (and 2 = 2885, 0 = 2878). Each new entry is `metaobjectCreate(type: "shopify--size", fields: [label, taxonomy_reference])`, mirroring the existing entries (e.g. "3XL" → taxonomy 2918). That is 1 create (XXS) or 5 (extended). I did not run it.

Note: "4" in the Size table is shared between kids apparel (`shopifyGid` 96105889988) and balls (`ballSizeGid`); this stays correct because the kids "4" metaobject keeps its meaning as a label, only which cm it represents changes.

## 2. Live catalog impact

### 2a. Kids relabel

73 kids apparel products (ACTIVE plus a few DRAFTs from the draft pipeline). Current vs new, counted from live Shopify joined to DB variant ids:

| Kelme cm | Today | New label | Live variants | Shopify units | Action |
|---|---|---|---|---|---|
| 110cm | 4 | *(off chart)* | **283** (52 products) | **12,989** (243 variants > 0) | **remove** — or relabel to "2" if kept |
| 120cm | 6 | 4 | 383 | 32,046 | rename 6→4 |
| 130cm | 8 | 6 | 390 | 54,125 | rename 8→6 |
| 140cm | 10 | 8 | 400 | 93,646 | rename 10→8 |
| 150cm | 12 | 10 | 389 | 84,412 | rename 12→10 |
| 160cm | 14 | 12 | 390 | 78,222 | rename 14→12 |

- **Relabeled variants: 1,952** (all 73 products). **Removed: 283** (52 products; 270 on ACTIVE products, 13 on 2 DRAFTs).
- If 110cm is kept as "2": 2,235 in-place relabels, 0 removals.
- **Open/unfulfilled orders referencing 110cm variants: none.** Only 2 orders are visible to our token (#1028, #1029), both cancelled adult test orders. Caveat: `read_orders` only returns the last 60 days (no `read_all_orders` scope), and the order counter suggests older orders exist; check the Shopify admin orders list for anything on a kids "4" before approving deletion. No other state references them (OrderFile table has one SENT row).
- Kids products without a 110cm column (21) are a pure rename. The 110cm CSV lists every variant to be removed.
- Off-chart sizes Kelme still offers on **live** products (not currently listed): 170cm → would need label "14": 40 variants, 9 products, 2,568 units; 100cm → "0": 2 variants (8261MF3014, 0 units). Adding them requires `KIDS_EXTRA`. 14 stays in the allow-list only if 170cm is included.

### 2b. Variants added (from the 2026-11-10 gap report, matched to live products by style+color)

| Scenario | Size | Live products | Variants added | Kelme units | of which qty 0 |
|---|---|---|---|---|---|
| Base (chart) | **XXS** (Kelme "2XS") | 8 | 35 | 1,880 | 6 |
| Extended | 4XL | | 751 | 50,437 | 97 |
| | 5XL | | 727 | 35,773 | 69 |
| | 6XL | | 291 | 10,830 | 57 |
| | 7XL | | 273 | 6,862 | 46 |
| | **4XL–7XL total** | **147** (all adult, all ACTIVE) | **2,042** | 103,902 | 269 |

The 8 XXS products are also among the 147, so the extended scenario touches **147 products / 2,077 added variants** in total; median 10 added per product, max 60. Per-product counts are in `size-std-additions.csv`. Favorites-only (not yet on Shopify) products are separate (§3).

**Three hard requirements for adding variants to live products** (found while reading the existing write path):

1. **Price.** `buildMutationInput` omits `price` unless `priceFor` is passed, so a plain reconcile/`productSet` would create the new variants at the default price (probably $0.00) on an ACTIVE listing. Today every ACTIVE product has exactly one price across all its variants (269 products, 0 zero-priced), so the fix is simple: pass `priceFor = the product's existing price` (and copy compare-at if set) and assert no new variant is $0.00 in the dry-run.
2. **100-variant ceiling.** Our pipeline treats >100 variants as "needs split". 5 live products would cross it with the extended sizes: 7351PL1070 (90→150), 7351ZB1255 (84→140), 8061WT1005 (72→120), 8061WT1009 (72→120), 7451ZB1795 (66→110). Those need the split flow (or an explicit decision), not a plain add. Chart-only adds none.
3. **Display order.** After adding, run `productOptionsReorder` (already done by `executeSizeOrder`) with the new order list, or XXS/4XL land at the end.

### 2c. SKU impact and safe handling

SKU = `styleCode-colorCode-size`, so every relabeled kids variant gets a new SKU (1,952 changes, e.g. `8451ZB3245-100-6` → `…-4`). The old SKUs get **reused by a different variant** (old `-6` becomes the 130cm variant), which is the dangerous part.

**Write path:** no existing code renames an option value. Nearest are `productOptionUpdate` (used in `lib/shopify-reconcile.ts` for add/update/delete of values) and the SKU writer `lib/shopify-sku.ts` (`productVariantsBulkUpdate`, sku only). Live introspection (API 2026-10) shows `OptionValueUpdateInput = { id, name, linkedMetafieldValue }`, so a linked value can be renamed **and re-pointed to the new size metaobject in one call**, which keeps the variant ids (inventory, history, DB link `shopifyVariantId`).

Recommended sequence per kids product (new script, not the full productSet reconcile):
1. (Only if deleting) `productOptionUpdate … optionValuesToDelete:[110cm "4" value] variantStrategy:MANAGE` — the same mutation already used for stray values.
2. `productOptionUpdate … optionValuesToUpdate` ascending: 6→4, 8→6, 10→8, 12→10, 14→12, each with `linkedMetafieldValue` = the target metaobject. Ascending order means each target label has just been freed. If Shopify rejects a multi-value call (uniqueness is checked per call, untested), fall back to one call per value in the same order.
3. Restamp SKUs with the existing `lib/shopify-sku.ts` flow after the DB is updated (compute → dry-run diff → execute).
4. Verify (read back option values, variant ids unchanged, qty unchanged, weights).

**Unproven**: I could not test whether Shopify accepts changing `linkedMetafieldValue` on an existing linked value (and our own notes record an unresolved "cannot have both linked and nonlinked values" rejection on one product). That is exactly what the kids canary tests; the fallback is rebuild (below).

**Fallback (rebuild + relink):** delete and re-create via `productSet` gives **new variant ids**, loses inventory levels (rebuilt from Kelme by the next push) and breaks order-history variant links. I'd only use it per product if the in-place rename is refused.

**Everything that references old SKUs / size labels:**
- DB `Variant.sku` (index) and `Variant.shopifySize`, plus `Product.sizes[]` (unique key `productId+colorCode+shopifySize`: process delete first, then ascending, inside a transaction).
- `lib/order-file-worker.ts` `loadVariantInfo` resolves an order line's size by **SKU lookup in our DB**. After the change, an order placed before the cutover but processed after would resolve a reused SKU to the wrong size. Mitigation: cutover with the worker stopped and `OrderFile` empty of PENDING/PROCESSING rows (currently 1 SENT, none pending).
- Vendor communication: the vendor sheet (`order-sheet.ts`, CSV `Size` column) prints the Shopify label. "Size 6" used to mean 120cm and will mean 130cm. Recommend adding the Kelme height (cm) to kids lines in the sheet/CSV and telling the vendor the changeover date. Past emails are not affected by code.
- Customer-entered roster sizes (`order-audit.ts`) are free text and not validated against the list in this repo; if the customizer app/theme offers a dropdown of kids sizes it will need the same change (not visible to me).
- `lib/shopify-relink.ts` and the inventory push match by (styleCode, colorCode, size label) / `shopifyVariantId`, **not SKU**, so they follow the DB once it is updated; pause the worker so it does not relink or push mid-change.
- Nothing in emails (`vendor-notify`, `product-added-notify`, `draft-notify`) hard-codes kids labels.

### 2d. Display order and size-dependent code (changes needed in Phase B)

- `lib/sizes.ts` `CANONICAL_SIZE_ORDER` is `4,6,8,10,12,14,16,2XS,XS…3XL,One Size`. Must become kids (4…12, + 14 if 170cm), then `XXS…3XL` (+ `4XL…7XL`), then One Size; derive it from the config. It feeds `lib/shopify-order.ts` (Shopify option ordering), `shopify-draft`, `shopify-trim`, `shopify-batch`, `order-sheet`.
- `lib/kelme-capture.ts`: `KIDS_EU_SIZE_MAP` → the new map (110cm/170cm/100cm unmapped unless in `KIDS_EXTRA`), and an adult alias `2XS → XXS` in `resolveSize`.
- `lib/order-sheet.ts` `SIZE_TOKEN` handles `[2-5]?xl`, so 6XL/7XL aren't recognised in the variant-title fallback → `[2-7]`.
- `lib/shopify-sku.ts` `classifyVariantKind` adult regex does not match `XXS` (would classify as "other") → fix.
- `lib/kelme-inventory.ts` and `kelme-capture.ts` read the allow-list from the `Size` table, so they follow data. `draft-preflight`'s "sizes without shopifyGid" check will flag XXS/4XL+ until their GIDs are stored.
- **Theme / size-chart dependency: cannot inspect.** The token has no `read_themes`/files scope, so theme snippets and size-chart images are unverified. Product descriptions (all 294 scanned) contain **no** size-label or size-chart text (the only "Size" mentions are "Size 5" on balls and "40 years" marketing copy). The Next.js site in this repo has no size labels. Manually check: any theme "size chart" popup/page, size-chart images, customizer roster dropdown, and the Kelme vendor sheet's own size column.

### 2e. Weight protection

All 7,259 live variants are at **1 lb** (the 4 at 0 lb are the customization-fee items). The plan keeps this:
- Option rename / delete (`productOptionUpdate`) doesn't touch inventory items.
- New variants go through `productSet` with `includeWeight = true` (default), which sends 1 lb + `requiresShipping:true` (`CORE_WEIGHT_LB`).
- The SKU restamp (`productVariantsBulkUpdate` with only `inventoryItem.sku`) is **not yet proven** to leave measurement untouched; the canary checks weight before/after and Phase B ends with `npm run shipping:weights` in dry-run to prove 0 variants off target.

---

## 3. Favorites backlog replay (draft pre-flight vs the new allow-list)

The 44 candidates are the 2026-11-03 pre-flight set: 10 clean (already created as drafts) and **34 flagged**. I replayed `evaluatePreflight`'s rules on those 34 offline using the recorded dropped-size notes and current DB variants (no Kelme calls, no writes).

| Scenario | Clean | Still blocked |
|---|---|---|
| Today (11-03) | 10 (done) | 34 |
| **Chart only** (kids shift, XXS, no 4XL+) | **0** of 34 | 34 |
| **Chart + 4XL–7XL** | **13** of 34 | 21 |

Reason chart-only clears nothing: every size-blocked candidate also has 4XL/5XL (XXS is only 11 of the dropped variants). Whether off-chart 110cm is strict or "excluded by policy" doesn't change the counts (only 8351ZB3143 has a 110cm variant, 1, and it's blocked by images anyway) — but see decision 3.

**Become clean with 4XL–7XL** (variant counts after): 3801253 (41), 3801286 (56), 3802255 (28), 3871001 (92), 3891048 (32), 3991536 (42), 8351ZB1086 (38), 8361WT1084 (8), 8451QB1030 (40), 8451QB1031 (40), 8461WT1096 (36), 8461ZB1244 (32), ZB90511001 (28). (3871001 at 92 is close to the 100 limit.) They also need the new Size GIDs stored.

**Still blocked (21)**, with reasons:
- No category mapping — 18 products: "Training Device" ×14 (K16XLQC009/010/010-1/011/011-1/011-2/014/016/016-1/023/026/026-1/026-2/026-3), "Football Ball" (8101QU5003), "Ball Bag" (9886019), "Captain Armband" (9886702), "Trolley Case" (K15S959A)
- Style-code family conflicts — 11 (the K16XLQC010/011/016/026 families)
- Colors missing image — 6 (8351ZB1143, 8351ZB3143, K15Z408, K16XLQC009/014/023)
- Needs split — 1: 8351ZB1143 would be 115 variants (also image-blocked)

Wider view from the 2026-11-10 report (66 favorites not on Shopify, 32 in the DB + 34 never captured): A (ready) 3 + B (sizes only) 14 = **17 loadable with 4XL–7XL**, **3 with chart-only** (B each need 4XL+). The 3 ready kids sets will lose their 110cm column under the new chart (24 → 20 variants), so they need re-capture to recount. Non-size blockers (category rules, new colors, images, families) are unchanged by this work.

---

## 4. Phase B plan (nothing runs until you approve)

New scripts follow the existing convention: dry-run by default, `--execute` run by you, JSONL log + resume, 400ms pacing.

**Step 0 — code (PR, no data writes):** `lib/size-config.ts`; update `lib/sizes.ts`, `kelme-capture.ts` (map + alias + "excluded by policy" vs "dropped"), `order-sheet.ts` regex + cm on kids lines, `shopify-sku.ts` regex; add `priceFor` support to the add path; unit tests for the map/order/regex. Add `npm run sizes:*` scripts.

**Step 1 — freeze + snapshot:** stop the Railway worker (4h sync + 60s order poll); confirm no PENDING OrderFile; export to JSON the Shopify variants (id, sku, options, qty, weight, price) and the DB `Size`/`Variant`/`Product.sizes`. This is the rollback source.

**Step 2 — Size table and Shopify metaobjects** (`npm run sizes:seed [--execute]`): create metaobjects (XXS; + 4XL–7XL if extended; + "2" if 110cm kept), upsert `Size` rows with `kind`/GID, keep 4/6/8/10/12, remove "14" only after the catalog is done (and not if 170cm is in). Dry-run prints the exact `metaobjectCreate` payloads. 1–5 writes.

**Step 3 — DB remap** (`npm run sizes:db [--execute]`): in one transaction per product: delete 110cm rows (unless kept), relabel ascending, rebuild `sku`, update `Product.sizes`. Dry-run shows the diff (1,952 relabels, 284 DB 110cm rows). Reversible from the snapshot.

**Step 4 — canaries** (each gated on your read of the verify output):
- *Kids canary:* DRAFT product **9151ZB3001** (Short Sleeve Football Set – Kids): 4 variants at 110cm, **0 units**, not customer-visible. Tests delete + ascending rename + relink + SKU restamp + weight/qty/id preservation. If the rename path is refused, this is where we find out.
- *Adult canary:* **8261CK1034** Training Pants – Adults (ACTIVE, 7 variants): adds XXS (+4XL–7XL) with price/weight checks and size reorder. Verify: new variants priced the same as siblings, 1 lb, correct order, inventory item created, existing variant ids untouched.

**Step 5 — kids batch:** 73 products in batches of 10 (`sizes:kids --batch N`), verify (option values, ids, qty, weights, SKUs) after each batch, stop on first mismatch.

**Step 6 — adult adds (extended only; XXS-only is 8 products):** 147 products in batches of 10–15 via the existing reconcile/`executeBatch` flow with the price fix; the 5 over-100 products excluded and handled separately; verify per batch (counts per size, no $0, weights 1 lb, order).

**Step 7 — relink + inventory:** `executeRelink` (dry-run first), one `executePush` dry-run, then restart the worker and watch one cycle; run `shipping:weights` dry-run (must show 0 changes).

**Step 8 — favorites:** re-run `npm run drafts -- preflight --capture`, then `drafts create` per product (spike-gated as before) for the newly clean 13 (extended) after the metaobject GIDs are in.

**Rollback:** kids rename — reverse renames from the snapshot (same mutation, descending), restore DB from snapshot; variant ids stay intact. **Not fully reversible: the 110cm deletions** (re-created variants get new ids). Additions — delete the added variants (ids recorded in the log). Metaobjects — leave in place (harmless). Every step logs variant ids and before/after values to JSONL.

**Estimated Shopify writes / time** (at ~1.5–3s per write incl. pacing; Kelme recapture for added sizes ~1.5s per product):

| Scope | Writes | Time |
|---|---|---|
| Metaobjects | 1 (5 extended) | seconds |
| Kids (73 products): delete 52, rename 73 (up to 365 if one call per value), SKU 73, verify reads 73 | ~200 (up to ~490) | 10–25 min |
| Chart-only adds: XXS on 8 products (~5 writes each) | ~40 | ~5 min |
| **Base total** | **≈ 240 (max ~530)** | **≈ 20–35 min** |
| Extended adds: 147 products (~5 writes each incl. option add, productSet, reorder, media/tags) + 5 split cases | ≈ 735+ | 40–90 min |
| Favorites drafts (13 products) | ~80 | ~15 min |
| **Extended total** | **≈ 960 (max ~1,300)** | **≈ 1.5–2.5 h** incl. verification |

Keeping 110cm as "2" removes the 52 delete calls and the deletion risk, adds one metaobject.

## Risks to know before approving

- The in-place rename of a **linked** option value is untested (our earlier notes record a similar linked/unlinked rejection on one product); the DRAFT canary de-risks it for free.
- SKU reuse across variants (old `-6` ≠ new `-6`): only safe if no order is mid-pipeline at cutover.
- The 110cm deletion is the only irreversible, revenue-affecting step (12,989 units listed today).
- Customer-facing items I couldn't check: theme snippets, size-chart images, roster dropdowns, and whether any store pages/collections link to a "Size: 14" filter or search facet (storefront filters on Size 14 will disappear).
