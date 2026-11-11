# Size standardization — pass 2 runbook (adult 4XL–7XL on live products)

Every command is a dry run unless it has `--execute`. 8XL+ stay policy-excluded. New variants take the product's current uniform price (mixed/zero stops the run), 1 lb, ships, tracked; stock is pushed from Kelme. Logs: `size-add-log.jsonl` (created ids per batch).

Report (read-only): `npm run sizes -- extended-report` → `extended-sizes-report.md` (143 styles, 1,958 variants; 5 products would pass 100: 7351PL1070, 7351ZB1255, 7451ZB1795, 8061WT1005, 8061WT1009; 7351TX1092 and 7351ZB1129 map to 3 Shopify products each — exclude).

1. `seed --execute` — done (4XL–7XL values created, GIDs stored).
2. **Stop the Railway worker** for every `--execute` below.
3. Over-cap canary (append-only, productVariantsBulkCreate, NOT productSet):
   `add-sizes --styleCode 7451ZB1795 --sizes 4XL,5XL,6XL,7XL --method bulk [--execute]`
   Storefront checklist (desktop + phone): size picker shows all 8 sizes in order (…3XL, 4XL, 5XL, 6XL, 7XL); every color × size selectable, sold-out state right for 0-stock; add to cart works for 4XL and 7XL; color swatches/images unchanged; price same as siblings; product still in collection/search; roster modal offers the new sizes. Any failure → those 5 get no 4XL+ for now (rollback: `add-sizes-rollback --batchId <id> --execute`).
4. Normal canary: `add-sizes --styleCode 3801098 --sizes 4XL,5XL,6XL,7XL [--execute]`. Verify block checks: no variant lost/changed, N added, price, 1 lb+ships, SKUs, inventory = Kelme, size values linked to the right metaobjects, tags unchanged, DB rows linked, size order.
5. Batches: `add-sizes-batch --limit 10 [--exclude 7351TX1092,7351ZB1129] [--execute]` (skips over-cap products, stops on first failure). Rollback of a batch: `add-sizes-rollback --batchId <id> [--execute]` — deletes only the variants that batch created (and the size values it added if unused); never touches existing variants.
6. After batches: `post-check`, restart worker, watch one cycle (push ok, failed=0, mismatched=0), `post-check` again.
7. Refresh: `extended-report` (expect 0 new variants) and `drafts preflight --capture` (writes DB captures).
