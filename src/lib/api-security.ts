export const LIFEOS_SESSION_COOKIE = 'lifeos_session';

export type ApiAuthKind = 'cookie' | 'bearer' | 'device' | 'development';

export interface ApiSecurityEnvironment {
    NODE_ENV?: string;
    LIFEOS_AUTH_MODE?: string;
    LIFEOS_API_TOKEN?: string;
    LIFEOS_DEVICE_TOKEN?: string;
    LIFEOS_ALLOWED_ORIGINS?: string;
    LIFEOS_EXTENSION_ID?: string;
}

export interface ApiSecurityRequest {
    method: string;
    pathname: string;
    origin: string;
    requestOrigin: string | null;
    authorization: string | null;
    deviceToken: string | null;
    cookieToken: string | null;
}

export interface ApiAuthorization {
    allowed: boolean;
    status: 200 | 401 | 403 | 503;
    kind?: ApiAuthKind;
    reason?: 'authentication_required' | 'csrf_rejected' | 'security_not_configured';
}

const DEVICE_PATHS = [
    '/api/daemon/ingest',
    '/api/native/ingest',
    '/api/guardian/vision',
    '/api/guardian/events',
    '/api/guardian/state',
    '/api/extension/tasks',
    '/api/voice/livekit/config',
    '/api/voice/livekit/token',
    '/api/voice/push-to-talk',
    '/api/voice/transcribe',
    '/api/voice/tts',
    '/api/telemetry/events',
];

const MUTATING_METHODS = new Set(['POST', 'PUT', 'PATCH', 'DELETE']);

export function constantTimeTokenEqual(actual: string | null | undefined, expected: string | null | undefined) {
    if (!actual || !expected) return false;

    const maxLength = Math.max(actual.length, expected.length);
    let difference = actual.length ^ expected.length;
    for (let index = 0; index < maxLength; index += 1) {
        difference |= (actual.charCodeAt(index) || 0) ^ (expected.charCodeAt(index) || 0);
    }
    return difference === 0;
}

export function isApiAuthenticationRequired(env: ApiSecurityEnvironment = process.env) {
    if (env.LIFEOS_AUTH_MODE === 'required') return true;
    if (env.LIFEOS_AUTH_MODE === 'disabled' && env.NODE_ENV !== 'production') return false;
    return env.NODE_ENV === 'production';
}

export function configuredAllowedOrigins(
    applicationOrigin: string,
    env: ApiSecurityEnvironment = process.env,
) {
    const origins = new Set<string>([applicationOrigin]);

    for (const origin of (env.LIFEOS_ALLOWED_ORIGINS || '').split(',')) {
        const normalized = origin.trim().replace(/\/$/, '');
        if (normalized) origins.add(normalized);
    }

    const extensionId = env.LIFEOS_EXTENSION_ID?.trim();
    if (extensionId) origins.add(`chrome-extension://${extensionId}`);

    return origins;
}

export function isAllowedApiOrigin(
    requestOrigin: string | null,
    applicationOrigin: string,
    env: ApiSecurityEnvironment = process.env,
) {
    if (!requestOrigin) return true;
    return configuredAllowedOrigins(applicationOrigin, env).has(requestOrigin.replace(/\/$/, ''));
}

export function readBearerToken(authorization: string | null) {
    if (!authorization) return null;
    const match = /^Bearer[ \t]+(.+)$/i.exec(authorization);
    return match?.[1]?.trim() || null;
}

export function isDevicePath(pathname: string) {
    return DEVICE_PATHS.some(path => pathname === path || pathname.startsWith(`${path}/`));
}

export function authorizeApiRequest(
    request: ApiSecurityRequest,
    env: ApiSecurityEnvironment = process.env,
): ApiAuthorization {
    if (!isApiAuthenticationRequired(env)) {
        return { allowed: true, status: 200, kind: 'development' };
    }

    const apiToken = env.LIFEOS_API_TOKEN?.trim();
    if (!apiToken) {
        return { allowed: false, status: 503, reason: 'security_not_configured' };
    }

    const bearer = readBearerToken(request.authorization);
    if (constantTimeTokenEqual(bearer, apiToken)) {
        return { allowed: true, status: 200, kind: 'bearer' };
    }

    const suppliedDeviceToken = request.deviceToken || bearer;
    if (
        isDevicePath(request.pathname)
        && constantTimeTokenEqual(suppliedDeviceToken, env.LIFEOS_DEVICE_TOKEN?.trim())
    ) {
        return { allowed: true, status: 200, kind: 'device' };
    }

    if (constantTimeTokenEqual(request.cookieToken, apiToken)) {
        if (
            MUTATING_METHODS.has(request.method.toUpperCase())
            && (
                !request.requestOrigin
                || !isAllowedApiOrigin(request.requestOrigin, request.origin, env)
            )
        ) {
            return { allowed: false, status: 403, reason: 'csrf_rejected' };
        }
        return { allowed: true, status: 200, kind: 'cookie' };
    }

    return { allowed: false, status: 401, reason: 'authentication_required' };
}
