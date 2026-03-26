import { NextResponse } from 'next/server';
import { getGuardianContext } from '@/lib/guardian-runtime';

// Canonical source-of-truth for current guardian session state.
// All web surfaces poll this. The extension background.js also polls this.
// No client should maintain its own copy of session state — derive from here.
export async function GET() {
  try {
    const context = getGuardianContext();
    return NextResponse.json(context);
  } catch (error) {
    return NextResponse.json({ error: String(error) }, { status: 500 });
  }
}
