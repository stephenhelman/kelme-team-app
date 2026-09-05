/**
 * Trims one of the abandoned duplicate "Base" products (created by
 * splitting an oversized product 3x but never color-filtering each copy —
 * see lib/shopify-split.ts) down to just its own base-group color subset.
 * Reuses the exact proven reconcile mechanism (lib/shopify-reconcile.ts's
 * setShopifyProductStructure) against an explicitly-known Shopify product
 * ID — these products can't be matched by styleCode-in-title the normal
 * way, since all 3 duplicates share the same styleCode in their title.
 */
import { prisma } from "@/lib/prisma";
import {
  fetchOneShopifyProduct,
  setShopifyProductStructure,
  buildOptionValues,
  flattenCurrent,
  computeDiff,
  type TargetVariant,
} from "@/lib/shopify-reconcile";
import { planSizeOrder, executeSizeOrder } from "@/lib/shopify-order";
import { planMedia, executeMedia } from "@/lib/shopify-media";
import { dryRunTags, executeTags } from "@/lib/shopify-tags";
import { baseGroup, type BaseGroup } from "@/lib/shopify-split";

async function getFilteredTarget(styleCode: string, group: BaseGroup): Promise<TargetVariant[]> {
  const product = await prisma.product.findFirst({
    where: { styleCode },
    include: { variants: { orderBy: [{ colorCode: "asc" }, { shopifySize: "asc" }] } },
  });
  if (!product) throw new Error(`No DB product found for styleCode "${styleCode}"`);

  const colorCodes = [...new Set(product.variants.map((v) => v.colorCode))];
  const sizes = [...new Set(product.variants.map((v) => v.shopifySize))];
  const [colors, sizeRows] = await Promise.all([
    prisma.color.findMany({ where: { colorCode: { in: colorCodes } } }),
    prisma.size.findMany({ where: { shopifySize: { in: sizes } } }),
  ]);
  const colorGidByCode = new Map(colors.map((c) => [c.colorCode, c.shopifyGid]));
  const sizeGidBySize = new Map(sizeRows.map((s) => [s.shopifySize, s.shopifyGid]));

  const fullTarget: TargetVariant[] = product.variants.map((v) => ({
    styleCode,
    colorCode: v.colorCode,
    colorName: v.colorName,
    colorGid: colorGidByCode.get(v.colorCode) ?? null,
    size: v.shopifySize,
    sizeGid: sizeGidBySize.get(v.shopifySize) ?? null,
  }));

  return fullTarget.filter((t) => baseGroup(t.colorCode) === group);
}

export interface TrimPlan {
  styleCode: string;
  shopifyProductId: number;
  shopifyTitle: string;
  group: BaseGroup;
  targetColors: { colorCode: string; colorName: string }[];
  currentVariantCount: number;
  resultingVariantCount: number;
  toAdd: { colorName: string; colorCode: string; size: string }[];
  toDelete: { variantId: number; color: string | null; size: string | null }[];
  missingGids: string[];
  underLimit: boolean;
}

export async function dryRunTrim(styleCode: string, shopifyProductId: number, group: BaseGroup): Promise<TrimPlan> {
  const filteredTarget = await getFilteredTarget(styleCode, group);

  const missingGids: string[] = [];
  for (const t of filteredTarget) {
    if (!t.colorGid) missingGids.push(`Color ${t.colorCode} (${t.colorName}) has no shopifyGid`);
    if (!t.sizeGid) missingGids.push(`Size ${t.size} has no shopifyGid`);
  }

  const shopifyProduct = await fetchOneShopifyProduct(shopifyProductId);
  const current = flattenCurrent(shopifyProduct);
  const diff = computeDiff(current, filteredTarget);

  const distinctColors = [...new Map(filteredTarget.map((t) => [t.colorCode, t.colorName])).entries()].map(
    ([colorCode, colorName]) => ({ colorCode, colorName }),
  );

  return {
    styleCode,
    shopifyProductId,
    shopifyTitle: shopifyProduct.title,
    group,
    targetColors: distinctColors,
    currentVariantCount: current.length,
    resultingVariantCount: filteredTarget.length,
    toAdd: diff.toAdd,
    toDelete: diff.toDelete,
    missingGids,
    underLimit: filteredTarget.length < 100,
  };
}

export interface TrimExecuteResult {
  styleCode: string;
  shopifyProductId: number;
  group: BaseGroup;
  steps: {
    reconcile: { ok: boolean; error?: string };
    sizeOrder: { ok: boolean; error?: string };
    media: { ok: boolean; error?: string };
    tags: { ok: boolean; error?: string };
  };
  afterColorCodes: string[];
  afterVariantCount: number;
  overallOk: boolean;
}

export async function executeTrim(styleCode: string, shopifyProductId: number, group: BaseGroup): Promise<TrimExecuteResult> {
  const plan = await dryRunTrim(styleCode, shopifyProductId, group);
  if (plan.missingGids.length > 0) {
    throw new Error(`Cannot execute — missing shopifyGid: ${plan.missingGids.join("; ")}`);
  }
  if (!plan.underLimit) {
    throw new Error(`Cannot execute — resulting variant count ${plan.resultingVariantCount} is not under 100`);
  }

  const filteredTarget = await getFilteredTarget(styleCode, group);
  const { colorValues, sizeValues } = buildOptionValues(filteredTarget);

  const steps: TrimExecuteResult["steps"] = {
    reconcile: { ok: false },
    sizeOrder: { ok: false },
    media: { ok: false },
    tags: { ok: false },
  };

  try {
    await setShopifyProductStructure(shopifyProductId, colorValues, sizeValues, filteredTarget);
    steps.reconcile = { ok: true };
  } catch (err) {
    steps.reconcile = { ok: false, error: err instanceof Error ? err.message : String(err) };
  }

  if (steps.reconcile.ok) {
    try {
      await executeSizeOrder(shopifyProductId);
      steps.sizeOrder = { ok: true };
    } catch (err) {
      steps.sizeOrder = { ok: false, error: err instanceof Error ? err.message : String(err) };
    }

    try {
      await executeMedia(shopifyProductId);
      steps.media = { ok: true };
    } catch (err) {
      steps.media = { ok: false, error: err instanceof Error ? err.message : String(err) };
    }

    try {
      const t = await executeTags(styleCode, plan.shopifyTitle);
      steps.tags = t.matchesTarget ? { ok: true } : { ok: false, error: "post-write tags did not match target" };
    } catch (err) {
      steps.tags = { ok: false, error: err instanceof Error ? err.message : String(err) };
    }
  } else {
    steps.sizeOrder = { ok: false, error: "skipped — reconcile step failed" };
    steps.media = { ok: false, error: "skipped — reconcile step failed" };
    steps.tags = { ok: false, error: "skipped — reconcile step failed" };
  }

  const afterProduct = await fetchOneShopifyProduct(shopifyProductId);
  const afterFlat = flattenCurrent(afterProduct);
  const afterColorCodes = [...new Set(afterFlat.map((c) => c.colorCode).filter((c): c is string => !!c))].sort();

  return {
    styleCode,
    shopifyProductId,
    group,
    steps,
    afterColorCodes,
    afterVariantCount: afterFlat.length,
    overallOk: steps.reconcile.ok && steps.sizeOrder.ok && steps.media.ok && steps.tags.ok,
  };
}
