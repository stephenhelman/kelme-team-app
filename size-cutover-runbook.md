# Size standardization — pass 1 runbook (kids relabel + XXS)

Every command below is **dry-run unless it says `--execute`**. Run them in order and paste me the output of each; I won't run `--execute` myself. Commands are `npm run sizes -- …` unless noted. All writes are logged to `size-relabel-log.jsonl` (kids relabel) and the existing `shopify-*-log.jsonl` files.

Policy in force: kids 110→2, 120→4, 130→6, 140→8, 150→10, 160→12 (100cm and 170cm excluded); adults XXS–3XL (Kelme "2XS" = XXS); 4XL–11XL excluded. Excluded sizes are reported as "not sold" and never block a draft; unknown sizes still block.

## Before anything: deploy order

The new mapping is in code now. **Do not deploy it to Railway/Vercel until the Cutover (§C) says so.** The 4-hourly sync worker uses the same code: if it ran the new mapping against the old DB/Shopify labels it would drop and re-add kids variants. So the worker stays stopped from §C1 until §C8.

## A. Step 2 — create the Shopify size values "2" and "XXS"

```
npm run sizes -- seed                 # dry run: shows the two metaobjectCreate payloads + Size-table rows
npm run sizes -- seed --execute       # creates them, stores GIDs in the Size table
```
Check after: the table printed at the end shows `2` and `XXS` with GIDs; in Shopify admin → Content → Metaobjects → Size, "2" and "XXS" exist. Nothing customer-facing changes (unused values). `14` stays in the Size table until the end.

## B. Canaries

### B1. Canary A — DRAFT 9151ZB3001 (not customer visible; 23 variants, 6 units)
```
npm run sizes -- relabel --styleCode 9151ZB3001              # dry run
npm run sizes -- relabel --styleCode 9151ZB3001 --execute    # worker should already be stopped (§C1)
```
The command verifies and prints PASS/FAIL for: same variant ids; inventory unchanged; weight still 1 lb + ships; every variant has its new label; SKUs restamped; option values keep their ids and link to the new size values; DB rows relabeled and still linked to the same Shopify variant ids; the order code resolves each new SKU to the right size and prints it as "6 (130cm)". **Any FAIL → stop and send me the output.** Roll back with `npm run sizes -- rollback --styleCode 9151ZB3001 --execute`.

If Shopify refuses the in-place rename, the command tries four shapes (one batched call, then one value per call, each with name+link then link-only) — a refused call changes nothing — and finally stops saying "all attempts refused". In that case we do not proceed to B2; the fallback is rebuilding per product (new variant ids) and needs your decision.

Also look at it in the admin: Products → the draft → the Size option should read 2, 4, 6, 8, 10, 12 (in that order) with the swatch/metafield link intact.

### B2. Canary B — one live kids product and one live adult product
Kids (lowest stock live kids product: Padded Jacket 3893417, 12 variants, 10 units, 2 colors):
```
npm run sizes -- relabel --styleCode 3893417
npm run sizes -- relabel --styleCode 3893417 --execute
```
Adult XXS (Training Pants 8261CK1034, 7 variants, one XXS to add):
```
npm run sizes -- add-sizes --styleCode 8261CK1034              # dry run: reads Kelme only, lists the variant(s) it will add + the price
npm run sizes -- add-sizes --styleCode 8261CK1034 --execute
```
`add-sizes` re-captures the product from Kelme (DB), refuses to continue if the reconcile would delete anything or add a size other than XXS, then reconciles (new variants get the product's current price — currently $27.79 — and 1 lb), fixes the size order, relinks, pushes Kelme inventory, and verifies: no existing variant lost or changed, new variant priced like its siblings, 1 lb + ships, right SKU, inventory equals Kelme stock, XXS first in the option order. If the product has mixed prices it stops and says so.

**Storefront checklist for you (both canaries, on the live product page, desktop + phone):**
1. Size picker/swatches show the new labels in order (kids: 2, 4, 6, 8, 10, 12 — adult: XXS first, then XS, S…); no stale "14" or "16".
2. Choosing each size updates price ($27.79 for the pants), image and availability; the sold-out state is right for a 0-stock size.
3. Add to cart works for the first and last size; the cart line shows the new size and the new SKU (admin → order draft or cart JSON `/cart.js`).
4. The product still appears in its collection and in a search for its style code; any "Size" filter in the collection sidebar shows the new labels (old facet values disappear after Shopify re-indexes, a few minutes).
5. Name/number customization still opens and the roster size dropdown (if it is a theme/app list rather than Shopify's option) offers the new kids labels — **this list lives outside this repo; if it still says 6/8/10/12/14 it must be updated before cutover.**
6. Admin → Products → the product: Size option linked to the Size metafield, variants' weight 1 lb.

Do not proceed to §C until both canaries pass and you've done the checklist.

## C. Cutover (all kids + XXS)

Expected storefront disruption: **brief, per product** — each product's size labels flip within a second or two, and during that moment a customer on the page could see the old label for a variant they already selected; a cart created before a product is flipped keeps the old SKU/label (fine for the order sheet because of §C4). A whole batch of 10 styles takes about a minute. Total relabel window ≈ 10–20 minutes. **Run it at night / lowest traffic** (and not with an open checkout in flight): there is no way to make a label change atomic across 73 products.

1. **Stop the Railway worker** (Railway → service → pause/stop). Confirm no sync is running.
2. **No orders mid-pipeline:** in the DB, `OrderFile` rows must all be `SENT` (none `PENDING`/`PROCESSING`), and Shopify admin → Orders shows nothing paid-but-unprocessed. The order sheet resolves sizes by SKU in our DB; SKUs are reused after the relabel (old `-6` becomes the 130cm variant), so an order processed after the relabel but placed before it would show the wrong size. (Check in Prisma Studio: `OrderFile` grouped by `status` — only SENT expected.)
3. Deploy the new code (Railway **worker stays stopped**; deploy the Vercel app/admin routes).
4. Snapshot: `relabel-batch` writes the full pre-change state of every style to the log before touching it; additionally run `npm run shipping:weights` (dry-run) and keep the output as the "before" weight proof (expect 0 to write).
5. Kids relabel in batches (each batch verifies every product and stops on the first failure):
```
npm run sizes -- relabel-batch --limit 10                    # dry run: lists the next 10 pending styles and any PROBLEM
npm run sizes -- relabel-batch --limit 10 --execute          # prints BATCH ID; verify output per product
```
Repeat until the dry run says `this batch: 0`. After each batch, glance at one product in the storefront. **Per-batch rollback:** `npm run sizes -- rollback-batch --batchId <id> --execute` renames every style in that batch back (values, SKUs, DB). Styles already relabeled in earlier batches are untouched.
6. Add XXS to the live adult products that have it in Kelme (pass 1 = 8 products):
```
npm run sizes -- add-sizes --styleCode <style>              # dry run per product
npm run sizes -- add-sizes --styleCode <style> --execute
```
(I'll give you the list of the 8 style codes with the dry-run counts once you've sent me the §A/§B output.)
7. Finalize: `npm run sizes -- seed` (dry run) should show everything `none`; then `npm run sizes -- drop-old-sizes` (dry run) lists the retired Size rows (14) and how many DB variants still use them — only `--execute` it when that count is 0.
8. **Restart the worker.** Then a full dry run of the sync: run `npm run sizes -- post-check` (read-only: relink + inventory-push dry-runs). Expected: unmatched 0 on both sides, real link failures 0, retired labels 0, push candidates only where Kelme stock moved since the cutover. Anything else → stop and send it to me. Then let the worker run one cycle and re-run `post-check`.

## D. Step 6 — favorites pre-flight under the new policy

Offline replay (no writes) is in the report I sent. To refresh with live captures after the cutover:
```
npm run drafts -- preflight --capture
```
This writes DB captures (the normal pre-flight behavior), so run it **after §C**, never before. Expect few newly clean favorites until pass 2 enables 4XL–7XL.

## Rollback summary

| What | How | Reversible? |
|---|---|---|
| Kids relabel (one style) | `rollback --styleCode X --execute` | Yes — ids never change |
| Kids relabel (batch) | `rollback-batch --batchId ID --execute` | Yes |
| XXS added to a live product | delete the added variant(s) in admin (ids printed in the add-sizes log) | Yes, manually |
| New size values "2"/"XXS" | leave in place | harmless |
