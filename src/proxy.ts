import { NextResponse } from 'next/server';
import type { NextRequest } from 'next/server';
import {
    authorizeApiRequest,
    constantTimeTokenEqual,
    isAllowedApiOrigin,
    LIFEOS_SESSION_COOKIE,
} from '@/lib/api-security';

const PUBLIC_API_PATHS = new Set([
    '/api/auth/session',
    '/api/calendar/google/callback',
]);
const ALLOW_METHODS = 'GET, POST, PUT, PATCH, DELETE, OPTIONS';
const ALLOW_HEADERS = 'Content-Type, Authorization, X-LifeOS-Device-Token, X-LifeOS-Reauth-Token, X-Idempotency-Key';

function corsHeaders(request: NextRequest) {
    const requestOrigin = request.headers.get('origin');
    const headers = new Headers({
        'Access-Control-Allow-Methods': ALLOW_METHODS,
        'Access-Control-Allow-Headers': ALLOW_HEADERS,
        'Access-Control-Max-Age': '600',
        'Vary': 'Origin',
    });

    if (requestOrigin && isAllowedApiOrigin(requestOrigin, request.nextUrl.origin)) {
        headers.set('Access-Control-Allow-Origin', requestOrigin);
        headers.set('Access-Control-Allow-Credentials', 'true');
    }
    return headers;
}

export default function proxy(request: NextRequest) {
    const pathname = request.nextUrl.pathname;
    const requestOrigin = request.headers.get('origin');
    const headers = corsHeaders(request);

    if (requestOrigin && !isAllowedApiOrigin(requestOrigin, request.nextUrl.origin)) {
        return NextResponse.json(
            { error: 'origin_not_allowed' },
            { status: 403, headers },
        );
    }

    if (request.method === 'OPTIONS') {
        return new NextResponse(null, { status: 204, headers });
    }

    if (PUBLIC_API_PATHS.has(pathname)) {
        const response = NextResponse.next();
        for (const [key, value] of headers) response.headers.set(key, value);
        return response;
    }

    const authorization = authorizeApiRequest({
        method: request.method,
        pathname,
        origin: request.nextUrl.origin,
        requestOrigin,
        authorization: request.headers.get('authorization'),
        deviceToken: request.headers.get('x-lifeos-device-token'),
        cookieToken: request.cookies.get(LIFEOS_SESSION_COOKIE)?.value || null,
    });

    if (!authorization.allowed) {
        return NextResponse.json(
            { error: authorization.reason },
            { status: authorization.status, headers },
        );
    }

    if (
        pathname.startsWith('/api/admin/')
        && ['POST', 'PUT', 'PATCH', 'DELETE'].includes(request.method)
        && authorization.kind !== 'development'
        && !constantTimeTokenEqual(
            request.headers.get('x-lifeos-reauth-token'),
            process.env.LIFEOS_API_TOKEN,
        )
    ) {
        return NextResponse.json(
            { error: 'reauthentication_required' },
            { status: 403, headers },
        );
    }

    const forwardedHeaders = new Headers(request.headers);
    forwardedHeaders.set('x-lifeos-auth-kind', authorization.kind || 'unknown');
    forwardedHeaders.delete('x-lifeos-device-token');

    const response = NextResponse.next({
        request: { headers: forwardedHeaders },
    });
    for (const [key, value] of headers) response.headers.set(key, value);
    response.headers.set('Cache-Control', 'no-store');
    return response;
}

export const config = {
    matcher: '/api/:path*',
};
