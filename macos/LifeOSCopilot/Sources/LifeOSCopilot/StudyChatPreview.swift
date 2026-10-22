import AppKit

/// Bounded diagnostic against an explicit local fixture. It never starts AppDelegate/collectors,
/// reads saved chat, writes preferences, or requests capture or microphone permission.
@MainActor
func runStudyChatPreviewIfRequested() -> Bool {
    let args = CommandLine.arguments
    guard let index = args.firstIndex(of: "--study-chat-preview") else { return false }
    guard args.indices.contains(index + 1), let url = URL(string: args[index + 1]),
          url.scheme == "http", ["127.0.0.1", "localhost", "::1"].contains(url.host ?? ""),
          url.port != nil else {
        FileHandle.standardError.write(Data("Preview requires an explicit loopback fixture URL with a port.\n".utf8))
        return true
    }
    let app = NSApplication.shared
    app.setActivationPolicy(.accessory)
    let api = LifeOSAPIClient()
    api.serverBase = url
    let controller = StudyChatController(api: api, defaults: nil)
    // Verify a return arriving during presence stays queued without constructing an extra panel.
    controller.setPresenceVisible(true)
    controller.setClassificationVisible(true)
    controller.start()
    Task { @MainActor in
        func require(_ condition: Bool, _ label: String) {
            guard condition else {
                FileHandle.standardError.write(Data("FAIL UI: \(label)\n".utf8))
                exit(1)
            }
            FileHandle.standardOutput.write(Data("PASS UI: \(label)\n".utf8))
        }
        try? await Task.sleep(nanoseconds: 2_000_000_000)
        require(!app.windows.contains { $0.title == "LifeOS Study Chat" }, "presence queues the return prompt")
        let keyBefore = app.keyWindow
        let activeBefore = app.isActive
        controller.setPresenceVisible(false)
        require(!app.windows.contains { $0.title == "LifeOS Study Chat" }, "classification also queues the return prompt")
        controller.setClassificationVisible(false)
        guard let panel = app.windows.first(where: { $0.title == "LifeOS Study Chat" }) else {
            require(false, "fixture produced a return prompt")
            return
        }
        require(panel.isVisible, "queued prompt appears after presence resolves")
        require(app.keyWindow === keyBefore && app.isActive == activeBefore, "proactive display preserves keyboard focus")
        @MainActor func editors(_ view: NSView) -> [NSTextView] {
            if let editor = view as? NSTextView { return [editor] }
            return view.subviews.flatMap { editors($0) }
        }
        guard let content = panel.contentView, let composer = editors(content).first(where: { $0.isEditable }) else {
            require(false, "actual panel contains editable composer")
            return
        }
        composer.string = "Preview draft survives the next server poll"
        controller.textDidChange(Notification(name: NSText.didChangeNotification, object: composer))
        try? await Task.sleep(nanoseconds: 6_000_000_000)
        require(composer.string == "Preview draft survives the next server poll", "poll preserves composer draft")
        panel.miniaturize(nil)
        try? await Task.sleep(nanoseconds: 300_000_000)
        controller.openFromMenu()
        require(panel.isVisible && !panel.isMiniaturized, "menu reopens minimized panel")
        require(panel.firstResponder === composer, "explicit menu activation focuses composer")
        require(composer.string == "Preview draft survives the next server poll", "reopen preserves draft")
        panel.performClose(nil)
        require(!panel.isVisible, "close hides the persistent panel")
        app.terminate(nil)
    }
    app.run()
    return true
}
