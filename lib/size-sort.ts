// Natural sort so sizes read like a kit sheet (S, M, L, XL, 2XL...) rather
// than alphabetically (2XL before L).
export function sizeSortKey(size: string): [number, string] {
  const match = size.match(/^(\d+)?\s*(X*S|X*L|M)?$/i);
  if (match) {
    const multiplier = match[1] ? parseInt(match[1], 10) : 1;
    const base = (match[2] ?? "").toUpperCase();
    const xCount = (base.match(/X/g) ?? []).length;
    if (base.endsWith("S")) return [0 - xCount, size];
    if (base.endsWith("L")) return [2 + xCount * multiplier, size];
    if (base === "M") return [1, size];
  }
  const cmMatch = size.match(/^(\d+)\s*cm$/i);
  if (cmMatch) return [10 + Number(cmMatch[1]), size];
  const numeric = Number(size);
  if (!Number.isNaN(numeric)) return [10 + numeric, size];
  return [999, size];
}
