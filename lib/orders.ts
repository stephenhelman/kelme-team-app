import { randomBytes } from "crypto";
import { prisma } from "./prisma";
import { getSettings } from "./settings";

export interface CartLineInput {
  productId: number;
  styleCode: string;
  name: string;
  color: string;
  size: string;
  qty: number;
  unitPrice: number;
}

export interface PlaceOrderInput {
  items: CartLineInput[];
  customerName: string;
  customerEmail: string;
  customerNote?: string;
}

export const ORDER_STATUSES = ["new", "quoted", "paid", "shipped"] as const;
export type OrderStatus = (typeof ORDER_STATUSES)[number];

function fakePaymentLink(orderId: number): string {
  const token = randomBytes(6).toString("hex");
  return `https://payments.simulated.local/pay/order-${orderId}-${token}`;
}

/**
 * Checkout simulator (2.4): creates a real order record and a placeholder
 * payment link. No charge happens, nothing is sent to Kelme.
 */
export async function placeSimulatedOrder(input: PlaceOrderInput) {
  const settings = await getSettings();
  const unitCount = input.items.reduce((sum, item) => sum + item.qty, 0);

  if (unitCount < settings.minOrderUnits) {
    throw new Error(`Minimum order is ${settings.minOrderUnits} units — add ${settings.minOrderUnits - unitCount} more`);
  }
  if (input.items.length === 0) {
    throw new Error("Cart is empty");
  }

  const itemsTotal = input.items.reduce((sum, item) => sum + item.qty * item.unitPrice, 0);
  const shippingTotal = unitCount * settings.shippingPerUnit;
  const orderTotal = itemsTotal + shippingTotal;

  const order = await prisma.order.create({
    data: {
      status: "new",
      unitCount,
      shippingTotal,
      orderTotal,
      paymentLink: "",
      customerName: input.customerName,
      customerEmail: input.customerEmail,
      customerNote: input.customerNote ?? "",
      items: {
        create: input.items.map((item) => ({
          productId: item.productId,
          styleCode: item.styleCode,
          name: item.name,
          color: item.color,
          size: item.size,
          qty: item.qty,
          unitPrice: item.unitPrice,
        })),
      },
    },
    include: { items: true },
  });

  const paymentLink = fakePaymentLink(order.id);
  return prisma.order.update({
    where: { id: order.id },
    data: { paymentLink },
    include: { items: true },
  });
}

export async function getOrders() {
  return prisma.order.findMany({
    orderBy: { createdAt: "desc" },
    include: { items: true },
  });
}

export async function getOrderById(id: number) {
  return prisma.order.findUnique({ where: { id }, include: { items: true } });
}

export async function setOrderStatus(id: number, status: OrderStatus) {
  return prisma.order.update({ where: { id }, data: { status } });
}
