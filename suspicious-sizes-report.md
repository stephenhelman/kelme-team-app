# Suspicious-size report (read-only)

Generated 2026-11-11 from **live Kelme data for all 347 favorites** (282 on Shopify, 65 favorites-only), classified with the NEW allow-list and exclusion policy (`lib/size-config.ts`): kids 110–160cm → 2/4/6/8/10/12; adult XXS–3XL ("2XS" = XXS); kids 100/170cm and adult 4XL–11XL excluded by policy; balls 1/3/4/5; One Size. Labels are exactly as Kelme's stock sheet sends them (before mapping). "Stocked variants" = every colour×size cell Kelme fills in (blank cells excluded, qty 0 counted). Nothing was written anywhere.

## Result

- **Group 1 — "None of our sizes": 0 products.** Every one of the 347 favorites has at least one stocked variant in a size we sell.
- **Group 2 — "Mostly outside" (<25% of stocked variants in an allowed size): 0 products.** The lowest share is 52% (8461WT1131).
- No mapping bug found. Every raw label Kelme sends was recognised (no "unknown" label anywhere), no ball is read as a kids height, no kids product carries adult letters, no adult product carries centimetre sizes.

So there is nothing to fix for the stated suspicion. The tables below are the near-misses, so you can see why.

## Watch list A — most stock sits in excluded sizes (<25% of stocked UNITS in sold sizes)

Not caught by the variant rule because these products have many cells; counted by units they are mostly 4XL+ stock.

| Style | Name | Sub-category | Audience | On Shopify | Labels → mapping (Kelme units) | Diagnosis |
|---|---|---|---|---|---|---|
| 8151ZB1001 | Short Sleeve Football Set (Adults) | Football Set | Adults (Men) | ACTIVE | S→S (0), M→M (48), L→L (0), XL→XL (0), 2XL→2XL (103), 3XL→3XL (87), 4XL→EXCLUDED (456), 5XL→EXCLUDED (469) | Genuinely off-range tail: 238 of 1163 units (20%) are in sold sizes; the rest is adult 4XL+. Labels read correctly — a product-mix fact, not a bug. These are the products most affected by enabling ADULT_EXTENDED in pass 2. |
| 3881324 | Training Jacket (Adults) | Knitted Jacket | Adults (Men) | ACTIVE | 2XS→XXS (0), XS→XS (0), S→S (137), M→M (0), L→L (0), XL→XL (0), 2XL→2XL (0), 3XL→3XL (107), 4XL→EXCLUDED (357), 5XL→EXCLUDED (338), 6XL→EXCLUDED (575), 7XL→EXCLUDED (415) | Genuinely off-range tail: 244 of 1929 units (13%) are in sold sizes; the rest is adult 4XL+. Labels read correctly — a product-mix fact, not a bug. These are the products most affected by enabling ADULT_EXTENDED in pass 2. |

## Watch list B — 25–60% of stocked variants in sold sizes

| Style | Name | Sub-category | Audience | On Shopify | Share | Labels → mapping (Kelme units) |
|---|---|---|---|---|---|---|
| 8461WT1131 | Woven Jacket (Adults) | Woven Jacket | Adults (Men) | ACTIVE | 52% | XS→XS (0), S→S (2254), M→M (3913), L→L (4963), XL→XL (4185), 2XL→2XL (1753), 3XL→3XL (463), 4XL→EXCLUDED (186), 5XL→EXCLUDED (101), 6XL→EXCLUDED (95), 7XL→EXCLUDED (76), 8XL→EXCLUDED (0), 9XL→EXCLUDED (0), 10XL→EXCLUDED (0), 11XL→EXCLUDED (0) |
| 8061WT1009 | Training Jacket (Adults) | Knitted Jacket | Adults (Men) | ACTIVE | 56% | S→S (534), M→M (530), L→L (1252), XL→XL (1543), 2XL→2XL (1165), 3XL→3XL (825), 4XL→EXCLUDED (724), 5XL→EXCLUDED (472), 6XL→EXCLUDED (371), 7XL→EXCLUDED (156), 8XL→EXCLUDED (0), 9XL→EXCLUDED (0), 10XL→EXCLUDED (0) |
| 8361WT1071 | Training Jacket (Adults) | Knitted Jacket | Adults (Men) | ACTIVE | 59% | S→S (621), M→M (1309), L→L (2014), XL→XL (1958), 2XL→2XL (1327), 3XL→3XL (933), 4XL→EXCLUDED (871), 5XL→EXCLUDED (297), 6XL→EXCLUDED (157), 7XL→EXCLUDED (98), 10XL→EXCLUDED (0) |
| 7451TX1365 | T-Shirt (Adults) | Short Sleeve T-Shirt Functional | Adults (Men) | ACTIVE | 59% | S→S (3126), M→M (3766), L→L (4184), XL→XL (4007), 2XL→2XL (3223), 3XL→3XL (2527), 4XL→EXCLUDED (1930), 5XL→EXCLUDED (1235), 6XL→EXCLUDED (697), 7XL→EXCLUDED (417), 8XL→EXCLUDED (4) |
| 8351PL1050 | Polo (Men) | Short Sleeve Polo | Adults (Men) | ACTIVE | 59% | S→S (799), M→M (547), L→L (1297), XL→XL (1482), 2XL→2XL (1135), 3XL→3XL (445), 4XL→EXCLUDED (184), 5XL→EXCLUDED (232), 6XL→EXCLUDED (125), 7XL→EXCLUDED (86), 8XL→EXCLUDED (0) |
| 3891544 | Training T-Shirt (Men) | Short Sleeve T-Shirt Functional | Adults (Men) | ACTIVE | 59% | S→S (283), M→M (496), L→L (757), XL→XL (650), 2XL→2XL (303), 3XL→3XL (273), 4XL→EXCLUDED (122), 5XL→EXCLUDED (58), 6XL→EXCLUDED (78), 7XL→EXCLUDED (53), 10XL→EXCLUDED (0) |
| 8061WT1005 | Rain Jacket (Adults) | Woven Jacket | Adults (Men) | ACTIVE | 60% | S→S (1072), M→M (1530), L→L (2606), XL→XL (2831), 2XL→2XL (1432), 3XL→3XL (1414), 4XL→EXCLUDED (725), 5XL→EXCLUDED (603), 6XL→EXCLUDED (440), 7XL→EXCLUDED (233), 8XL→EXCLUDED (0) |

Diagnosis for all of B: adult garments whose size run is S–3XL plus a long 4XL–11XL tail (Kelme lists up to 11XL on 8461WT1131). Genuinely off-range tails, labels parse correctly.

## Label census (how Kelme labels were classified, number of products carrying each)

| Raw Kelme label | Products | Classification |
|---|---|---|
| M | 194 | sold |
| XL | 194 | sold |
| 3XL | 194 | sold |
| S | 192 | sold |
| L | 192 | sold |
| 2XL | 192 | sold |
| 4XL | 184 | excluded by policy (not sold) |
| 5XL | 177 | excluded by policy (not sold) |
| 6XL | 81 | excluded by policy (not sold) |
| 140 | 75 | sold |
| 120 | 73 | sold |
| 130 | 73 | sold |
| 150 | 73 | sold |
| 160 | 73 | sold |
| 7XL | 69 | excluded by policy (not sold) |
| 110 | 56 | sold |
| 均码 | 51 | sold |
| XS | 25 | sold |
| 5 | 23 | sold |
| 4 | 18 | sold |
| 2XS | 14 | sold |
| 170 | 9 | excluded by policy (not sold) |
| 10XL | 8 | excluded by policy (not sold) |
| 8XL | 7 | excluded by policy (not sold) |
| 9XL | 3 | excluded by policy (not sold) |
| 3 | 3 | sold |
| 11XL | 1 | excluded by policy (not sold) |
| 1 | 1 | sold |
| 100 | 1 | excluded by policy (not sold) |

Notes on the census: kids labels arrive as bare numbers (110…170 = height in cm); 4/5/3/1 appear only on the 27 ball products; `均码` (One Size) is on 51 products (equipment, bags, socks, etc.); "2XS" is on 14 products and now maps to XXS; kids 170 is on 9 products and 100 on 1 (excluded by policy); 110 is on 56 (kept as "2").

## Checks behind "no mapping bugs"

1. **Ball vs kids height.** All 27 products the app treats as balls carry only 1/3/4/5, and no non-ball product carries a bare 1–5. The name heuristic also correctly leaves 10 football-named apparel items (e.g. "Short Sleeve Football Set (Kids)") as apparel with 110–170 heights.
2. **Audience vs labels.** Zero Kids-gender products with adult letters, zero Adults products with cm heights, zero products with both. Gender is not a complete audience signal on its own: 63 products are "Unisex" and 10 "Undefined", all balls/equipment/bags, which is why the pipeline classifies audience from the title first.
3. **Unrecognised formats.** None. No "XXL/XXXL/3X/M-L", Chinese size words other than 均码, or shoe-style numbers appear.
4. **Zero stock is not a size problem:** 37 products show zero units in every size (made-to-order); they are not listed above because their labels still map.

## Fix list

None required. Optional hardening (not applied): make capture log an explicit alert when a product has a raw label classified "unknown", so a future Kelme format change (e.g. a new "XXL") cannot silently drop stock.

Supporting file: `suspicious-sizes-report.csv` (one row per product × raw label for the watch lists; empty for Groups 1 and 2).
