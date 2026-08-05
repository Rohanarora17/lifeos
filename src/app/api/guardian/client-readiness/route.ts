import { NextResponse } from 'next/server';
import { getGuardianClientReadiness } from '@/lib/guardian-client-status';

export const dynamic = 'force-dynamic';

export async function GET() {
  return NextResponse.json(getGuardianClientReadiness(), {
    headers: { 'Cache-Control': 'no-store' },
  });
}
