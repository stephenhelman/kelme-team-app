/**
 * Step 2 of the size standardization: make sure a `shopify--size` metaobject
 * exists for every label the policy says we sell, and store its GID on the
 * Size table. Idempotent — an existing metaobject (matched by label) is reused,
 * never duplicated. Dry-run by default; only `execute: true` writes.
 *
 * Shopify's Size metaobject has two required fields: `label` and
 * `taxonomy_reference` (a TaxonomyValue from the product-taxonomy "Size"
 * attribute). The values below were read from the taxonomy on 2026-11-11.
 */
import { prisma } from "@/lib/prisma";
import { shopifyGraphQL } from "@/lib/shopify";
import { ADULT_BASE, KIDS_LABELS, ADULT_EXTENDED } from "@/lib/size-config";

const SIZE_TYPE = "shopify--size";

// label -> Shopify taxonomy Size-attribute value.
export const TAXONOMY_VALUE: Record<string, string> = {
  "2": "gid://shopify/TaxonomyValue/2885",
  "4": "gid://shopify/TaxonomyValue/2896",
  "6": "gid://shopify/TaxonomyValue/2907",
  "8": "gid://shopify/TaxonomyValue/2909",
  "10": "gid://shopify/TaxonomyValue/2880",
  "12": "gid://shopify/TaxonomyValue/2881",
  XXS: "gid://shopify/TaxonomyValue/2911",
  "4XL": "gid://shopify/TaxonomyValue/2919",
  "5XL": "gid://shopify/TaxonomyValue/2920",
  "6XL": "gid://shopify/TaxonomyValue/2921",
  "7XL": "gid://shopify/TaxonomyValue/81407",
};

export interface SeedRow {
  label: string;
  kind: "kids" | "adult";
  existingGid: string | null; // metaobject already in Shopify (by label)
  tableGid: string | null; // what the Size table holds today (null = no row / no GID)
  tableRowExists: boolean;
  action: "create-metaobject+store" | "store-gid" | "none";
}

export interface SeedPlan {
  rows: SeedRow[];
  creates: { label: string; handle: string; taxonomyReference: string }[];
}

const LIST_QUERY = `
  query sizeMetaobjects($cursor: String) {
    metaobjects(type: "${SIZE_TYPE}", first: 100, after: $cursor) {
      pageInfo { hasNextPage endCursor }
      nodes { id fields { key value } }
    }
  }
`;

const CREATE_MUTATION = `
  mutation sizeCreate($metaobject: MetaobjectCreateInput!) {
    metaobjectCreate(metaobject: $metaobject) {
      metaobject { id }
      userErrors { field message code }
    }
  }
`;

async function listShopifySizes(): Promise<Map<string, string>> {
  const byLabel = new Map<string, string>();
  let cursor: string | null = null;
  for (;;) {
    const res: { data?: { metaobjects: { pageInfo: { hasNextPage: boolean; endCursor: string | null }; nodes: { id: string; fields: { key: string; value: string }[] }[] } }; errors?: unknown } =
      await shopifyGraphQL(LIST_QUERY, { cursor });
    if (res.errors) throw new Error(`size metaobject query error: ${JSON.stringify(res.errors)}`);
    for (const n of res.data!.metaobjects.nodes) {
      const label = n.fields.find((f) => f.key === "label")?.value;
      if (label && !byLabel.has(label)) byLabel.set(label, n.id);
    }
    if (!res.data!.metaobjects.pageInfo.hasNextPage) break;
    cursor = res.data!.metaobjects.pageInfo.endCursor;
  }
  return byLabel;
}

/** Labels pass 1 needs a Size row + GID for: every kids label and ADULT_BASE (+ ADULT_EXTENDED when enabled). */
export function requiredLabels(): { label: string; kind: "kids" | "adult" }[] {
  return [
    ...KIDS_LABELS.map((label) => ({ label, kind: "kids" as const })),
    ...[...ADULT_BASE, ...ADULT_EXTENDED].map((label) => ({ label, kind: "adult" as const })),
  ];
}

export async function planSeed(): Promise<SeedPlan> {
  const [shopify, table] = await Promise.all([listShopifySizes(), prisma.size.findMany()]);
  const tableBy = new Map(table.map((t) => [t.shopifySize, t]));
  const rows: SeedRow[] = [];
  const creates: SeedPlan["creates"] = [];
  for (const { label, kind } of requiredLabels()) {
    const existingGid = shopify.get(label) ?? null;
    const row = tableBy.get(label);
    const tableGid = row?.shopifyGid ?? null;
    let action: SeedRow["action"] = "none";
    if (!existingGid) {
      const tax = TAXONOMY_VALUE[label];
      if (!tax) throw new Error(`no taxonomy value known for new size "${label}" — add it to TAXONOMY_VALUE after checking Shopify's taxonomy`);
      creates.push({ label, handle: label.toLowerCase(), taxonomyReference: tax });
      action = "create-metaobject+store";
    } else if (tableGid !== existingGid) {
      action = "store-gid";
    }
    rows.push({ label, kind, existingGid, tableGid, tableRowExists: !!row, action });
  }
  return { rows, creates };
}

export function createVariables(c: SeedPlan["creates"][number]) {
  return {
    metaobject: {
      type: SIZE_TYPE,
      handle: c.handle,
      fields: [
        { key: "label", value: c.label },
        { key: "taxonomy_reference", value: c.taxonomyReference },
      ],
    },
  };
}

export async function executeSeed(plan: SeedPlan): Promise<{ label: string; gid: string; created: boolean }[]> {
  const done: { label: string; gid: string; created: boolean }[] = [];
  for (const row of plan.rows) {
    if (row.action === "none") continue;
    let gid = row.existingGid;
    let created = false;
    if (!gid) {
      const c = plan.creates.find((x) => x.label === row.label)!;
      const res = await shopifyGraphQL<{ metaobjectCreate: { metaobject: { id: string } | null; userErrors: { field: string[] | null; message: string; code: string }[] } }>(
        CREATE_MUTATION,
        createVariables(c),
      );
      if (res.errors?.length) throw new Error(`metaobjectCreate error for ${row.label}: ${JSON.stringify(res.errors)}`);
      const payload = res.data!.metaobjectCreate;
      if (payload.userErrors.length > 0 || !payload.metaobject) throw new Error(`metaobjectCreate userErrors for ${row.label}: ${JSON.stringify(payload.userErrors)}`);
      gid = payload.metaobject.id;
      created = true;
    }
    await prisma.size.upsert({
      where: { shopifySize: row.label },
      update: { shopifyGid: gid, kind: row.kind },
      create: { shopifySize: row.label, shopifyGid: gid, kind: row.kind },
    });
    done.push({ label: row.label, gid, created });
    await new Promise((r) => setTimeout(r, 400));
  }
  return done;
}
