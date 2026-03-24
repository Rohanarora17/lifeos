import { NextRequest, NextResponse } from 'next/server';
import { handleOAuthCallback } from '@/lib/google-calendar';

// GET: Google redirects here with ?code=... after user grants access
export async function GET(req: NextRequest) {
  const code = req.nextUrl.searchParams.get('code');
  if (!code) {
    return NextResponse.json({ error: 'Missing code' }, { status: 400 });
  }

  try {
    await handleOAuthCallback(code);
    // Redirect to settings page with success indicator
    return NextResponse.redirect(new URL('/settings?gcal=connected', req.url));
  } catch (err) {
    console.error('[GCal OAuth] callback failed:', err);
    return NextResponse.redirect(new URL('/settings?gcal=error', req.url));
  }
}
