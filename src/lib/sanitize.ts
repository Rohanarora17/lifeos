// ─── Input Sanitization & XSS Protection ─────────────────────────────
// Strips HTML tags and dangerous characters from user input strings.
// Used by all POST routes that store user-provided text.

/**
 * Strip HTML tags to prevent stored XSS.
 * Does NOT remove the text content — just the markup.
 */
export function stripHtml(input: string): string {
    if (!input || typeof input !== 'string') return input;
    return input
        .replace(/<[^>]*>/g, '')         // Remove HTML tags
        .replace(/&lt;/g, '<')           // Decode common entities back
        .replace(/&gt;/g, '>')
        .replace(/&amp;/g, '&')
        .trim();
}

/**
 * Sanitize a URL — allow valid URLs but neutralize javascript: protocol.
 */
export function sanitizeUrl(url: string): string {
    if (!url || typeof url !== 'string') return url;
    const trimmed = url.trim();
    // Block javascript: and data: protocols
    if (/^(javascript|data|vbscript):/i.test(trimmed)) {
        return 'about:blank';
    }
    return trimmed;
}

/**
 * Truncate string to max length (prevents DB column overflow).
 */
export function truncate(input: string, maxLength: number = 1000): string {
    if (!input || typeof input !== 'string') return input;
    return input.length > maxLength ? input.slice(0, maxLength) : input;
}

/**
 * Full sanitization pipeline for user-provided text fields.
 */
export function sanitizeText(input: string, maxLength: number = 1000): string {
    if (!input || typeof input !== 'string') return '';
    return truncate(stripHtml(input), maxLength);
}
