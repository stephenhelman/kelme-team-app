/**
 * Registers the orders/paid webhook subscription via webhookSubscriptionCreate.
 *
 *   npx tsx --env-file=.env scripts/register-orders-webhook.ts            # dry-run: prints the mutation, touches nothing
 *   npx tsx --env-file=.env scripts/register-orders-webhook.ts --execute  # registers it on the store
 *
 * Callback URL: --url=<https url> if given, else ${SHOPIFY_APP_URL}/shopify/webhooks/orders-paid.
 * Needs the read_orders scope (re-run /shopify/auth first). --execute first
 * lists existing ORDERS_PAID subscriptions and refuses to create a duplicate.
 * includeFields trims the payload at the source so Shopify never sends us
 * customer/address fields the sheet doesn't use.
 */
import { shopifyGraphQL } from "../lib/shopify";

const CREATE_MUTATION = `mutation webhookSubscriptionCreate($topic: WebhookSubscriptionTopic!, $webhookSubscription: WebhookSubscriptionInput!) {
  webhookSubscriptionCreate(topic: $topic, webhookSubscription: $webhookSubscription) {
    webhookSubscription { id topic uri includeFields }
    userErrors { field message }
  }
}`;

const LIST_QUERY = `query existingOrdersPaid {
  webhookSubscriptions(first: 25, topics: [ORDERS_PAID]) {
    nodes { id topic uri }
  }
}`;

const INCLUDE_FIELDS = ["id", "name", "created_at", "currency", "line_items"];

function callbackUrl(): string {
  const arg = process.argv.find((a) => a.startsWith("--url="))?.slice("--url=".length);
  const base = arg ?? process.env.SHOPIFY_APP_URL;
  if (!base) throw new Error("Pass --url=https://<host>/shopify/webhooks/orders-paid or set SHOPIFY_APP_URL");
  const url = arg ? new URL(arg) : new URL("/shopify/webhooks/orders-paid", base);
  if (url.protocol !== "https:") throw new Error("Webhook callback must be https");
  return url.toString();
}

async function main() {
  const execute = process.argv.includes("--execute");
  const variables = {
    topic: "ORDERS_PAID",
    webhookSubscription: { uri: callbackUrl(), format: "JSON", includeFields: INCLUDE_FIELDS },
  };

  console.log(execute ? "EXECUTE — registering webhook" : "DRY RUN — nothing is sent to Shopify (pass --execute to register)");
  console.log("\nMutation:\n" + CREATE_MUTATION);
  console.log("\nVariables:\n" + JSON.stringify(variables, null, 2));
  if (!execute) return;

  const existing = await shopifyGraphQL<{ webhookSubscriptions: { nodes: { id: string; uri: string }[] } }>(LIST_QUERY);
  if (existing.errors?.length) throw new Error(existing.errors.map((e) => e.message).join("; "));
  const dupe = existing.data?.webhookSubscriptions.nodes.find((n) => n.uri === variables.webhookSubscription.uri);
  if (dupe) {
    console.log(`\nAlready registered (${dupe.id}) for this URL — nothing to do.`);
    return;
  }

  const res = await shopifyGraphQL<{
    webhookSubscriptionCreate: { webhookSubscription: { id: string } | null; userErrors: { field: string[]; message: string }[] };
  }>(CREATE_MUTATION, variables);
  if (res.errors?.length) throw new Error(res.errors.map((e) => e.message).join("; "));
  const out = res.data!.webhookSubscriptionCreate;
  if (out.userErrors.length) throw new Error(`userErrors: ${JSON.stringify(out.userErrors)}`);
  console.log(`\nRegistered: ${out.webhookSubscription?.id}`);
}

main().catch((err) => {
  console.error(err instanceof Error ? err.message : String(err));
  process.exit(1);
});
