import { PrismaClient } from "@prisma/client";
import fs from "fs";
import path from "path";

const prisma = new PrismaClient();

type CsvRow = {
  kelme_style: string;
  title: string;
  price_low: string;
  price_high: string;
  variant_count: string;
};

function parseCsv(text: string): CsvRow[] {
  const rows: string[][] = [];
  let field = "";
  let row: string[] = [];
  let inQuotes = false;

  for (let i = 0; i < text.length; i++) {
    const c = text[i];

    if (inQuotes) {
      if (c === '"') {
        if (text[i + 1] === '"') {
          field += '"';
          i++;
        } else {
          inQuotes = false;
        }
      } else {
        field += c;
      }
      continue;
    }

    if (c === '"') {
      inQuotes = true;
    } else if (c === ",") {
      row.push(field);
      field = "";
    } else if (c === "\n" || c === "\r") {
      if (c === "\r" && text[i + 1] === "\n") i++;
      row.push(field);
      field = "";
      rows.push(row);
      row = [];
    } else {
      field += c;
    }
  }
  if (field.length > 0 || row.length > 0) {
    row.push(field);
    rows.push(row);
  }

  const nonEmpty = rows.filter((r) => r.some((f) => f.trim() !== ""));
  const [header, ...dataRows] = nonEmpty;

  return dataRows.map((r) => {
    const obj: Record<string, string> = {};
    header.forEach((h, idx) => {
      obj[h.trim()] = (r[idx] ?? "").trim();
    });
    return obj as unknown as CsvRow;
  });
}

async function main() {
  const csvPath = path.join(process.cwd(), "shopify_prices.csv");
  const text = fs.readFileSync(csvPath, "utf-8");
  const csvRows = parseCsv(text);

  const products = await prisma.product.findMany({
    select: { id: true, styleCode: true, sellPrice: true },
  });
  const byStyle = new Map<string, (typeof products)[number]>();
  for (const p of products) {
    byStyle.set(p.styleCode.trim().toUpperCase(), p);
  }

  const unmatched: { style: string; title: string }[] = [];
  const updates: { id: number; sellPrice: number }[] = [];

  for (const row of csvRows) {
    const style = (row.kelme_style ?? "").trim().toUpperCase();
    if (!style) continue;

    const product = byStyle.get(style);
    const priceLow = parseFloat(row.price_low);

    if (!product || Number.isNaN(priceLow)) {
      unmatched.push({ style: row.kelme_style, title: row.title });
      continue;
    }

    updates.push({ id: product.id, sellPrice: priceLow });
  }

  await prisma.$transaction(
    updates.map((u) =>
      prisma.product.update({
        where: { id: u.id },
        data: { sellPrice: u.sellPrice },
      })
    )
  );

  const stillMissing = await prisma.product.findMany({
    where: { sellPrice: null },
    select: { styleCode: true, name: true },
  });

  console.log(`\nPrices set: ${updates.length}`);

  console.log(`\nCSV rows with no matching product: ${unmatched.length}`);
  for (const u of unmatched) {
    console.log(`  - ${u.style} | ${u.title}`);
  }

  console.log(`\nProducts still missing sellPrice: ${stillMissing.length}`);
  for (const p of stillMissing) {
    console.log(`  - ${p.styleCode} | ${p.name}`);
  }
}

main()
  .catch((e) => {
    console.error(e);
    process.exitCode = 1;
  })
  .finally(async () => {
    await prisma.$disconnect();
  });
