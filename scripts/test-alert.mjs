/**
 * Manually fires a real admin alert email to confirm RESEND_API_KEY and
 * ADMIN_NOTIFY_EMAIL are actually reachable wherever this runs — run it
 * locally (node --env-file=.env) to check your own env, or on Railway
 * (railway run npm run alert:test) to check the worker's actual env,
 * since a missing var there silently no-ops the worker's real alerts.
 *
 * Usage:
 *   npm run alert:test
 */
import { sendTestAlert } from "../lib/admin-notify.ts";

sendTestAlert()
  .then(() => {
    console.log("Test alert sent — check ADMIN_NOTIFY_EMAIL's inbox.");
  })
  .catch((err) => {
    console.error(`Test alert FAILED: ${err instanceof Error ? err.message : String(err)}`);
    process.exit(1);
  });
