import { NextResponse } from "next/server";
import { MOCK_VAULTS } from "@/lib/vault-mock-data";

export const dynamic = "force-dynamic";

export async function GET() {
  return NextResponse.json(
    {
      vaults: MOCK_VAULTS,
      updatedAt: new Date().toISOString(),
      degraded: false,
    },
    { headers: { "Cache-Control": "no-store" } },
  );
}
