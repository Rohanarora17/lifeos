import Foundation

// Wire fields follow src/lib/study-chat-contract.ts. Unknown fields remain forward compatible.
public struct StudyChatMessage: Codable, Equatable, Sendable {
    public let id: Int
    public let role: String
    public let text: String
    public let createdAt: String
}
public struct StudyChatPrompt: Codable, Equatable, Sendable {
    public let id: String
    public let text: String
    public let kind: String
    public let createdAt: String
}
public struct StudyChatActivity: Codable, Sendable {
    public let id: String
    public let kind: String
    public let title: String
    public let startedAt: String
    public let expectedReturnAt: String?
    public let status: String
    public let revision: Int
    public let calendarEventId: String?
}
public struct StudyDaySession: Codable, Sendable {
    public let id: String
    public let title: String
    public let subject: String
    public let start: String
    public let end: String
    public let durationMinutes: Double
    public let status: String
}
public struct StudyChatPlan: Codable, Sendable {
    public let date: String
    public let revision: Int
    public let sessions: [StudyDaySession]
    public let remainingSeconds: Double
    public let scheduledMinutes: Double
    public let shortfallMinutes: Double
    public let anticipatedClassMinutes: Double
    public let calendarStatus: String
    public let needsInput: String?
    public let warning: String?
    public let endAt: String?
}
public struct StudyChatState: Codable, Sendable {
    public let ok: Bool
    public let date: String
    public let revision: Int
    public let enabled: Bool
    public let messages: [StudyChatMessage]
    public let activity: StudyChatActivity?
    public let pendingPrompt: StudyChatPrompt?
    public let pendingQuestion: String?
    public let plan: StudyChatPlan?
    public let remainingSeconds: Double
    public let measuredSeconds: Double
    public let selfReportedSeconds: Double
    public let classSeconds: Double
    public let reply: String?
}
public struct StudyChatRequest: Codable, Equatable, Sendable {
    public let action: String
    public let message: String
    public let requestId: String
    public let revision: Int
    public let date: String
}

/// Durable local transport state; the server alone owns agreements and earned time.
public struct StudyChatLocalState: Codable, Sendable {
    public var draft = ""
    public private(set) var state: StudyChatState?
    public private(set) var pendingRequest: StudyChatRequest?
    public private(set) var requiresExplicitResend = false
    private var displayedPromptIDs: [String] = []
    public private(set) var unacknowledgedPromptIDs: [String] = []

    public init() {}
    public mutating func receive(_ newState: StudyChatState) {
        guard newState.ok else { return }
        if let current = state {
            guard newState.date > current.date ||
                    (newState.date == current.date && newState.revision >= current.revision) else { return }
        }
        state = newState
    }
    public mutating func prepareSend(requestID: String) -> StudyChatRequest? {
        if let pendingRequest { return pendingRequest }
        guard let state, state.enabled, !draft.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty else { return nil }
        let request = StudyChatRequest(action: "message", message: draft, requestId: requestID, revision: state.revision, date: state.date)
        pendingRequest = request
        requiresExplicitResend = false
        return request
    }
    public mutating func conflict(state: StudyChatState?) {
        if let state { receive(state) }
        pendingRequest = nil
        requiresExplicitResend = true
    }
    public mutating func sentSuccessfully(_ state: StudyChatState) {
        if draft == pendingRequest?.message { draft = "" }
        pendingRequest = nil
        requiresExplicitResend = false
        receive(state)
    }
    public func promptToDisplay(presenceVisible: Bool) -> StudyChatPrompt? {
        guard !presenceVisible, state?.enabled == true, let prompt = state?.pendingPrompt,
              !displayedPromptIDs.contains(prompt.id) else { return nil }
        return prompt
    }
    public mutating func didDisplayPrompt(_ id: String) {
        guard !displayedPromptIDs.contains(id) else { return }
        displayedPromptIDs.append(id)
        displayedPromptIDs = Array(displayedPromptIDs.suffix(256))
        unacknowledgedPromptIDs.append(id)
    }
    public mutating func didAcknowledgePrompt(_ id: String) {
        unacknowledgedPromptIDs.removeAll { $0 == id }
    }
}
