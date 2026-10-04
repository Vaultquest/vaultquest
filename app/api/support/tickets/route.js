import { NextResponse } from "next/server";
import {
  clientRateKey,
  getSupportTicketStore,
} from "@/lib/support-ticket-store";

export const dynamic = "force-dynamic";

function clientIp(req) {
  const forwarded = req.headers.get("x-forwarded-for");
  if (forwarded) return forwarded.split(",")[0].trim();
  return req.headers.get("x-real-ip") || "unknown";
}

/**
 * POST /api/support/tickets — durable, rate-limited support intake (#117).
 *
 * Success is returned only after the ticket is persisted with a receipt id.
 * Failures leave the caller's draft untouched (the widget never clears on error).
 */
export async function POST(req) {
  let body;
  try {
    body = await req.json();
  } catch {
    return NextResponse.json(
      { error: { code: "INVALID_PAYLOAD", message: "invalid JSON body" } },
      { status: 400 },
    );
  }

  const store = getSupportTicketStore();
  const ip = clientIp(req);
  const email = typeof body?.email === "string" ? body.email : "";

  try {
    const result = await store.create(body, {
      clientKey: clientRateKey({ ip, email }),
    });

    return NextResponse.json(
      {
        data: {
          id: result.ticket.id,
          status: result.ticket.status,
          created_at: new Date(result.ticket.created_at).toISOString(),
          duplicate: result.duplicate,
        },
      },
      { status: result.duplicate ? 200 : 201 },
    );
  } catch (err) {
    const code = err?.code || "STORE_UNAVAILABLE";
    if (code === "INVALID_PAYLOAD") {
      return NextResponse.json(
        {
          error: {
            code,
            message: err.message || "invalid ticket",
            field_errors: err.fieldErrors || undefined,
          },
        },
        { status: 400 },
      );
    }
    if (code === "IDEMPOTENCY_CONFLICT") {
      return NextResponse.json(
        {
          error: {
            code,
            message: "Your ticket details could not be accepted. Your draft was kept. Please submit again.",
          },
        },
        { status: 409 },
      );
    }
    if (code === "RATE_LIMITED") {
      const retryAfterSec = Math.ceil((err.retryAfterMs || 60_000) / 1000);
      return NextResponse.json(
        {
          error: {
            code,
            message: "Too many tickets submitted. Please try again later.",
            retry_after_seconds: retryAfterSec,
          },
        },
        {
          status: 429,
          headers: { "Retry-After": String(retryAfterSec) },
        },
      );
    }
    return NextResponse.json(
      {
        error: {
          code: "STORE_UNAVAILABLE",
          message: "Support intake is temporarily unavailable. Your draft was kept.",
        },
      },
      { status: 503 },
    );
  }
}

export async function GET(req) {
  const id = req.nextUrl.searchParams.get("id");
  if (!id) {
    return NextResponse.json(
      { error: { code: "INVALID_PAYLOAD", message: "id is required" } },
      { status: 400 },
    );
  }
  const store = getSupportTicketStore();
  const ticket = await store.get(id);
  if (!ticket) {
    return NextResponse.json(
      { error: { code: "NOT_FOUND", message: "ticket not found" } },
      { status: 404 },
    );
  }
  return NextResponse.json({
    data: {
      id: ticket.id,
      status: ticket.status,
      created_at: new Date(ticket.created_at).toISOString(),
      category: ticket.category,
    },
  });
}
