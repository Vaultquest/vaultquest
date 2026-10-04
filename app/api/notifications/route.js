import { forwardWalletNotification } from "@/lib/notification-proxy";

export const dynamic = "force-dynamic";

export function GET(req) {
  return forwardWalletNotification(req, "/notifications");
}
