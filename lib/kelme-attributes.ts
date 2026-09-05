/**
 * Pulls structured product attributes (Gender, Sub-category, Collection,
 * Seasons, Composition/Material, Weight/Piece, Function, Top or Lower,
 * Description) from Kelme's b2b.pdt.detail endpoint and stores them on the
 * existing Product row, keyed by pdtid. A separate, slower endpoint from
 * b2b.pdt.get (lib/kelme-capture.ts) — its own paced loop, its own sync
 * timestamp (Product.attributesSyncedAt). Never creates/deletes Product
 * rows; only updates one that capture already wrote.
 */
import { prisma } from "@/lib/prisma";
import { fetchFavoritesPage, fetchProductAttributes, type RawProductAttribute } from "@/lib/kelme";

const CALL_PACING_MS = 500;
const FAVORITES_PAGE_SIZE = 60;

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function isDeadTokenError(err: unknown): boolean {
  return err instanceof Error && err.message.includes("000005");
}

// Retry once on transient failure; a dead token is never transient, so it
// propagates immediately without burning a retry.
async function withRetry<T>(fn: () => Promise<T>): Promise<T> {
  try {
    return await fn();
  } catch (err) {
    if (isDeadTokenError(err)) throw err;
    await sleep(CALL_PACING_MS);
    return await fn();
  }
}

// title -> Product column, matched case-insensitively, trimmed. Anything
// not in this map still survives in attributesRaw.
const TITLE_TO_FIELD: Record<string, string> = {
  gender: "gender",
  "sub-category": "subCategory",
  collection: "collection",
  seasons: "seasons",
  "composition/material": "composition",
  "weight/piece": "weightPerPiece",
  function: "function",
  "top or lower": "topOrLower",
  description: "kelmeDescription",
};

function blankToNull(v: string | undefined): string | null {
  const trimmed = (v ?? "").trim();
  return trimmed === "" ? null : trimmed;
}

export interface AttributeFields {
  gender: string | null;
  subCategory: string | null;
  collection: string | null;
  seasons: string | null;
  composition: string | null;
  weightPerPiece: string | null;
  function: string | null;
  topOrLower: string | null;
  kelmeDescription: string | null;
}

export function mapAttributes(attrs: RawProductAttribute[]): AttributeFields {
  const byField = new Map<string, string>();
  for (const attr of attrs) {
    const field = TITLE_TO_FIELD[attr.title.trim().toLowerCase()];
    if (field) byField.set(field, attr.value);
  }
  return {
    gender: blankToNull(byField.get("gender")),
    subCategory: blankToNull(byField.get("subCategory")),
    collection: blankToNull(byField.get("collection")),
    seasons: blankToNull(byField.get("seasons")),
    composition: blankToNull(byField.get("composition")),
    weightPerPiece: blankToNull(byField.get("weightPerPiece")),
    function: blankToNull(byField.get("function")),
    topOrLower: blankToNull(byField.get("topOrLower")),
    kelmeDescription: blankToNull(byField.get("kelmeDescription")),
  };
}

export interface CaptureAttributesResult {
  pdtid: number;
  ok: boolean;
  gender: string | null;
  error?: string;
}

export async function captureProductAttributes(pdtid: number): Promise<CaptureAttributesResult> {
  const attrs = await fetchProductAttributes(pdtid);
  if (attrs.length === 0) {
    return { pdtid, ok: false, gender: null, error: "b2b.pdt.detail returned no attributes" };
  }

  const fields = mapAttributes(attrs);

  const product = await prisma.product.findUnique({ where: { pdtid }, select: { id: true } });
  if (!product) {
    return { pdtid, ok: false, gender: fields.gender, error: "no matching Product row (capture must run first)" };
  }

  await prisma.product.update({
    where: { pdtid },
    data: {
      ...fields,
      attributesRaw: attrs as unknown as object,
      attributesSyncedAt: new Date(),
    },
  });

  return { pdtid, ok: true, gender: fields.gender };
}

export interface CaptureAllAttributesReport {
  total: number;
  captured: number;
  noGender: { pdtid: number; styleCode: string }[];
  failed: { pdtid: number; styleCode: string; error: string }[];
  genderCounts: Record<string, number>; // "" key = blank/no Gender value
  stoppedEarly: boolean;
  stopReason?: string;
}

export async function captureAllProductAttributes(): Promise<CaptureAllAttributesReport> {
  const report: CaptureAllAttributesReport = {
    total: 0,
    captured: 0,
    noGender: [],
    failed: [],
    genderCounts: {},
    stoppedEarly: false,
  };

  const favorites: { id: number; no: string }[] = [];
  let start = 0;
  let total = Infinity;
  while (start < total) {
    const page = await withRetry(() => fetchFavoritesPage(start, FAVORITES_PAGE_SIZE));
    total = page.total;
    report.total = total;
    if (page.products.length === 0) break;
    favorites.push(...page.products.map((p) => ({ id: p.id, no: p.no })));
    start += page.products.length;
    await sleep(CALL_PACING_MS);
  }

  for (let i = 0; i < favorites.length; i++) {
    const { id, no } = favorites[i];
    console.log(`[kelme-attributes] (${i + 1}/${favorites.length}) pulling attributes for pdtid ${id} (${no})...`);

    try {
      const result = await withRetry(() => captureProductAttributes(id));
      if (result.ok) {
        report.captured++;
        const key = result.gender ?? "";
        report.genderCounts[key] = (report.genderCounts[key] ?? 0) + 1;
        if (!result.gender) report.noGender.push({ pdtid: id, styleCode: no });
      } else {
        report.failed.push({ pdtid: id, styleCode: no, error: result.error ?? "unknown error" });
      }
    } catch (err) {
      if (isDeadTokenError(err)) {
        report.stoppedEarly = true;
        report.stopReason = "Kelme session expired (code 000005) — stopped, existing data left untouched";
        console.error(`[kelme-attributes] ${report.stopReason}`);
        break;
      }
      report.failed.push({ pdtid: id, styleCode: no, error: err instanceof Error ? err.message : String(err) });
    }

    await sleep(CALL_PACING_MS);
  }

  console.log(
    `[kelme-attributes] summary: captured=${report.captured}/${report.total} failed=${report.failed.length} ` +
      `noGender=${report.noGender.length} genderCounts=${JSON.stringify(report.genderCounts)}` +
      (report.stoppedEarly ? ` STOPPED EARLY: ${report.stopReason}` : ""),
  );

  return report;
}
