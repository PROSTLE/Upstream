// One-time PayPal sandbox setup: catalog product, billing plan, webhook subscription.
// Idempotent: ids are stored in the database and reused on the next run.
import { config, features } from "../config.ts";
import { initDb } from "../db.ts";
import { ensureProductAndPlan } from "../paypal/subscriptions.ts";
import { ensureWebhook } from "../paypal/webhooks.ts";

if (!features.paypal) {
  console.error("Set PAYPAL_CLIENT_ID and PAYPAL_CLIENT_SECRET in .env first (developer.paypal.com > Apps & Credentials > Sandbox).");
  process.exit(1);
}
initDb(config.DATABASE_PATH);
console.log(`PayPal ${config.PAYPAL_ENV} at ${config.PAYPAL_API_BASE}`);
const plan = await ensureProductAndPlan();
console.log(`Product ${plan.productId}, plan ${plan.planId}${plan.created.length ? ` (created ${plan.created.join(", ")})` : " (already existed)"}`);
const hook = await ensureWebhook();
if ("skipped" in hook) console.log(`Webhook not registered: ${hook.skipped}. The hourly reconciler still syncs batches.`);
else console.log(`Webhook ${hook.id}${hook.created ? " created" : " already registered"} -> ${config.PUBLIC_BASE_URL}/api/paypal/webhook`);
