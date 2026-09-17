import { NextResponse } from 'next/server';
import { getDomainRevision } from '@/lib/domain-revision';

export const dynamic = 'force-dynamic';

export async function GET() {
  return NextResponse.json(getDomainRevision(), {
    headers: { 'Cache-Control': 'no-store' },
  });
}
