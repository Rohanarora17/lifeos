import { NextRequest, NextResponse } from 'next/server';
import { handleOAuthCallback } from '@/lib/google-calendar';
import { constantTimeTokenEqual } from '@/lib/api-security';

// GET: Google redirects here with ?code=... after user grants access
export async function GET(req: NextRequest) {
  const origin = req.nextUrl.origin;
  const errorParam = req.nextUrl.searchParams.get('error');
  const code = req.nextUrl.searchParams.get('code');
  const state = req.nextUrl.searchParams.get('state');
  const expectedState = req.cookies.get('lifeos_google_oauth_state')?.value;
  const savedRedirectUri = req.cookies.get('lifeos_google_oauth_redirect_uri')?.value;
  const redirectUri = savedRedirectUri || process.env.GOOGLE_REDIRECT_URI || `${origin}/api/calendar/google/callback`;

  if (errorParam) {
    const response = NextResponse.redirect(new URL(`/planner?gcal=denied&reason=${encodeURIComponent(errorParam)}`, origin));
    response.cookies.delete('lifeos_google_oauth_state');
    response.cookies.delete('lifeos_google_oauth_redirect_uri');
    return response;
  }

  if (!constantTimeTokenEqual(state, expectedState)) {
    return NextResponse.json({ error: 'Invalid OAuth state' }, { status: 400 });
  }
  if (!code) {
    return NextResponse.json({ error: 'Missing code' }, { status: 400 });
  }

  try {
    await handleOAuthCallback(code, redirectUri);
    // Redirect to planner page with success indicator
    const response = NextResponse.redirect(new URL('/planner?gcal=connected', origin));
    response.cookies.delete('lifeos_google_oauth_state');
    response.cookies.delete('lifeos_google_oauth_redirect_uri');
    return response;
  } catch (err) {
    console.error('[GCal OAuth] callback failed:', err);
    const response = NextResponse.redirect(new URL('/planner?gcal=error', origin));
    response.cookies.delete('lifeos_google_oauth_state');
    response.cookies.delete('lifeos_google_oauth_redirect_uri');
    return response;
  }
}
