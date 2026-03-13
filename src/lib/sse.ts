export interface SSEClient {
    id: string;
    controller: ReadableStreamDefaultController;
}

// Global state to store connected SSE clients across API calls in Next.js dev
const globalForSSE = globalThis as unknown as {
    sseClients: SSEClient[];
};

if (!globalForSSE.sseClients) {
    globalForSSE.sseClients = [];
}

export const sseClients = globalForSSE.sseClients;

export function addClient(client: SSEClient) {
    sseClients.push(client);
    console.log('[SSE] Client connected. Total: ' + sseClients.length);
}

export function removeClient(id: string) {
    const index = sseClients.findIndex(c => c.id === id);
    if (index !== -1) {
        sseClients.splice(index, 1);
        console.log('[SSE] Client disconnected. Total: ' + sseClients.length);
    }
}

export function broadcastEvent(event: string, data: any) {
    if (sseClients.length === 0) return;

    const payload = 'event: ' + event + '\\ndata: ' + JSON.stringify(data) + '\\n\\n';
    const encoder = new TextEncoder();
    const encodedPayload = encoder.encode(payload);

    // Keep track of dead connections
    const deadClients: string[] = [];

    sseClients.forEach(client => {
        try {
            client.controller.enqueue(encodedPayload);
        } catch (error) {
            deadClients.push(client.id);
        }
    });

    deadClients.forEach(id => removeClient(id));
}
