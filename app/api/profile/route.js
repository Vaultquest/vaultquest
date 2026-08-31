import { NextResponse } from "next/server";

/**
 * Profile API proxy (#134).
 *
 * Fronts the backend's authenticated profile contract so the client never talks
 * to the database directly. Reads (`GET`) and updates (`PUT`) are proxied to the
 * backend keyed by the connected wallet.
 *
 * The backend `GET/PUT /profile` endpoints require a wallet principal (a signed
 * challenge) or a service credential. On the browser we cannot produce a
 * Stellar signature for an EVM wallet, so the proxy authenticates as a service
 * using a server-only shared secret when configured (`BACKEND_INTERNAL_SECRET`).
 * When no secret or no backend is reachable, the proxy degrades gracefully to
 * an empty profile rather than fabricating data - achievements are never
 * invented here, only proxied from authoritative records.
 */

const BACKEND_URL = process.env.NEXT_PUBLIC_BACKEND_URL || "http://localhost:3001";
const INTERNAL_SECRET = process.env.BACKEND_INTERNAL_SECRET;

export const dynamic = "force-dynamic";

function serviceHeaders() {
  const headers = { "Content-Type": "application/json" };
  if (INTERNAL_SECRET) {
    headers["x-internal-secret"] = INTERNAL_SECRET;
  }
  return headers;
}

function emptyProfile(wallet) {
  return {
    wallet_address: wallet,
    display_name: null,
    bio: null,
    badge_id: null,
    achievements: [],
  };
}

export async function GET(req) {
  const wallet = req.nextUrl.searchParams.get("wallet");
  if (!wallet || wallet.length === 0) {
    return NextResponse.json(
      { error: { code: "INVALID_PAYLOAD", message: "wallet is required" } },
      { status: 400 },
    );
  }

  try {
    const res = await fetch(
      `${BACKEND_URL}/profile?wallet=${encodeURIComponent(wallet)}`,
      { headers: serviceHeaders(), signal: AbortSignal.timeout(4000) },
    );
    if (res.ok) {
      const json = await res.json();
      return NextResponse.json({ data: json.data }, { headers: { "Cache-Control": "no-store" } });
    }
    if (res.status === 404 || res.status === 401 || res.status === 403) {
      return NextResponse.json(
        { data: emptyProfile(wallet), degraded: true },
        { headers: { "Cache-Control": "no-store" } },
      );
    }
    return NextResponse.json({ error: { code: "UPSTREAM_ERROR", message: "profile unavailable" } }, { status: 502 });
  } catch {
    return NextResponse.json(
      { data: emptyProfile(wallet), degraded: true },
      { headers: { "Cache-Control": "no-store" } },
    );
  }
}

export async function PUT(req) {
  let body;
  try {
    body = await req.json();
  } catch {
    return NextResponse.json(
      { error: { code: "INVALID_PAYLOAD", message: "invalid JSON body" } },
      { status: 400 },
    );
  }

  const wallet = body?.wallet_address;
  if (!wallet || wallet.length === 0) {
    return NextResponse.json(
      { error: { code: "INVALID_PAYLOAD", message: "wallet_address is required" } },
      { status: 400 },
    );
  }

  try {
    const res = await fetch(`${BACKEND_URL}/profile`, {
      method: "PUT",
      headers: serviceHeaders(),
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(4000),
    });

    if (res.ok) {
      const json = await res.json();
      return NextResponse.json({ data: json.data });
    }
    if (res.status === 409) {
      const json = await res.json().catch(() => null);
      return NextResponse.json(
        { error: { code: "CONFLICT", message: json?.error?.message || "display name already taken" } },
        { status: 409 },
      );
    }
    if (res.status === 400) {
      const json = await res.json().catch(() => null);
      return NextResponse.json(
        { error: { code: "INVALID_PAYLOAD", message: json?.error?.message || "invalid profile fields" } },
        { status: 400 },
      );
    }
    return NextResponse.json({ error: { code: "UPSTREAM_ERROR", message: "profile not saved" } }, { status: 502 });
  } catch {
    return NextResponse.json(
      { error: { code: "SAVE_UNAVAILABLE", message: "profile could not be saved right now" } },
      { status: 503 },
    );
  }
}
