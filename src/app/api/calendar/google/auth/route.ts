import { NextRequest, NextResponse } from 'next/server';
import { getAuthUrl } from '@/lib/google-calendar';

// GET: Redirect user to Google OAuth consent screen
export async function GET(req: NextRequest) {
  const state = crypto.randomUUID();
  const url = getAuthUrl(state);
  const response = NextResponse.redirect(url);
  response.cookies.set({
    name: 'lifeos_google_oauth_state',
    value: state,
    httpOnly: true,
    sameSite: 'lax',
    secure: req.nextUrl.protocol === 'https:',
    path: '/api/calendar/google/callback',
    maxAge: 10 * 60,
  });
  return response;
}
