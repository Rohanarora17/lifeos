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

struct NativeHeartbeatResponse: Codable {
    let ok: Bool
    let active: Bool
    let sessionId: String?
}

struct NativeIngestResponse: Codable {
    let ok: Bool
    let stored: String?
    let category: String?
    let error: String?
}
