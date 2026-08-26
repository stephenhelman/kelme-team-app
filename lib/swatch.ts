// A handful of jersey-ish colors for swatches whose color name we can't map
// to a real hex (Kelme gives us a name, not a swatch value).
const KNOWN: Record<string, string> = {
  white: "#f4f4f4",
  black: "#1a1a1a",
  red: "#c81e2c",
  blue: "#1e4fc8",
  navy: "#132250",
  green: "#1f7a3d",
  yellow: "#f5c400",
  orange: "#e0641a",
  gray: "#7a7a7a",
  grey: "#7a7a7a",
  purple: "#5b2a86",
  pink: "#e0699f",
  gold: "#c99a2e",
  silver: "#b9bdc4",
};

export function swatchColor(colorName: string): string {
  const key = colorName.trim().toLowerCase();
  for (const [name, hex] of Object.entries(KNOWN)) {
    if (key.includes(name)) return hex;
  }
  // Deterministic fallback so unmapped colors stay visually distinct.
  let hash = 0;
  for (let i = 0; i < key.length; i++) hash = key.charCodeAt(i) + ((hash << 5) - hash);
  const hue = Math.abs(hash) % 360;
  return `hsl(${hue}, 45%, 45%)`;
}
