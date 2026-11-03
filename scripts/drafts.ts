/**
 * Draft product creation from Kelme favorites. DRY-RUN by default for every
 * subcommand; only --execute writes Shopify.
 *
 *   npm run drafts -- preflight [--capture] [--styleCode A,B]
 *       Evaluates every favorites-only candidate and writes
 *       draft-preflight-report.md / draft-preflight.json. --capture first
 *       re-captures from Kelme into the DB (DB writes only; never Shopify).
 */
import { prisma } from "@/lib/prisma";
import { runPreflight, writeReport, REPORT_MD } from "@/lib/draft-preflight";

function flag(name: string): boolean {
  return process.argv.includes(`--${name}`);
}
function opt(name: string): string | undefined {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 ? process.argv[i + 1] : undefined;
}

async function main(): Promise<void> {
  const cmd = process.argv[2];
  if (cmd === "preflight") {
    const only = opt("styleCode")?.split(",").map((s) => s.trim()).filter(Boolean);
    const run = await runPreflight({ capture: flag("capture"), only });
    await writeReport(run);
    const clean = run.results.filter((r) => r.clean).length;
    console.log(`pre-flight: ${run.results.length} candidates, ${clean} clean, ${run.results.length - clean} flagged`);
    console.log(`report: ${REPORT_MD}`);
    return;
  }
  console.error("Usage: npm run drafts -- preflight [--capture] [--styleCode A,B]");
  process.exit(1);
}

main()
  .catch((err) => {
    console.error(err instanceof Error ? (err.stack ?? err.message) : err);
    process.exitCode = 1;
  })
  .finally(() => prisma.$disconnect());
