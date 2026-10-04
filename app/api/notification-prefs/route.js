import { forwardWalletNotification } from "@/lib/notification-proxy";

export const dynamic = "force-dynamic";

export function GET(req) {
  return forwardWalletNotification(req, "/notification-prefs");
}

export function PUT(req) {
  return forwardWalletNotification(req, "/notification-prefs");
}
