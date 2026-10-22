import Foundation
import StudyChatCore

final class StudyChatCoreTests {
    private func fixture(revision: Int = 7, date: String = "2026-10-22", prompt: String = "return-1", kind: String = "return") throws -> StudyChatState {
        let json = """
        {"ok":true,"date":"\(date)","revision":\(revision),"enabled":true,
        "messages":[{"id":42,"role":"assistant","text":"When will you return?","createdAt":"2026-10-22T07:00:00Z"}],
        "activity":{"id":"meal-1","kind":"meal","title":"Lunch","startedAt":"2026-10-22T07:00:00Z","expectedReturnAt":null,"status":"pending","revision":7,"calendarEventId":null},
        "pendingPrompt":{"id":"\(prompt)","text":"Ready to return?","kind":"\(kind)","createdAt":"2026-10-22T07:40:00Z"},
        "pendingQuestion":"When will you return?","plan":{"date":"2026-10-22","revision":7,"sessions":[],"remainingSeconds":28800,"scheduledMinutes":0,"shortfallMinutes":480,"anticipatedClassMinutes":0,"calendarStatus":"stale","needsInput":"End time?","warning":null,"endAt":null},
        "remainingSeconds":28800,"measuredSeconds":0,"selfReportedSeconds":0,"classSeconds":0,"futureField":{"safe":true}}
        """
        return try JSONDecoder().decode(StudyChatState.self, from: Data(json.utf8))
    }

    func testWireDecodesNullAgreementAndAdditionalFields() throws {
        let state = try fixture()
        XCTAssertEqual(state.messages.first?.text, "When will you return?")
        XCTAssertNil(state.activity?.expectedReturnAt)
        XCTAssertEqual(state.plan?.calendarStatus, "stale")
        XCTAssertEqual(state.pendingPrompt?.id, "return-1")
    }

    func testDraftAndPendingRequestSurviveRestartAndPolling() throws {
        var model = StudyChatLocalState()
        model.receive(try fixture())
        model.draft = "Back in forty minutes"
        let first = try XCTUnwrap(model.prepareSend(requestID: "durable-id"))
        model.draft = "A newer draft"
        model.receive(try fixture(revision: 8))
        let restored = try JSONDecoder().decode(StudyChatLocalState.self, from: JSONEncoder().encode(model))
        XCTAssertEqual(restored.draft, "A newer draft")
        XCTAssertEqual(restored.pendingRequest, first)
        XCTAssertEqual(restored.pendingRequest?.revision, 7)
        XCTAssertEqual(restored.pendingRequest?.requestId, "durable-id")
    }

    func testRetryUsesOriginalRequestEvenAfterRevisionRefresh() throws {
        var model = StudyChatLocalState()
        model.receive(try fixture())
        model.draft = "Another twenty minutes"
        let first = model.prepareSend(requestID: "one")
        model.receive(try fixture(revision: 10))
        XCTAssertEqual(model.prepareSend(requestID: "must-not-use"), first)
        XCTAssertEqual(model.pendingRequest?.message, "Another twenty minutes")
    }

    func testConflictRetainsDraftAndNeedsExplicitNewSubmission() throws {
        var model = StudyChatLocalState()
        model.receive(try fixture())
        model.draft = "Another twenty"
        _ = model.prepareSend(requestID: "old")
        model.conflict(state: try fixture(revision: 9))
        XCTAssertNil(model.pendingRequest)
        XCTAssertTrue(model.requiresExplicitResend)
        XCTAssertEqual(model.draft, "Another twenty")
        XCTAssertEqual(model.state?.revision, 9)
        let resend = try XCTUnwrap(model.prepareSend(requestID: "new-user-submit"))
        XCTAssertEqual(resend.revision, 9)
        XCTAssertEqual(resend.requestId, "new-user-submit")
    }

    func testDelayedResponseCannotRollbackCurrentRevisionOrClearNewDraft() throws {
        var model = StudyChatLocalState()
        model.receive(try fixture(revision: 10))
        model.draft = "I am back"
        _ = model.prepareSend(requestID: "one")
        model.draft = "Start ADSA"
        model.sentSuccessfully(try fixture(revision: 9))
        XCTAssertEqual(model.state?.revision, 10)
        XCTAssertEqual(model.draft, "Start ADSA")
        XCTAssertNil(model.pendingRequest)
        model.receive(try fixture(revision: 0, date: "2026-10-23"))
        model.receive(try fixture(revision: 99, date: "2026-10-22"))
        XCTAssertEqual(model.state?.date, "2026-10-23")
    }

    func testPresenceQueuesPromptUntilActuallyDisplayedAndDoesNotRepeat() throws {
        var model = StudyChatLocalState()
        model.receive(try fixture())
        XCTAssertNil(model.promptToDisplay(presenceVisible: true))
        XCTAssertEqual(model.promptToDisplay(presenceVisible: false)?.id, "return-1")
        XCTAssertEqual(model.promptToDisplay(presenceVisible: false)?.id, "return-1", "Selection alone must not acknowledge")
        model.didDisplayPrompt("return-1")
        XCTAssertNil(model.promptToDisplay(presenceVisible: false))
        model.receive(try fixture(prompt: "overdue-2"))
        XCTAssertEqual(model.promptToDisplay(presenceVisible: false)?.id, "overdue-2")
        let restored = try JSONDecoder().decode(StudyChatLocalState.self, from: JSONEncoder().encode(model))
        XCTAssertEqual(restored.unacknowledgedPromptIDs, ["return-1"])
    }

    func testRetryFreezesDayUntilRolloverConflictIsExplicitlyResent() throws {
        var model = StudyChatLocalState()
        model.receive(try fixture())
        model.draft = "Another twenty minutes"
        let old = try XCTUnwrap(model.prepareSend(requestID: "before-midnight"))
        model.receive(try fixture(revision: 0, date: "2026-10-23"))
        let retry = try XCTUnwrap(model.prepareSend(requestID: "must-not-carry-over"))
        let wire = try JSONSerialization.jsonObject(with: JSONEncoder().encode(retry)) as! [String: Any]
        XCTAssertEqual(wire["date"] as? String, "2026-10-22")
        XCTAssertEqual(retry, old)
        model.conflict(state: try fixture(revision: 0, date: "2026-10-23"))
        let explicit = try XCTUnwrap(model.prepareSend(requestID: "explicit-next-day"))
        let newWire = try JSONSerialization.jsonObject(with: JSONEncoder().encode(explicit)) as! [String: Any]
        XCTAssertEqual(newWire["date"] as? String, "2026-10-23")
        XCTAssertEqual(explicit.revision, 0)
    }

    func testInitialCampaignSetupAllowsInputAndDisplaysAttentionOnce() throws {
        let json = """
        {"ok":true,"date":"2026-10-22","revision":0,"enabled":true,"messages":[],"activity":null,"pendingPrompt":{"id":"setup-2026-10-22","text":"When did you wake, and when should your day end?","kind":"clarification","createdAt":"2026-10-22T01:00:00Z"},"pendingQuestion":null,"plan":null,"remainingSeconds":28800,"measuredSeconds":0,"selfReportedSeconds":0,"classSeconds":0}
        """
        let initial = try JSONDecoder().decode(StudyChatState.self, from: Data(json.utf8))
        var model = StudyChatLocalState()
        model.receive(initial)
        XCTAssertTrue(model.state?.messages.isEmpty == true)
        model.draft = "I wake at 08:00 and sleep at 23:00"
        let request = try XCTUnwrap(model.prepareSend(requestID: "first-setup"))
        XCTAssertEqual(request.revision, 0)
        XCTAssertEqual(request.date, "2026-10-22")
        XCTAssertNil(model.promptToDisplay(presenceVisible: true))
        XCTAssertEqual(model.promptToDisplay(presenceVisible: false)?.id, "setup-2026-10-22")
        XCTAssertEqual(model.unacknowledgedPromptIDs, [])
        model.didDisplayPrompt("setup-2026-10-22")
        model.receive(initial)
        XCTAssertNil(model.promptToDisplay(presenceVisible: false))
        XCTAssertEqual(model.unacknowledgedPromptIDs, ["setup-2026-10-22"])
    }

    func testUnknownReturnClarificationQueuesAndAcknowledgesOnlyDisplay() throws {
        var model = StudyChatLocalState()
        let followup = try fixture(prompt: "missing-return-10min", kind: "clarification")
        model.receive(followup)
        XCTAssertNil(model.promptToDisplay(presenceVisible: true))
        XCTAssertEqual(model.unacknowledgedPromptIDs, [])
        XCTAssertEqual(model.promptToDisplay(presenceVisible: false)?.id, "missing-return-10min")
        XCTAssertEqual(model.promptToDisplay(presenceVisible: false)?.id, "missing-return-10min")
        XCTAssertEqual(model.unacknowledgedPromptIDs, [])
        model.didDisplayPrompt("missing-return-10min")
        let restored = try JSONDecoder().decode(StudyChatLocalState.self, from: JSONEncoder().encode(model))
        XCTAssertEqual(restored.unacknowledgedPromptIDs, ["missing-return-10min"])
        model.didAcknowledgePrompt("missing-return-10min")
        XCTAssertEqual(model.unacknowledgedPromptIDs, [])
        XCTAssertEqual(model.state?.activity?.status, "pending")
        XCTAssertNil(model.state?.activity?.expectedReturnAt)
        model.receive(followup)
        XCTAssertNil(model.promptToDisplay(presenceVisible: false))
    }

    func testOrdinaryPendingQuestionDoesNotIndependentlyOpenAttentionPanel() throws {
        let json = """
        {"ok":true,"date":"2026-10-22","revision":1,"enabled":true,"messages":[{"id":1,"role":"assistant","text":"When will you return?","createdAt":"2026-10-22T07:00:00Z"}],"activity":null,"pendingPrompt":null,"pendingQuestion":"When will you return?","plan":null,"remainingSeconds":28800,"measuredSeconds":0,"selfReportedSeconds":0,"classSeconds":0}
        """
        var model = StudyChatLocalState()
        model.receive(try JSONDecoder().decode(StudyChatState.self, from: Data(json.utf8)))
        XCTAssertEqual(model.state?.pendingQuestion, "When will you return?")
        XCTAssertNil(model.promptToDisplay(presenceVisible: false))
        model.draft = "   \n"
        XCTAssertNil(model.prepareSend(requestID: "blank"))
    }

    func testAcceptedNewDayExpiryBlocksNonblankDraftAndReturnPrompt() throws {
        var model = StudyChatLocalState()
        model.receive(try fixture())
        model.draft = "Start Probability"
        let json = """
        {"ok":true,"date":"2026-11-14","revision":0,"enabled":false,"messages":[],"activity":null,"pendingPrompt":{"id":"expired-return","text":"Return","kind":"return","createdAt":"2026-11-14T01:00:00Z"},"pendingQuestion":null,"plan":null,"remainingSeconds":0,"measuredSeconds":0,"selfReportedSeconds":0,"classSeconds":0}
        """
        model.receive(try JSONDecoder().decode(StudyChatState.self, from: Data(json.utf8)))
        XCTAssertEqual(model.state?.date, "2026-11-14")
        XCTAssertEqual(model.state?.revision, 0)
        XCTAssertEqual(model.state?.enabled, false)
        XCTAssertEqual(model.state?.pendingPrompt?.id, "expired-return")
        XCTAssertEqual(model.draft, "Start Probability")
        XCTAssertNil(model.promptToDisplay(presenceVisible: false))
        XCTAssertNil(model.prepareSend(requestID: "expired-send"))
    }

}

// CommandLineTools ships no XCTest module; run this dependency-free executable with swift run.
func XCTAssertEqual<T: Equatable>(_ lhs: T, _ rhs: T, _ note: String = "") {
    precondition(lhs == rhs, "Expected \(rhs), got \(lhs). \(note)")
}
func XCTAssertNil<T>(_ value: T?) { precondition(value == nil, "Expected nil") }
func XCTAssertTrue(_ value: Bool) { precondition(value, "Expected true") }
func XCTUnwrap<T>(_ value: T?) throws -> T {
    guard let value else { throw TestFailure.missingValue }
    return value
}
enum TestFailure: Error { case missingValue }
