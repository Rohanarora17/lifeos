import AppKit
import AVFoundation

private func copilotLog(_ message: String) {
    let line = "[LifeOSCopilot] \(message)\n"
    FileHandle.standardError.write(Data(line.utf8))
}

@MainActor
final class AppDelegate: NSObject, NSApplicationDelegate {
    private let statusItem = NSStatusBar.system.statusItem(withLength: NSStatusItem.variableLength)
    private let api = LifeOSAPIClient()
    private let capture = ScreenCaptureService()
    private let recorder = AudioRecorderService()
    private let overlay = OverlayWindow()
    private let speaker = AVSpeechSynthesizer()

    private var activeSessionId: String?
    private var recording = false
    private var currentAppStartedAt = Date()
    private var currentApp = "Unknown App"
    private var currentTitle = ""

    func applicationDidFinishLaunching(_ notification: Notification) {
        statusItem.button?.title = "LifeOS"
        let menu = NSMenu()
        menu.addItem(NSMenuItem(title: "Ask About Window", action: #selector(askAboutWindow), keyEquivalent: "g"))
        menu.addItem(NSMenuItem(title: "Toggle Push To Talk", action: #selector(togglePushToTalk), keyEquivalent: " "))
        menu.addItem(NSMenuItem.separator())
        menu.addItem(NSMenuItem(title: "Quit", action: #selector(quit), keyEquivalent: "q"))
        statusItem.menu = menu

        installHotkeys()
        Task { await pollHeartbeatLoop() }
        Task { await visionCaptureLoop() }
        Timer.scheduledTimer(withTimeInterval: 30, repeats: true) { [weak self] _ in
            Task { @MainActor in
                await self?.flushAppDwellIfActive()
            }
        }
    }

    @objc private func quit() {
        NSApp.terminate(nil)
    }

    private func installHotkeys() {
        NSEvent.addGlobalMonitorForEvents(matching: .keyDown) { [weak self] event in
            Task { @MainActor in
                self?.handleHotkey(event)
            }
        }
        NSEvent.addLocalMonitorForEvents(matching: .keyDown) { [weak self] event in
            self?.handleHotkey(event)
            return event
        }
    }

    private func handleHotkey(_ event: NSEvent) {
        let flags = event.modifierFlags.intersection(.deviceIndependentFlagsMask)
        if flags.contains([.command, .shift]), event.keyCode == 49 {
            togglePushToTalk()
        } else if flags.contains([.command, .shift]), event.charactersIgnoringModifiers?.lowercased() == "g" {
            askAboutWindow()
        } else if event.keyCode == 53 {
            overlay.hideOverlay()
        }
    }

    private func pollHeartbeatLoop() async {
        while true {
            do {
                let response = try await api.heartbeat()
                activeSessionId = response.active ? response.sessionId : nil
                await MainActor.run {
                    statusItem.button?.title = response.active ? "LifeOS On" : "LifeOS"
                }
            } catch {
                activeSessionId = nil
            }
            try? await Task.sleep(nanoseconds: 5_000_000_000)
        }
    }

    private func visionCaptureLoop() async {
        var nextDelayMs = 5_000
        while true {
            do {
                try await api.sendVisionHeartbeat()
                let state = try await api.visionState()
                activeSessionId = state.active ? state.sessionId : nil
                nextDelayMs = max(5_000, min(60_000, state.nextIntervalMs))

                if state.active, let sessionId = state.sessionId {
                    let windowCapture = await capture.captureFrontmostWindow()
                    if let base64Jpeg = windowCapture.base64Jpeg {
                        try await api.sendVisionCapture(
                            sessionId: sessionId,
                            base64Jpeg: base64Jpeg,
                            app: windowCapture.app,
                            title: windowCapture.title
                        )
                        copilotLog("Vision capture uploaded")
                    } else if windowCapture.privacyReason?.hasPrefix("sensitive_") == true {
                        try await api.sendSensitivitySkip(
                            sessionId: sessionId,
                            reason: "sensitive_window"
                        )
                        copilotLog("Vision capture privacy-skipped: \(windowCapture.privacyReason ?? "sensitive_window")")
                    } else {
                        copilotLog("Vision capture unavailable: \(windowCapture.privacyReason ?? "unknown")")
                    }
                }
            } catch {
                nextDelayMs = 5_000
                copilotLog("Vision loop error: \(error.localizedDescription)")
            }

            try? await Task.sleep(
                nanoseconds: UInt64(nextDelayMs) * 1_000_000
            )
        }
    }

    @objc private func askAboutWindow() {
        Task { await runGuidanceTurn(audioURL: nil) }
    }

    @objc private func togglePushToTalk() {
        if recording {
            recording = false
            let url = recorder.stop()
            Task { await runGuidanceTurn(audioURL: url); recorder.cleanup(url) }
        } else {
            guard activeSessionId != nil else {
                overlay.show(callouts: [], message: "Start a LifeOS focus session before using the native copilot.")
                return
            }
            do {
                try recorder.start()
                recording = true
                overlay.show(callouts: [], message: "Listening...")
            } catch {
                overlay.show(callouts: [], message: "Microphone permission is needed for push-to-talk.")
            }
        }
    }

    private func runGuidanceTurn(audioURL: URL?) async {
        guard let sessionId = activeSessionId else {
            await MainActor.run {
                overlay.show(callouts: [], message: "Start a LifeOS focus session before asking.")
            }
            return
        }

        let windowCapture = await capture.captureFrontmostWindow()

        do {
            let response = try await api.sendTurn(
                sessionId: sessionId,
                transcript: "Explain what I am looking at in the context of my session goal.",
                audioURL: audioURL,
                screenshotBase64: windowCapture.base64Jpeg,
                selectedText: nil,
                app: windowCapture.app,
                title: windowCapture.title,
                screenSize: (windowCapture.width, windowCapture.height),
                cursorPoint: (windowCapture.cursorX, windowCapture.cursorY)
            )
            await MainActor.run {
                overlay.show(callouts: response.callouts, message: response.spokenAnswer ?? response.answer)
            }
            if let spoken = response.spokenAnswer, !spoken.isEmpty {
                let utterance = AVSpeechUtterance(string: spoken)
                utterance.rate = AVSpeechUtteranceDefaultSpeechRate
                speaker.speak(utterance)
            }
        } catch {
            await MainActor.run {
                overlay.show(callouts: [], message: "LifeOS copilot request failed.")
            }
        }
    }

    private func flushAppDwellIfActive() async {
        guard let sessionId = activeSessionId else { return }
        let next = capture.frontmostApp()
        let elapsed = Int(Date().timeIntervalSince(currentAppStartedAt))
        if elapsed >= 5 {
            try? await api.sendAppDwell(sessionId: sessionId, app: currentApp, title: currentTitle, durationSeconds: elapsed)
        }
        currentApp = next.app
        currentTitle = next.title
        currentAppStartedAt = Date()
    }
}

let app = NSApplication.shared
let delegate = AppDelegate()
app.delegate = delegate
app.setActivationPolicy(.accessory)
app.run()
