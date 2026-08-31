import { NextResponse } from "next/server";

export const dynamic = "force-dynamic";

const BACKEND_URL =
  process.env.NEXT_PUBLIC_BACKEND_URL || "http://localhost:3001";
const PROBE_TIMEOUT_MS = 8000;

function outagePayload(message) {
  return {
    status: "outage",
    checked_at: new Date().toISOString(),
    checks: [
      {
        id: "backend",
        name: "VaultQuest Backend",
        url: "/health/probe",
        status: "outage",
        latency_ms: 0,
        error: message,
      },
    ],
  };
}

function isValidProbe(data) {
  return (
    data &&
    typeof data === "object" &&
    typeof data.status === "string" &&
    Array.isArray(data.checks)
  );
}

/**
 * Same-origin health probe (#116). The browser status banner fetches this
 * route (never the third-party RPC hosts directly), so it cannot receive an
 * opaque `no-cors` response. This handler performs the real dependency probe
 * server-side by proxying the backend's `/health/probe` endpoint, which
 * measures elapsed latency, classifies timeouts/slow responses/outages, and
 * stamps the result with `checked_at`.
 *
 * Every failure to obtain a well-formed probe result is reported as an
 * outage with a 503 status — a broken probe must never masquerade as
 * "operational".
 */
export async function GET() {
  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), PROBE_TIMEOUT_MS);

  try {
    const response = await fetch(`${BACKEND_URL}/health/probe`, {
      method: "GET",
      headers: { accept: "application/json" },
      signal: controller.signal,
      cache: "no-store",
    });

    if (!response.ok) {
      return NextResponse.json(
        outagePayload(`Backend probe failed (HTTP ${response.status})`),
        { status: 503, headers: { "Cache-Control": "no-store" } },
      );
    }

    let payload;
    try {
      payload = await response.json();
    } catch {
      return NextResponse.json(outagePayload("Backend probe returned an invalid response"), {
        status: 503,
        headers: { "Cache-Control": "no-store" },
      });
    }

    const data = payload?.data;
    if (!isValidProbe(data)) {
      return NextResponse.json(outagePayload("Backend probe returned an invalid payload"), {
        status: 503,
        headers: { "Cache-Control": "no-store" },
      });
    }

    return NextResponse.json(data, { headers: { "Cache-Control": "no-store" } });
  } catch (error) {
    const message =
      error?.name === "AbortError"
        ? "Backend probe timed out"
        : error instanceof Error
          ? error.message
          : "Backend probe unreachable";
    return NextResponse.json(outagePayload(message), {
      status: 503,
      headers: { "Cache-Control": "no-store" },
    });
  } finally {
    clearTimeout(timeoutId);
  }
}