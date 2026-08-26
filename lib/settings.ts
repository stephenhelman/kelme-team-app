import { prisma } from "./prisma";

export interface StoreSettings {
  shippingPerUnit: number;
  minOrderUnits: number;
}

const DEFAULTS: StoreSettings = { shippingPerUnit: 3.0, minOrderUnits: 25 };

export async function getSettings(): Promise<StoreSettings> {
  const row = await prisma.settings.upsert({
    where: { id: 1 },
    update: {},
    create: { id: 1, ...DEFAULTS },
  });
  return { shippingPerUnit: row.shippingPerUnit, minOrderUnits: row.minOrderUnits };
}

export async function updateSettings(patch: Partial<StoreSettings>): Promise<StoreSettings> {
  const row = await prisma.settings.upsert({
    where: { id: 1 },
    update: patch,
    create: { id: 1, ...DEFAULTS, ...patch },
  });
  return { shippingPerUnit: row.shippingPerUnit, minOrderUnits: row.minOrderUnits };
}
