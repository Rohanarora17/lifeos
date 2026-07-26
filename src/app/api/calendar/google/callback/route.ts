import { NextRequest, NextResponse } from 'next/server';
import { handleOAuthCallback } from '@/lib/google-calendar';
import { constantTimeTokenEqual } from '@/lib/api-security';

// GET: Google redirects here with ?code=... after user grants access
export async function GET(req: NextRequest) {
  const code = req.nextUrl.searchParams.get('code');
  const state = req.nextUrl.searchParams.get('state');
  const expectedState = req.cookies.get('lifeos_google_oauth_state')?.value;
  if (!constantTimeTokenEqual(state, expectedState)) {
    return NextResponse.json({ error: 'Invalid OAuth state' }, { status: 400 });
  }
  if (!code) {
    return NextResponse.json({ error: 'Missing code' }, { status: 400 });
  }

  try {
    await handleOAuthCallback(code);
    // Redirect to settings page with success indicator
    const response = NextResponse.redirect(new URL('/settings?gcal=connected', req.url));
    response.cookies.delete('lifeos_google_oauth_state');
    return response;
  } catch (err) {
    console.error('[GCal OAuth] callback failed:', err);
    const response = NextResponse.redirect(new URL('/settings?gcal=error', req.url));
    response.cookies.delete('lifeos_google_oauth_state');
    return response;
  }
}
