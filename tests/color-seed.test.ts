import { test } from "node:test";
import assert from "node:assert/strict";
import { COLOR_SEED_MAP, TAXONOMY_COLOR, TAXONOMY_PATTERN, colorCreateVariables, colorLabel, missingColorCodes, missingColorsAlertBody, suggestMapping } from "../lib/color-seed";
import { alertsFor } from "../lib/auto-drafts";
import type { RunReport } from "../lib/draft-run";

test("the 11 approved colors are exactly the owner's mapping", () => {
  const m = COLOR_SEED_MAP;
  assert.deepEqual(Object.keys(m).sort(), ["214", "222", "301", "383", "4033", "426", "601", "622", "631", "655", "813"].sort());
  const want: Record<string, [string[], string]> = {
    "214": [["Beige"], "#c3b091"], "813": [["Orange", "Red"], "#e8562a"], "631": [["Pink"], "#f4b6c2"], "4033": [["Blue"], "#0047ab"], "222": [["Gray"], "#9e9e9e"],
    "301": [["Green"], "#4caf50"], "383": [["Green"], "#8db255"], "426": [["Blue"], "#a7c7e7"], "601": [["Pink"], "#e75480"], "622": [["Red", "Pink"], "#fc6c85"], "655": [["Red"], "#9b1b30"],
  };
  for (const [code, [colors, hex]] of Object.entries(want)) {
    assert.deepEqual(m[code].taxonomyColors, colors, code);
    assert.equal(m[code].hex, hex, code);
    assert.equal(m[code].pattern, "solid", code);
  }
});

test("create payload has the same structure as the existing color values", () => {
  const v = colorCreateVariables("813", COLOR_SEED_MAP["813"]).metaobject;
  assert.equal(v.type, "shopify--color-pattern");
  assert.equal(v.handle, "813");
  assert.deepEqual(v.fields.map((f) => f.key), ["label", "color", "color_taxonomy_reference", "pattern_taxonomy_reference"]);
  const f = Object.fromEntries(v.fields.map((x) => [x.key, x.value]));
  assert.equal(f.label, "Reddish Orange - 813"); // "<Name> - <code>", like "Red - 600"
  assert.equal(f.color, "#e8562a");
  assert.deepEqual(JSON.parse(f.color_taxonomy_reference), ["gid://shopify/TaxonomyValue/10", "gid://shopify/TaxonomyValue/13"]);
  assert.equal(f.pattern_taxonomy_reference, "gid://shopify/TaxonomyValue/2874"); // Solid, used by 163 of the 164 existing values
  assert.equal(colorLabel("Khaki", "214"), "Khaki - 214");
});

test("every approved entry resolves to real taxonomy values and a valid hex (1..4 colors)", () => {
  for (const [code, e] of Object.entries(COLOR_SEED_MAP)) {
    assert.match(e.hex, /^#[0-9a-f]{6}$/, code);
    assert.ok(e.taxonomyColors.length >= 1 && e.taxonomyColors.length <= 4, code);
    for (const c of e.taxonomyColors) assert.ok(TAXONOMY_COLOR[c], `${code} ${c}`);
    assert.ok(TAXONOMY_PATTERN[e.pattern], code);
  }
});

test("suggestions are only suggestions: keyword guesses, melange noted, unknown words left empty", () => {
  assert.deepEqual(suggestMapping("Neon Orange/Black").taxonomyColors, ["Orange", "Black"]);
  assert.deepEqual(suggestMapping("Wine Red").taxonomyColors, ["Red"]);
  assert.match(suggestMapping("Melange Gray").pattern, /no melange pattern/);
  assert.deepEqual(suggestMapping("Zorp").taxonomyColors, []);
});

test("unknown colors: parsed from the blocker, listed with a suggestion, never auto-seeded", () => {
  assert.deepEqual(missingColorCodes("Cannot execute — color(s) with no Shopify color value to link: 214, 9999; other"), ["214", "9999"]);
  const body = missingColorsAlertBody([
    { code: "9999", name: "Neon Orange", suggestion: suggestMapping("Neon Orange"), approved: false },
    { code: "214", name: "Khaki", suggestion: suggestMapping("Khaki"), approved: true },
  ]);
  assert.match(body, /9999 Neon Orange: NOT approved\. Suggested: Orange/);
  assert.match(body, /214 Khaki: approved mapping exists but not seeded/);
  const r: RunReport = { runId: 1, source: "auto", pending: 1, created: [], blocked: [], failed: [], skipped: [], overCap: [], needsHuman: [], stoppedReason: null, missingColors: [{ code: "9999", name: "Neon Orange", suggestion: suggestMapping("Neon Orange"), approved: false }] };
  const a = alertsFor(r, 15).find((x) => x.kind === "auto_drafts_new_colors")!;
  assert.equal(a.isBad, true);
  assert.match(a.body!, /stay blocked/);
  assert.equal(alertsFor({ ...r, missingColors: [] }, 15).find((x) => x.kind === "auto_drafts_new_colors")!.isBad, false);
});
