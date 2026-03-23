import { NextResponse } from 'next/server';
import { getDayBriefing } from '@/lib/longitudinal-engine';

export async function GET() {
  try {
    return NextResponse.json({ success: true, briefing: getDayBriefing('default') });
  } catch (error) {
    return NextResponse.json({ error: String(error) }, { status: 500 });
  }
}
