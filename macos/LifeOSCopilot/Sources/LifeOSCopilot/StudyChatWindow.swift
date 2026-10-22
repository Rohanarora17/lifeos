import AppKit
import StudyChatCore

/// The panel only presents server state. It never starts collectors, resolves presence, or credits time.
@MainActor
final class StudyChatController: NSObject, NSTextViewDelegate, NSWindowDelegate {
    private let api: LifeOSAPIClient
    private var local: StudyChatLocalState
    private let defaults: UserDefaults?
    private let storageKey: String
    private var panel: StudyChatPanel?
    private var history: NSTextView?
    private var composer: NSTextView?
    private var statusLabel: NSTextField?
    private var sendButton: NSButton?
    private var renderedConversation = ""
    private var submitting = false
    private var presenceVisible = false
    private var classificationVisible = false
    private var started = false
    private var hasFreshState = false
    private var status = "Connecting… Cached conversation may be outdated."

    init(api: LifeOSAPIClient, defaults: UserDefaults? = .standard) {
        self.api = api
        self.defaults = defaults
        storageKey = api.studyChatStorageKey
        local = defaults?.data(forKey: storageKey).flatMap {
            try? JSONDecoder().decode(StudyChatLocalState.self, from: $0)
        } ?? StudyChatLocalState()
        super.init()
        if local.pendingRequest != nil {
            status = "Message not yet confirmed saved. Retry sends the same request safely."
        }
    }

    func start() {
        guard !started else { return }
        started = true
        Task { [weak self] in
            while let self {
                await self.refresh()
                try? await Task.sleep(nanoseconds: 5_000_000_000)
            }
        }
    }

    func openFromMenu() {
        ensurePanel()
        guard !presenceVisible else {
            status = "Answer the Guardian presence check first. Your draft is kept."
            render()
            return
        }
        panel?.deminiaturize(nil)
        NSApp.activate(ignoringOtherApps: true)
        panel?.makeKeyAndOrderFront(nil)
        panel?.makeFirstResponder(composer)
        markCurrentPromptDisplayed()
    }

    func setPresenceVisible(_ visible: Bool) {
        presenceVisible = visible
        if visible {
            // Preserve the window and editor; only remove it from the attention stack.
            panel?.orderOut(nil)
        } else {
            presentPromptIfNeeded()
        }
    }

    func setClassificationVisible(_ visible: Bool) {
        classificationVisible = visible
        if visible { panel?.orderOut(nil) } else { presentPromptIfNeeded() }
    }

    private func refresh() async {
        do {
            local.receive(try await api.studyChatState())
            hasFreshState = true
            save()
            if local.pendingRequest == nil && !local.requiresExplicitResend {
                status = local.state?.enabled == true
                    ? "Connected · Agreements save on the LifeOS server."
                    : "Study campaign is inactive. Conversation history is available."
            }
            render()
            presentPromptIfNeeded()
            await acknowledgeDisplayedPrompts()
        } catch {
            hasFreshState = false
            if !submitting {
                status = local.pendingRequest == nil
                    ? "Offline · Cached history. Draft stays on this Mac; changes are not yet saved."
                    : "Not yet confirmed saved · Retry keeps the same request."
            }
            render()
        }
    }

    private func presentPromptIfNeeded() {
        // Never display a cached return after a restart before the latest state is fetched.
        guard hasFreshState, local.promptToDisplay(presenceVisible: presenceVisible || classificationVisible) != nil else { return }
        ensurePanel()
        // A proactive reminder never activates the app or changes the first responder.
        panel?.orderFrontRegardless()
        markCurrentPromptDisplayed()
    }

    private func markCurrentPromptDisplayed() {
        guard !presenceVisible, panel?.isVisible == true, panel?.isMiniaturized != true,
              hasFreshState, let prompt = local.state?.pendingPrompt else { return }
        local.didDisplayPrompt(prompt.id)
        save()
        Task { await acknowledgeDisplayedPrompts() }
    }

    private var acknowledging = false
    private func acknowledgeDisplayedPrompts() async {
        guard !acknowledging else { return }
        acknowledging = true
        defer { acknowledging = false }
        for id in local.unacknowledgedPromptIDs {
            do {
                try await api.acknowledgeStudyChatPrompt(id)
                local.didAcknowledgePrompt(id)
                save()
            } catch {
                // Durable retry only acknowledges display; it cannot resolve an agreement.
                break
            }
        }
    }

    @objc private func send() {
        guard !submitting, !presenceVisible,
              let request = local.prepareSend(requestID: UUID().uuidString) else { return }
        save() // Persist the immutable request before the network might accept it.
        submitting = true
        status = "Sending… Waiting for server confirmation."
        render()
        Task {
            defer { submitting = false; render() }
            do {
                let state = try await api.sendStudyChat(request)
                local.sentSuccessfully(state)
                hasFreshState = true
                status = "Message saved · See LifeOS’s reply for the result."
                composer?.string = local.draft
            } catch let error as StudyChatAPIError where error.status == 409 || error.status == 400 {
                var latest = error.state
                if latest == nil { latest = try? await api.studyChatState() }
                local.conflict(state: latest)
                hasFreshState = latest != nil
                status = error.status == 409
                    ? "The agreement changed. Review the latest reply, then choose Resend explicitly."
                    : "Not saved: \(error.message). Edit your message and send again."
            } catch let error as StudyChatAPIError {
                status = "Not yet confirmed saved: \(error.message). Retry keeps the same request."
            } catch {
                status = "Connection interrupted · Not yet confirmed saved. Retry sends the same request."
            }
            save()
            render()
            presentPromptIfNeeded()
        }
    }

    func textDidChange(_ notification: Notification) {
        guard let editor = notification.object as? NSTextView, editor === composer else { return }
        local.draft = editor.string
        save()
        updateSendButton()
    }

    @objc private func hidePanel() {
        save()
        panel?.orderOut(nil)
    }

    func windowShouldClose(_ sender: NSWindow) -> Bool {
        hidePanel()
        return false
    }

    private func save() {
        if let data = try? JSONEncoder().encode(local) { defaults?.set(data, forKey: storageKey) }
    }

    private func updateSendButton() {
        sendButton?.title = local.pendingRequest != nil ? "Retry message" : local.requiresExplicitResend ? "Resend" : "Send"
        sendButton?.isEnabled = !submitting && !presenceVisible &&
            (local.pendingRequest != nil || (hasFreshState && local.state?.enabled == true && !local.draft.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty))
    }

    private func render() {
        guard let history else { return }
        var conversation = local.state?.messages.map {
            "\($0.role == "user" ? "You" : "LifeOS")\n\($0.text)"
        }.joined(separator: "\n\n") ?? "Study Chat\nTell LifeOS when you leave, when you expect to return, or what you want to study."
        if let request = local.pendingRequest {
            conversation += "\n\nYou · not yet confirmed saved\n\(request.message)"
        }
        if let prompt = local.state?.pendingPrompt,
           local.state?.messages.last?.text != prompt.text {
            conversation += "\n\nLifeOS\n\(prompt.text)"
        }
        if let question = local.state?.pendingQuestion, !conversation.contains(question) {
            conversation += "\n\nLifeOS\n\(question)"
        }
        // Do not replace the document on every heartbeat: preserve selection and scroll position.
        if renderedConversation != conversation {
            let atBottom = history.enclosingScrollView.map {
                $0.contentView.bounds.maxY >= history.bounds.maxY - 24
            } ?? true
            history.string = conversation
            renderedConversation = conversation
            if atBottom { history.scrollRangeToVisible(NSRange(location: history.string.utf16.count, length: 0)) }
        }
        statusLabel?.stringValue = status
        updateSendButton()
    }

    private func ensurePanel() {
        guard panel == nil else { return }
        let width: CGFloat = 480
        let height: CGFloat = 540
        let screen = NSScreen.main?.visibleFrame ?? NSRect(x: 0, y: 0, width: 1200, height: 800)
        let panel = StudyChatPanel(
            contentRect: NSRect(x: screen.maxX - width - 24, y: screen.maxY - height - 48, width: width, height: height),
            styleMask: [.titled, .closable, .miniaturizable, .resizable, .nonactivatingPanel],
            backing: .buffered, defer: false
        )
        panel.title = "LifeOS Study Chat"
        panel.isFloatingPanel = true
        panel.level = .floating
        panel.hidesOnDeactivate = false
        panel.becomesKeyOnlyIfNeeded = true
        panel.collectionBehavior = [.canJoinAllSpaces, .fullScreenAuxiliary]
        panel.minSize = NSSize(width: 360, height: 360)
        panel.isReleasedWhenClosed = false
        panel.delegate = self
        let content = NSView()
        panel.contentView = content

        let transcriptScroll = NSScrollView()
        transcriptScroll.hasVerticalScroller = true
        transcriptScroll.borderType = .bezelBorder
        let transcript = NSTextView(frame: NSRect(x: 0, y: 0, width: width - 32, height: 300))
        transcript.isEditable = false
        transcript.isSelectable = true
        transcript.font = .systemFont(ofSize: 14)
        transcript.textContainerInset = NSSize(width: 10, height: 12)
        transcript.isVerticallyResizable = true
        transcript.isHorizontallyResizable = false
        transcript.autoresizingMask = [.width]
        transcript.textContainer?.widthTracksTextView = true
        transcriptScroll.documentView = transcript
        history = transcript

        let composerScroll = NSScrollView()
        composerScroll.hasVerticalScroller = true
        composerScroll.borderType = .bezelBorder
        let editor = NSTextView(frame: NSRect(x: 0, y: 0, width: width - 32, height: 76))
        editor.isRichText = false
        editor.font = .systemFont(ofSize: 14)
        editor.isVerticallyResizable = true
        editor.isHorizontallyResizable = false
        editor.autoresizingMask = [.width]
        editor.textContainer?.widthTracksTextView = true
        editor.textContainerInset = NSSize(width: 8, height: 8)
        editor.string = local.draft
        editor.delegate = self
        composerScroll.documentView = editor
        composer = editor
        editor.setAccessibilityLabel("Study chat message")

        let statusLabel = NSTextField(wrappingLabelWithString: status)
        statusLabel.font = .systemFont(ofSize: 11)
        statusLabel.textColor = .secondaryLabelColor
        self.statusLabel = statusLabel
        let send = NSButton(title: "Send", target: self, action: #selector(send))
        send.keyEquivalent = "\r"
        send.keyEquivalentModifierMask = [.command]
        send.bezelStyle = .rounded
        sendButton = send
        let hide = NSButton(title: "Hide", target: self, action: #selector(hidePanel))
        hide.bezelStyle = .rounded
        let caption = NSTextField(labelWithString: "Text chat · ⌘ Return to send · Draft saved on this Mac")
        caption.font = .systemFont(ofSize: 11)
        caption.textColor = .secondaryLabelColor
        for view in [transcriptScroll, composerScroll, statusLabel, send, hide, caption] {
            view.translatesAutoresizingMaskIntoConstraints = false
            content.addSubview(view)
        }
        NSLayoutConstraint.activate([
            transcriptScroll.topAnchor.constraint(equalTo: content.topAnchor, constant: 14),
            transcriptScroll.leadingAnchor.constraint(equalTo: content.leadingAnchor, constant: 14),
            transcriptScroll.trailingAnchor.constraint(equalTo: content.trailingAnchor, constant: -14),
            transcriptScroll.bottomAnchor.constraint(equalTo: statusLabel.topAnchor, constant: -10),
            statusLabel.leadingAnchor.constraint(equalTo: transcriptScroll.leadingAnchor),
            statusLabel.trailingAnchor.constraint(equalTo: transcriptScroll.trailingAnchor),
            statusLabel.bottomAnchor.constraint(equalTo: composerScroll.topAnchor, constant: -8),
            composerScroll.leadingAnchor.constraint(equalTo: transcriptScroll.leadingAnchor),
            composerScroll.trailingAnchor.constraint(equalTo: transcriptScroll.trailingAnchor),
            composerScroll.heightAnchor.constraint(equalToConstant: 82),
            composerScroll.bottomAnchor.constraint(equalTo: caption.topAnchor, constant: -8),
            caption.leadingAnchor.constraint(equalTo: transcriptScroll.leadingAnchor),
            caption.bottomAnchor.constraint(equalTo: send.topAnchor, constant: -8),
            send.trailingAnchor.constraint(equalTo: transcriptScroll.trailingAnchor),
            send.bottomAnchor.constraint(equalTo: content.bottomAnchor, constant: -12),
            hide.trailingAnchor.constraint(equalTo: send.leadingAnchor, constant: -10),
            hide.centerYAnchor.constraint(equalTo: send.centerYAnchor),
        ])
        self.panel = panel
        render()
    }
}

@MainActor
private final class StudyChatPanel: NSPanel {
    override var canBecomeKey: Bool { true }
    override var canBecomeMain: Bool { false }
}
