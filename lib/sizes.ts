// Canonical size display order (dependency-free so pure modules like lib/order-sheet.ts can import it).
// Derived from lib/size-config.ts — edit the config, not this list.
import { buildSizeOrder } from "./size-config";

export const CANONICAL_SIZE_ORDER: string[] = buildSizeOrder();
