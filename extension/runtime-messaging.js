(function exposeLifeOSRuntimeMessaging(root, factory) {
    const api = factory();
    if (typeof module === 'object' && module.exports) module.exports = api;
    if (root) root.LifeOSRuntimeMessaging = api;
})(typeof globalThis !== 'undefined' ? globalThis : this, function createRuntimeMessaging() {
    'use strict';

    function failureCode(error) {
        const message = error instanceof Error ? error.message : String(error || '');
        return /extension context invalidated|context invalidated/i.test(message)
            ? 'extension_context_invalidated'
            : 'runtime_message_failed';
    }

    async function sendRuntimeMessage(chromeApi, message) {
        let runtime;
        try {
            runtime = chromeApi && chromeApi.runtime;
            if (!runtime || !runtime.id || typeof runtime.sendMessage !== 'function') {
                return { delivered: false, error: 'extension_context_invalidated', response: null };
            }
            const response = await runtime.sendMessage(message);
            return { delivered: true, error: null, response: response ?? null };
        } catch (error) {
            return { delivered: false, error: failureCode(error), response: null };
        }
    }

    return { sendRuntimeMessage };
});
