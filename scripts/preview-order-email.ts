/**
 * Renders the vendor order sheet from a test fixture to local files — no
 * network, no DB, no send. Usage:
 *   npx tsx scripts/preview-order-email.ts [fixtureName] [outDir]
 * fixtureName: order1028 (default) | orderFeesStripped | orderHeatShort |
 *              orderUnder25 | orderPendingRoster | orderPlain
 */
import { mkdirSync, writeFileSync } from "fs";
import { join } from "path";
import { auditOrder } from "../lib/order-audit";
import { buildCsv, buildHtml, buildSubject, buildText } from "../lib/order-sheet";
import * as fx from "../tests/fixtures";

const name = (process.argv[2] ?? "order1028") as keyof typeof fx;
const outDir = process.argv[3] ?? ".";
const order = fx[name] as typeof fx.order1028;
if (!order?.line_items) throw new Error(`unknown fixture "${name}"`);

const audit = auditOrder(order, fx.tags);
mkdirSync(outDir, { recursive: true });
writeFileSync(join(outDir, `${name}.html`), buildHtml(order, audit, fx.variantInfo));
writeFileSync(join(outDir, `${name}.txt`), buildText(order, audit, fx.variantInfo));
writeFileSync(join(outDir, `${name}.csv`), buildCsv(order, audit, fx.variantInfo));
console.log(`subject: ${buildSubject(order, audit)}`);
console.log(`flags: ${audit.flags.length}`);
for (const f of audit.flags) console.log(`  - [${f.code}] ${f.message}`);
console.log(`wrote ${join(outDir, name)}.{html,txt,csv}`);
