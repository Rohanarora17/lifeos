import Foundation
let suite = StudyChatCoreTests()
let cases: [(String, () throws -> Void)] = [
    ("wire decoding", suite.testWireDecodesNullAgreementAndAdditionalFields),
    ("draft persistence", suite.testDraftAndPendingRequestSurviveRestartAndPolling),
    ("idempotent retry", suite.testRetryUsesOriginalRequestEvenAfterRevisionRefresh),
    ("409 explicit resend", suite.testConflictRetainsDraftAndNeedsExplicitNewSubmission),
    ("stale response ordering", suite.testDelayedResponseCannotRollbackCurrentRevisionOrClearNewDraft),
    ("presence arbitration", suite.testPresenceQueuesPromptUntilActuallyDisplayedAndDoesNotRepeat),
    ("midnight retry date", suite.testRetryFreezesDayUntilRolloverConflictIsExplicitlyResent),
    ("initial campaign setup", suite.testInitialCampaignSetupAllowsInputAndDisplaysAttentionOnce),
    ("unknown-return clarification", suite.testUnknownReturnClarificationQueuesAndAcknowledgesOnlyDisplay),
    ("ordinary question", suite.testOrdinaryPendingQuestionDoesNotIndependentlyOpenAttentionPanel),
    ("campaign expiry", suite.testAcceptedNewDayExpiryBlocksNonblankDraftAndReturnPrompt)
]
let selected = CommandLine.arguments.count > 1 ? cases.filter { $0.0 == CommandLine.arguments[1] } : cases
for (name, run) in selected {
    try run()
    print("PASS: \(name)")
}
print("Passed \(selected.count) study chat checks")
