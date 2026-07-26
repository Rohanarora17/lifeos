import { NextRequest, NextResponse } from 'next/server';
import {
    constantTimeTokenEqual,
    isApiAuthenticationRequired,
    LIFEOS_SESSION_COOKIE,
} from '@/lib/api-security';
import { consumeRateLimit } from '@/lib/rate-limit';

export const dynamic = 'force-dynamic';

const COOKIE_MAX_AGE_SECONDS = 12 * 60 * 60;
const MAX_LOGIN_BODY_BYTES = 4 * 1024;

function noStoreJson(body: Record<string, unknown>, status = 200) {
    return NextResponse.json(body, {
        status,
        headers: { 'Cache-Control': 'no-store' },
    });
}

function requestKey(request: NextRequest) {
    const forwarded = request.headers.get('x-forwarded-for')?.split(',')[0]?.trim();
    return forwarded || request.headers.get('x-real-ip') || 'unknown';
}

function clearSessionCookie(response: NextResponse) {
    response.cookies.set({
        name: LIFEOS_SESSION_COOKIE,
        value: '',
        httpOnly: true,
        sameSite: 'strict',
        secure: process.env.NODE_ENV === 'production' && process.env.LIFEOS_COOKIE_SECURE !== 'false',
        path: '/',
        maxAge: 0,
    });
}

export async function GET(request: NextRequest) {
    if (!isApiAuthenticationRequired()) {
        return noStoreJson({ authenticated: true, mode: 'development' });
    }

    const expected = process.env.LIFEOS_API_TOKEN?.trim();
    if (!expected) {
        return noStoreJson({ authenticated: false, error: 'security_not_configured' }, 503);
    }

    const authenticated = constantTimeTokenEqual(
        request.cookies.get(LIFEOS_SESSION_COOKIE)?.value,
        expected,
    );
    return noStoreJson({ authenticated });
}

export async function POST(request: NextRequest) {
    const rate = consumeRateLimit(`login:${requestKey(request)}`, {
        limit: 5,
        windowMs: 15 * 60 * 1_000,
    });
    if (!rate.allowed) {
        return NextResponse.json(
            { authenticated: false, error: 'rate_limited' },
            {
                status: 429,
                headers: {
                    'Cache-Control': 'no-store',
                    'Retry-After': String(rate.retryAfterSeconds),
                },
            },
        );
    }

    const expected = process.env.LIFEOS_API_TOKEN?.trim();
    if (!expected) {
        if (!isApiAuthenticationRequired()) {
            return noStoreJson({ authenticated: true, mode: 'development' });
        }
        return noStoreJson({ authenticated: false, error: 'security_not_configured' }, 503);
    }

    const contentLength = Number(request.headers.get('content-length') || 0);
    if (contentLength > MAX_LOGIN_BODY_BYTES) {
        return noStoreJson({ authenticated: false, error: 'payload_too_large' }, 413);
    }

    let suppliedToken = '';
    try {
        const body = await request.json();
        suppliedToken = typeof body?.token === 'string' ? body.token : '';
    } catch {
        return noStoreJson({ authenticated: false, error: 'invalid_json' }, 400);
    }

    if (!constantTimeTokenEqual(suppliedToken, expected)) {
        return noStoreJson({ authenticated: false, error: 'invalid_credentials' }, 401);
    }

    const response = noStoreJson({ authenticated: true });
    response.cookies.set({
        name: LIFEOS_SESSION_COOKIE,
        value: expected,
        httpOnly: true,
        sameSite: 'strict',
        secure: process.env.NODE_ENV === 'production' && process.env.LIFEOS_COOKIE_SECURE !== 'false',
        path: '/',
        maxAge: COOKIE_MAX_AGE_SECONDS,
    });
    return response;
}

export async function DELETE() {
    const response = noStoreJson({ authenticated: false });
    clearSessionCookie(response);
    return response;
}
