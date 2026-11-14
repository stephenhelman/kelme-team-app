/**
 * Colors seed: create the Shopify `shopify--color-pattern` metaobject for a
 * Kelme color code that has none yet, and store its GID on the Color row —
 * the same pattern as the sizes seed. Dry-run by default (scripts/colors.ts).
 *
 * Shape copied from the existing 164 color values (read 2026-11-14):
 *   handle = the color code lower-cased ("214", "x07"), label = "<Name> - <code>",
 *   color = swatch hex (lower-case), image = unset,
 *   color_taxonomy_reference = JSON list of 1..4 TaxonomyValue GIDs (Color attribute),
 *   pattern_taxonomy_reference = one TaxonomyValue GID (Solid = 2874 on 163 of 164).
 *
 * Mappings are ALWAYS human-approved: COLOR_SEED_MAP below is the approved
 * list. A color that is not in it is never created — it is reported with a
 * *suggested* mapping (suggestMapping) so a person can approve it by adding it
 * here. The daily draft job lists such colors in its admin alert and the styles
 * that use them stay blocked until they are seeded.
 */
import { prisma } from "@/lib/prisma";
import { shopifyGraphQL } from "@/lib/shopify";

export const COLOR_TYPE = "shopify--color-pattern";

// Shopify taxonomy "Color" attribute values (read from the live taxonomy, 2026-11-14).
export const TAXONOMY_COLOR: Record<string, string> = {
  Beige: "6", Black: "1", Blue: "2", Bronze: "657", Brown: "7", Clear: "17", Gold: "4", Gray: "8", Green: "9", Multicolor: "2865",
  Navy: "15", Orange: "10", Pink: "11", Purple: "12", Red: "13", "Rose gold": "16", Silver: "5", White: "3", Yellow: "14",
};
// Shopify taxonomy "Pattern" values we use. The taxonomy has NO heathered/melange pattern ("Texture" is the closest, not used).
export const TAXONOMY_PATTERN: Record<string, string> = { solid: "2874" };

const taxGid = (id: string) => `gid://shopify/TaxonomyValue/${id}`;

export interface ColorSeedEntry {
  name: string;
  taxonomyColors: string[]; // names in TAXONOMY_COLOR (1..4)
  hex: string; // swatch, "#rrggbb"
  pattern: keyof typeof TAXONOMY_PATTERN;
}

/** Approved by the owner 2026-11-14. Adding an entry here IS the approval for a new color. */
export const COLOR_SEED_MAP: Record<string, ColorSeedEntry> = {
  "214": { name: "Khaki", taxonomyColors: ["Beige"], hex: "#c3b091", pattern: "solid" },
  "813": { name: "Reddish Orange", taxonomyColors: ["Orange", "Red"], hex: "#e8562a", pattern: "solid" },
  "631": { name: "Light Pink", taxonomyColors: ["Pink"], hex: "#f4b6c2", pattern: "solid" },
  "4033": { name: "Cobalt Blue", taxonomyColors: ["Blue"], hex: "#0047ab", pattern: "solid" },
  "222": { name: "Melange Gray", taxonomyColors: ["Gray"], hex: "#9e9e9e", pattern: "solid" }, // no melange pattern in the taxonomy
  "301": { name: "Grass Green", taxonomyColors: ["Green"], hex: "#4caf50", pattern: "solid" },
  "383": { name: "Bean Green", taxonomyColors: ["Green"], hex: "#8db255", pattern: "solid" },
  "426": { name: "Moon Blue", taxonomyColors: ["Blue"], hex: "#a7c7e7", pattern: "solid" },
  "601": { name: "Rose hermosa", taxonomyColors: ["Pink"], hex: "#e75480", pattern: "solid" },
  "622": { name: "Watermelon Red", taxonomyColors: ["Red", "Pink"], hex: "#fc6c85", pattern: "solid" },
  "655": { name: "Deep Crimson", taxonomyColors: ["Red"], hex: "#9b1b30", pattern: "solid" },
};

export function colorLabel(name: string, code: string): string {
  return `${name} - ${code}`;
}

export function colorCreateVariables(code: string, e: ColorSeedEntry) {
  if (e.taxonomyColors.length < 1 || e.taxonomyColors.length > 4) throw new Error(`color ${code}: needs 1..4 taxonomy colors`);
  return {
    metaobject: {
      type: COLOR_TYPE,
      handle: code.toLowerCase(),
      fields: [
        { key: "label", value: colorLabel(e.name, code) },
        { key: "color", value: e.hex.toLowerCase() },
        { key: "color_taxonomy_reference", value: JSON.stringify(e.taxonomyColors.map((c) => {
          const id = TAXONOMY_COLOR[c];
          if (!id) throw new Error(`color ${code}: unknown taxonomy color "${c}"`);
          return taxGid(id);
        })) },
        { key: "pattern_taxonomy_reference", value: taxGid(TAXONOMY_PATTERN[e.pattern]) },
      ],
    },
  };
}

// --- Suggestions for colors nobody has approved yet (never applied automatically) ---------

const KEYWORDS: [RegExp, string][] = [
  [/khaki|beige|sand|cream|camel|tan\b/i, "Beige"], [/orange/i, "Orange"], [/crimson|red|wine|burgundy|maroon|watermelon|scarlet/i, "Red"],
  [/pink|rose|fuchsia|magenta/i, "Pink"], [/navy/i, "Navy"], [/blue|cobalt|royal|sky|cyan|teal|turquoise/i, "Blue"],
  [/gr[ae]y|silver|melange|charcoal|slate|metal/i, "Gray"], [/green|mint|olive|lime|bean|grass/i, "Green"], [/black/i, "Black"],
  [/white|ivory/i, "White"], [/yellow|lemon/i, "Yellow"], [/purple|violet|lavender|lilac/i, "Purple"], [/brown|coffee|chocolate/i, "Brown"], [/gold/i, "Gold"],
];

/** A starting point for a human only: taxonomy colors guessed from the name's words. */
export function suggestMapping(name: string): { taxonomyColors: string[]; pattern: string; note: string } {
  const found: string[] = [];
  for (const part of name.split("/")) for (const [re, c] of KEYWORDS) if (re.test(part) && !found.includes(c)) found.push(c);
  const taxonomyColors = found.slice(0, 4);
  return {
    taxonomyColors,
    pattern: /melange|heather/i.test(name) ? "solid (no melange pattern exists in the taxonomy)" : "solid",
    note: taxonomyColors.length ? "guess from the name — a hex swatch is still needed" : "no color word recognised — choose taxonomy colors and a hex",
  };
}

// --- Plan / execute ------------------------------------------------------------------------

export interface ColorSeedRow {
  code: string;
  name: string;
  status: "approved" | "needs-approval";
  action: "create-metaobject+store" | "store-gid" | "none" | "refused";
  existingGid: string | null; // a metaobject with this handle already exists in Shopify
  tableGid: string | null;
  suggestion?: ReturnType<typeof suggestMapping>;
}

const LIST_QUERY = `
  query colorMetaobjects($cursor: String) {
    metaobjects(type: "${COLOR_TYPE}", first: 100, after: $cursor) {
      pageInfo { hasNextPage endCursor }
      nodes { id handle }
    }
  }
`;

async function listColorHandles(): Promise<Map<string, string>> {
  const out = new Map<string, string>();
  let cursor: string | null = null;
  for (;;) {
    const res: { data?: { metaobjects: { pageInfo: { hasNextPage: boolean; endCursor: string | null }; nodes: { id: string; handle: string }[] } }; errors?: unknown } = await shopifyGraphQL(LIST_QUERY, { cursor });
    if (res.errors || !res.data) throw new Error(`color metaobject query error: ${JSON.stringify(res.errors)}`);
    for (const n of res.data.metaobjects.nodes) out.set(n.handle, n.id);
    if (!res.data.metaobjects.pageInfo.hasNextPage) break;
    cursor = res.data.metaobjects.pageInfo.endCursor;
  }
  return out;
}

/**
 * Which colors need a Shopify value: every approved entry that is not yet seeded, plus any Color row in the
 * DB that has no GID (those are listed, and refused unless approved). `codes` limits the scope.
 */
export async function planColorSeed(opts: { codes?: string[] } = {}): Promise<{ rows: ColorSeedRow[]; creates: { code: string; entry: ColorSeedEntry }[] }> {
  const [handles, table] = await Promise.all([listColorHandles(), prisma.color.findMany()]);
  const tableBy = new Map(table.map((c) => [c.colorCode, c]));
  const wanted = new Set<string>(opts.codes ?? [...Object.keys(COLOR_SEED_MAP), ...table.filter((c) => !c.shopifyGid).map((c) => c.colorCode)]);
  const rows: ColorSeedRow[] = [];
  const creates: { code: string; entry: ColorSeedEntry }[] = [];
  for (const code of [...wanted].sort()) {
    const approved = COLOR_SEED_MAP[code];
    const row = tableBy.get(code);
    const existingGid = handles.get(code.toLowerCase()) ?? null;
    const tableGid = row?.shopifyGid ?? null;
    const name = approved?.name ?? row?.colorName ?? "(unknown name)";
    if (!approved) {
      rows.push({ code, name, status: "needs-approval", action: "refused", existingGid, tableGid, suggestion: suggestMapping(name) });
      continue;
    }
    let action: ColorSeedRow["action"] = "none";
    if (!existingGid) {
      creates.push({ code, entry: approved });
      action = "create-metaobject+store";
    } else if (tableGid !== existingGid) action = "store-gid";
    rows.push({ code, name, status: "approved", action, existingGid, tableGid });
  }
  return { rows, creates };
}

const CREATE_MUTATION = `
  mutation colorCreate($metaobject: MetaobjectCreateInput!) {
    metaobjectCreate(metaobject: $metaobject) {
      metaobject { id handle fields { key value } }
      userErrors { field message code }
    }
  }
`;

export async function executeColorSeed(plan: Awaited<ReturnType<typeof planColorSeed>>): Promise<{ code: string; gid: string; created: boolean; verified: boolean }[]> {
  const done: { code: string; gid: string; created: boolean; verified: boolean }[] = [];
  for (const row of plan.rows) {
    if (row.action !== "create-metaobject+store" && row.action !== "store-gid") continue;
    const entry = COLOR_SEED_MAP[row.code];
    let gid = row.existingGid;
    let created = false;
    let verified = true;
    if (!gid) {
      const res = await shopifyGraphQL<{ metaobjectCreate: { metaobject: { id: string; handle: string; fields: { key: string; value: string | null }[] } | null; userErrors: unknown[] } }>(CREATE_MUTATION, colorCreateVariables(row.code, entry));
      if (res.errors?.length) throw new Error(`metaobjectCreate error for ${row.code}: ${JSON.stringify(res.errors)}`);
      const p = res.data!.metaobjectCreate;
      if (p.userErrors.length > 0 || !p.metaobject) throw new Error(`metaobjectCreate userErrors for ${row.code}: ${JSON.stringify(p.userErrors)}`);
      gid = p.metaobject.id;
      created = true;
      // Read-back check against what we sent.
      const want = new Map(colorCreateVariables(row.code, entry).metaobject.fields.map((f) => [f.key, f.value]));
      const got = new Map(p.metaobject.fields.map((f) => [f.key, f.value]));
      verified = [...want].every(([k, v]) => String(got.get(k) ?? "").toLowerCase() === v.toLowerCase());
    }
    await prisma.color.upsert({
      where: { colorCode: row.code },
      update: { shopifyGid: gid },
      create: { colorCode: row.code, colorName: entry.name, shopifyGid: gid },
    });
    done.push({ code: row.code, gid, created, verified });
    await new Promise((r) => setTimeout(r, 400));
  }
  return done;
}

// --- Used by the draft job's alert ---------------------------------------------------------

/** Color codes named by a "no Shopify color value to link: a, b" blocker/outcome message. */
export function missingColorCodes(message: string): string[] {
  const m = /no Shopify color value to link: ([^;]+)/.exec(message);
  return m ? m[1].split(",").map((s) => s.trim()).filter(Boolean) : [];
}

export interface MissingColor {
  code: string;
  name: string;
  suggestion: ReturnType<typeof suggestMapping>;
  approved: boolean;
}

export async function describeMissingColors(codes: string[]): Promise<MissingColor[]> {
  const rows = await prisma.color.findMany({ where: { colorCode: { in: codes } } });
  const by = new Map(rows.map((r) => [r.colorCode, r.colorName]));
  return [...new Set(codes)].sort().map((code) => {
    const name = COLOR_SEED_MAP[code]?.name ?? by.get(code) ?? "(name not captured yet)";
    return { code, name, suggestion: suggestMapping(name), approved: Boolean(COLOR_SEED_MAP[code]) };
  });
}

export function missingColorsAlertBody(colors: MissingColor[]): string {
  const lines = colors.map((c) =>
    c.approved
      ? `- ${c.code} ${c.name}: approved mapping exists but not seeded — run \`npm run colors -- seed --execute\``
      : `- ${c.code} ${c.name}: NOT approved. Suggested: ${c.suggestion.taxonomyColors.join(" + ") || "(none recognised)"}, pattern ${c.suggestion.pattern}, hex needed. To approve, add it to COLOR_SEED_MAP in lib/color-seed.ts (taxonomy colors, hex, pattern), then \`npm run colors -- seed\` and \`--execute\`.`,
  );
  return `These Kelme colors have no Shopify color value, so the styles that use them stay blocked (nothing is guessed or created automatically):\n\n${lines.join("\n")}`;
}
