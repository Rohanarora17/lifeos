import Foundation

struct CopilotCallout: Codable {
    let x: Double
    let y: Double
    let width: Double?
    let height: Double?
    let label: String
    let confidence: Double
}

struct CopilotContextUsed: Codable {
    let hadScreenshot: Bool
    let hadSelectedText: Bool
    let hadScreenHistory: Bool
    let hadContextNarrative: Bool
    let hadCursorPoint: Bool?
    let usedUilContext: Bool?
}

struct CopilotTurnResponse: Codable {
    let ok: Bool
    let transcript: String?
    let mode: String
    let answer: String?
    let spokenAnswer: String?
    let callouts: [CopilotCallout]
    let contextUsed: CopilotContextUsed
    let outcomeId: Int?
    let error: String?
}

struct NativePresenceCheck: Codable {
    let checkId: String
    let sessionId: String
    let targetTitle: String
    let secondsRemaining: Int
    let app: String?
    let windowTitle: String?
}

struct NativeHeartbeatResponse: Codable {
    let ok: Bool
    let active: Bool
    let sessionId: String?
    let presenceCheck: NativePresenceCheck?
}

struct VisionStateResponse: Codable {
    let active: Bool
    let sessionId: String?
    let nextIntervalMs: Int
    let captureMode: String?
}

struct NativeIngestResponse: Codable {
    let ok: Bool
    let stored: String?
    let category: String?
    let needsUserAsk: Bool?
    let asked: Bool?
    let error: String?
}

struct ClassificationAskPending: Codable {
    let app: String
    let sessionId: String
    let sessionTargetTitle: String
    let preferenceDomain: String?
    let activityCount: Int?
    let askedAt: Double?
    let expiresAt: Double?
}

struct ClassificationAskResponse: Codable {
    let ok: Bool
    let pending: ClassificationAskPending?
    let error: String?
}

struct ClassificationResolveResponse: Codable {
    let ok: Bool
    let app: String?
    let category: String?
    let updated: Int?
    let message: String?
    let error: String?
}
