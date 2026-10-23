import { NextResponse } from 'next/server';
import { EndsemInputError, getEndsemState, recordEndsemAction } from '@/lib/endsem-study';

export const dynamic = 'force-dynamic';

export async function GET() {
  return NextResponse.json(getEndsemState(), {headers:{'Cache-Control':'no-store'}});
}

export async function POST(request: Request) {
  try {
    let body: unknown;
    try { body = await request.json(); } catch { throw new EndsemInputError('A valid JSON object is required.'); }
    if (!body || typeof body!=='object' || Array.isArray(body)) throw new EndsemInputError('A valid JSON object is required.');
    recordEndsemAction(body as Record<string,unknown>);
    if ((body as Record<string,unknown>).action==='rolling_window') {
      const {refreshStudyChatCalendar}=await import('@/lib/study-chat');
      await refreshStudyChatCalendar();
    }
    return NextResponse.json(getEndsemState(), {headers:{'Cache-Control':'no-store'}});
  } catch (error) {
    if (error instanceof EndsemInputError) return NextResponse.json({error:error.message},{status:400});
    console.error('[Endsem] Action failed:', error);
    return NextResponse.json({error:'Could not update Endsem Lock-In. Try again.'},{status:500});
  }
}
