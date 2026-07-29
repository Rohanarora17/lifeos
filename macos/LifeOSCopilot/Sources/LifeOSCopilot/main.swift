import AppKit
import AVFoundation

private func copilotLog(_ message: String) {
    let line = "[LifeOSCopilot] \(message)\n"
    FileHandle.standardError.write(Data(line.utf8))
}

private func jsonOutput(_ response: [String: Any]) {
    if let json = try? JSONSerialization.data(withJSONObject: response, options: [.sortedKeys]) {
        FileHandle.standardOutput.write(json)
        FileHandle.standardOutput.write(Data("\n".utf8))
    }
}

private func microphoneAuthorizationLabel(_ status: AVAuthorizationStatus) -> String {
    switch status {
    case .authorized: return "authorized"
    case .denied: return "denied"
    case .restricted: return "restricted"
    case .notDetermined: return "not_determined"
    @unknown default: return "unknown"
    }
}

@MainActor
private func runVoiceAuditIfRequested() -> Bool {
    let arguments = CommandLine.arguments
    let diagnosticsRequested = arguments.contains("--voice-diagnostics")
    let recordIndex = arguments.firstIndex(of: "--record-audio-once")
    guard diagnosticsRequested || recordIndex != nil else {
        return false
    }

    let app = NSApplication.shared
    app.setActivationPolicy(.accessory)
    Task { @MainActor in
        var authorization = AVCaptureDevice.authorizationStatus(for: .audio)
        if recordIndex != nil && authorization == .notDetermined {
            let granted = await AVCaptureDevice.requestAccess(for: .audio)
            authorization = granted ? .authorized : .denied
        }

        let inputs = AVCaptureDevice.DiscoverySession(
            deviceTypes: [.microphone],
            mediaType: .audio,
            position: .unspecified
        ).devices

        if diagnosticsRequested && recordIndex == nil {
            jsonOutput([
                "status": "ok",
                "microphoneAuthorization": microphoneAuthorizationLabel(authorization),
                "inputDeviceCount": inputs.count,
                "defaultInputAvailable": AVCaptureDevice.default(for: .audio) != nil,
            ])
            NSApp.terminate(nil)
            return
        }

        guard
            let recordIndex,
            arguments.indices.contains(recordIndex + 1)
        else {
            jsonOutput(["status": "invalid_arguments"])
            NSApp.terminate(nil)
            return
        }
        guard authorization == .authorized else {
            jsonOutput([
                "status": "permission_denied",
                "microphoneAuthorization": microphoneAuthorizationLabel(authorization),
            ])
            NSApp.terminate(nil)
            return
        }

        let outputURL = URL(fileURLWithPath: arguments[recordIndex + 1])
        let durationIndex = arguments.firstIndex(of: "--duration")
        let duration = durationIndex.flatMap {
            arguments.indices.contains($0 + 1) ? Double(arguments[$0 + 1]) : nil
        } ?? 8
        let boundedDuration = min(max(duration, 1), 30)
        let recorder = AudioRecorderService()

        do {
            NSSound.beep()
            try await Task.sleep(nanoseconds: 350_000_000)
            try recorder.start()
            try await Task.sleep(
                nanoseconds: UInt64(boundedDuration * 1_000_000_000)
            )
            guard let temporaryURL = recorder.stop() else {
                throw NSError(
                    domain: "LifeOSCopilot.AudioRecorder",
                    code: 2,
                    userInfo: [NSLocalizedDescriptionKey: "Recording output is unavailable"]
                )
            }
            try FileManager.default.copyItem(at: temporaryURL, to: outputURL)
            recorder.cleanup(temporaryURL)
            let attributes = try FileManager.default.attributesOfItem(atPath: outputURL.path)
            jsonOutput([
                "status": "recorded",
                "durationSeconds": boundedDuration,
                "bytes": attributes[.size] as? NSNumber ?? 0,
                "microphoneAuthorization": microphoneAuthorizationLabel(authorization),
                "maximumAveragePowerDB": recorder.maximumAveragePowerDB,
                "meterSampleCount": recorder.meterSampleCount,
                "speechDetected": recorder.detectedSpeech,
            ])
        } catch {
            jsonOutput([
                "status": "recording_failed",
                "error": error.localizedDescription,
                "microphoneAuthorization": microphoneAuthorizationLabel(authorization),
            ])
        }
        NSApp.terminate(nil)
    }
    app.run()
    return true
}

@MainActor
private func runOneShotCaptureIfRequested() -> Bool {
    let arguments = CommandLine.arguments
    guard let flagIndex = arguments.firstIndex(of: "--capture-once") else {
        return false
    }
    guard arguments.indices.contains(flagIndex + 1) else {
        FileHandle.standardError.write(Data("Missing --capture-once output path\n".utf8))
        return true
    }

    let outputURL = URL(fileURLWithPath: arguments[flagIndex + 1])
    func argumentValue(after flag: String) -> String? {
        guard
            let index = arguments.firstIndex(of: flag),
            arguments.indices.contains(index + 1)
        else {
            return nil
        }
        return arguments[index + 1]
    }
    let expectedApp = argumentValue(after: "--expect-app")
    let expectedTitle = argumentValue(after: "--expect-title")
    let app = NSApplication.shared
    app.setActivationPolicy(.accessory)
    Task { @MainActor in
        let capture = await ScreenCaptureService().captureFrontmostWindow(
            expectedApp: expectedApp,
            expectedTitleContains: expectedTitle
        )
        var response: [String: Any] = [
            "status": "skipped",
            "app": capture.app,
            "title": capture.title,
            "privacyReason": capture.privacyReason ?? NSNull(),
        ]

        if
            let base64Jpeg = capture.base64Jpeg,
            let jpeg = Data(base64Encoded: base64Jpeg)
        {
            do {
                try jpeg.write(to: outputURL, options: .atomic)
                response["status"] = "captured"
                response["width"] = capture.width
                response["height"] = capture.height
            } catch {
                response["status"] = "write_failed"
                response["error"] = error.localizedDescription
            }
        }

        jsonOutput(response)
        NSApp.terminate(nil)
    }
    app.run()
    return true
}

@MainActor
final class AppDelegate: NSObject, NSApplicationDelegate {
    private let statusItem = NSStatusBar.system.statusItem(withLength: NSStatusItem.variableLength)
    private let api = LifeOSAPIClient()
    private let capture = ScreenCaptureService()
    private let recorder = AudioRecorderService()
    private let overlay = OverlayWindow()
    private let classificationPrompt = ClassificationPromptController()
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
        Task { await classificationAskLoop() }
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
            guard recorder.detectedSpeech else {
                recorder.cleanup(url)
                overlay.show(
                    callouts: [],
                    message: "I couldn't hear speech. Check your microphone and try again."
                )
                return
            }
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
            if let response = try? await api.sendAppDwell(
                sessionId: sessionId,
                app: currentApp,
                title: currentTitle,
                durationSeconds: elapsed
            ), response.needsUserAsk == true || response.asked == true {
                // Server created a pending ask — pull it for the on-screen popup immediately
                await presentPendingClassificationAsk()
            }
        }
        currentApp = next.app
        currentTitle = next.title
        currentAppStartedAt = Date()
    }

    /// Poll for pending native-app classification asks and show clickable popup.
    private func classificationAskLoop() async {
        while true {
            if activeSessionId != nil {
                await presentPendingClassificationAsk()
            } else if classificationPrompt.isVisible {
                await MainActor.run { classificationPrompt.hide() }
            }
            try? await Task.sleep(nanoseconds: 4_000_000_000)
        }
    }

    private func presentPendingClassificationAsk() async {
        do {
            let response = try await api.fetchClassificationAsk()
            guard response.ok, let pending = response.pending else {
                if classificationPrompt.isVisible {
                    await MainActor.run { classificationPrompt.hide() }
                }
                return
            }
            await MainActor.run {
                classificationPrompt.show(
                    app: pending.app,
                    sessionTitle: pending.sessionTargetTitle,
                    reason: "Is this productive for your focus session? (privacy: content not shown)"
                ) { [weak self] category in
                    Task { @MainActor in
                        await self?.submitClassificationChoice(category)
                    }
                }
            }
        } catch {
            copilotLog("Classification ask poll failed: \(error.localizedDescription)")
        }
    }

    private func submitClassificationChoice(_ category: String) async {
        do {
            let result = try await api.resolveClassificationAsk(category: category)
            let label = result.ok
                ? "Saved: \(result.app ?? "app") → \(category)"
                : (result.error ?? "Could not save classification")
            await MainActor.run {
                overlay.show(callouts: [], message: label)
            }
            copilotLog("Classification resolved: \(category) ok=\(result.ok)")
        } catch {
            await MainActor.run {
                overlay.show(callouts: [], message: "Failed to save classification")
            }
            copilotLog("Classification resolve failed: \(error.localizedDescription)")
        }
    }
}

if !runVoiceAuditIfRequested() && !runOneShotCaptureIfRequested() {
    let app = NSApplication.shared
    let delegate = AppDelegate()
    app.delegate = delegate
    app.setActivationPolicy(.accessory)
    app.run()
}
