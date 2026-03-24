import { NextResponse } from 'next/server';
import { getAuthUrl } from '@/lib/google-calendar';

// GET: Redirect user to Google OAuth consent screen
export async function GET() {
  const url = getAuthUrl();
  return NextResponse.redirect(url);
}
