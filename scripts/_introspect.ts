import { shopifyGraphQL } from "@/lib/shopify";
const names = process.argv.slice(2);
(async () => {
  for (const n of names) {
    const r = await shopifyGraphQL<{ __type: { kind: string; inputFields?: { name: string; type: unknown }[]; fields?: { name: string; type: unknown }[]; enumValues?: { name: string }[] } | null }>(
      `query($n:String!){__type(name:$n){kind inputFields{name type{...T}} fields{name type{...T}} enumValues{name}}} fragment T on __Type{kind name ofType{kind name ofType{kind name ofType{kind name}}}}`, { n });
    const t = r.data?.__type;
    const fmt = (x: any): string => (x.name ?? `${x.kind}<${x.ofType ? fmt(x.ofType) : ""}>`);
    console.log(`== ${n} (${t?.kind})`);
    for (const f of t?.inputFields ?? t?.fields ?? []) console.log(`  ${f.name}: ${fmt(f.type)}`);
    for (const e of t?.enumValues ?? []) console.log(`  ${e.name}`);
  }
  process.exit(0);
})();
