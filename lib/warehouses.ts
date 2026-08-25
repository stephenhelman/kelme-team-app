// Kelme returns warehouse names in Chinese. Colors and sizes already come
// back in English. Rename these display labels freely.
export const WAREHOUSE_DISPLAY_NAMES: Record<string, string> = {
  专业装备备货仓: "Main Warehouse",
  专业装备京易仓: "JD Express Warehouse",
};

export function displayWarehouseName(raw: string): string {
  return WAREHOUSE_DISPLAY_NAMES[raw] ?? raw;
}
