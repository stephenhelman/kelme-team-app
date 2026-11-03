/**
 * Split-aware style-code matching against Shopify product titles. Pure — no
 * DB, no Shopify. Single source of truth for relink, reconcile, tags and the
 * batch orchestrator (previously each carried its own copy of a word-boundary
 * regex).
 *
 * Two conventions share the catalog and the old regex confused them:
 *   - Suffixed Kelme codes ("K16XLQC010-1") are their OWN style codes. The old
 *     boundary regex treated "-" as a boundary, so the base code "K16XLQC010"
 *     also matched a title that only carried "K16XLQC010-1". An exact suffixed
 *     code now matches only itself, and a base code never claims an occurrence
 *     that is really a suffixed sibling.
 *   - Oversized products are split on Shopify into "(Black Base)" /
 *     "(White Base)" / "(Other Base)" products that all carry the SAME base
 *     style code in the title. The sub-product a colorCode belongs to is
 *     decided by lib/shopify-split.ts's baseGroup(colorCode).
 */
import { baseGroup, type BaseGroup } from "@/lib/shopify-split";

function escapeRegex(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

// A trailing "-<1-2 digits>" is a split-sibling suffix; "-2026" (a year) is not.
const SIBLING_SUFFIX = /^-\d{1,2}(?![A-Za-z0-9])/;
const HAS_SUFFIX = /-\d{1,2}$/;

export function titleHasStyleCode(title: string, styleCode: string): boolean {
  const re = new RegExp(`(^|[^A-Za-z0-9])${escapeRegex(styleCode)}(?![A-Za-z0-9])`, "g");
  const baseOnly = !HAS_SUFFIX.test(styleCode);
  for (const m of title.matchAll(re)) {
    if (baseOnly) {
      const after = title.slice((m.index ?? 0) + m[0].length);
      if (SIBLING_SUFFIX.test(after)) continue; // this occurrence is "<code>-N", a different style
    }
    return true;
  }
  return false;
}

export function matchingStyleCodes(title: string, styleCodes: string[]): string[] {
  return styleCodes.filter((sc) => titleHasStyleCode(title, sc));
}

const BASE_LABEL_RE = /\((Black|White|Other) Base\)/i;

// The base group a split sub-product's title declares, or null for an
// ordinary (unsplit) product.
export function titleBaseGroup(title: string): BaseGroup | null {
  const m = BASE_LABEL_RE.exec(title);
  if (!m) return null;
  const word = m[1].toLowerCase();
  return word === "black" ? "Black Base" : word === "white" ? "White Base" : "Other";
}

// Can a variant of this colorCode live on this product? Unsplit products
// accept every color; a "(X Base)" sub-product only its own group's colors.
export function colorBelongsToTitle(title: string, colorCode: string): boolean {
  const g = titleBaseGroup(title);
  return g === null || g === baseGroup(colorCode);
}

// Narrow style-code candidates to the sub-product for `group`. With no
// group requested, a split family stays multi-candidate (ambiguous) — never
// guess. A group request against an unsplit product is a no-op.
export function pickSubProduct<T extends { title: string }>(candidates: T[], group?: BaseGroup): T[] {
  if (!group) return candidates;
  if (candidates.every((c) => titleBaseGroup(c.title) === null)) return candidates;
  return candidates.filter((c) => titleBaseGroup(c.title) === group);
}
