import AppKit
import AVFoundation
import Foundation
@preconcurrency import ScreenCaptureKit

@MainActor
final class ScreenCaptureService {
    struct WindowCapture {
        let base64Jpeg: String?
        let app: String
        let title: String
        let width: Double
        let height: Double
        let cursorX: Double
        let cursorY: Double
        let privacyReason: String?
    }

    private let sensitiveAppPatterns = [
        "1password", "bitwarden", "lastpass", "keychain access",
        "passwords", "authenticator",
        "whatsapp", "facetime", "messages", "signal", "telegram",
        "zoom", "microsoft teams", "webex",
        "lifeos copilot", "lifeoscopilot", "lifeos"
    ]

    private let sensitiveTitlePatterns = [
        "meet.google.com", "google meet", "video call", "video meeting"
    ]

    func captureFrontmostWindow() async -> WindowCapture {
        guard let frontmost = NSWorkspace.shared.frontmostApplication else {
            return emptyCapture(app: "Unknown App", title: "", reason: "no_frontmost_application")
        }
        let frontmostAppName = frontmost.localizedName ?? "Unknown App"
        if isSensitive(app: frontmostAppName, title: "") {
            return emptyCapture(app: "Sensitive App", title: "", reason: "sensitive_window")
        }

        do {
            let content = try await SCShareableContent.excludingDesktopWindows(
                true,
                onScreenWindowsOnly: true
            )
            let candidates = content.windows.filter { window in
                window.owningApplication?.processID == frontmost.processIdentifier
                    && window.frame.width >= 100
                    && window.frame.height >= 100
            }
            guard let window = candidates.max(by: {
                $0.frame.width * $0.frame.height < $1.frame.width * $1.frame.height
            }) else {
                return emptyCapture(
                    app: frontmostAppName,
                    title: "",
                    reason: "no_frontmost_window"
                )
            }

            let appName = window.owningApplication?.applicationName
                ?? frontmost.localizedName
                ?? "Unknown App"
            let title = window.title ?? ""
            if isSensitive(app: appName, title: title) {
                return emptyCapture(app: "Sensitive App", title: "", reason: "sensitive_window")
            }

            let filter = SCContentFilter(desktopIndependentWindow: window)
            let configuration = SCStreamConfiguration()
            let scale = min(1.0, 1_600.0 / max(window.frame.width, 1))
            configuration.width = max(1, Int(window.frame.width * scale))
            configuration.height = max(1, Int(window.frame.height * scale))
            configuration.showsCursor = false
            configuration.ignoreShadowsSingleWindow = true

            let image = try await SCScreenshotManager.captureImage(
                contentFilter: filter,
                configuration: configuration
            )
            let bitmap = NSBitmapImageRep(cgImage: image)
            let jpeg = bitmap.representation(
                using: .jpeg,
                properties: [.compressionFactor: 0.72]
            )
            let cursor = CGEvent(source: nil)?.location ?? .zero
            return WindowCapture(
                base64Jpeg: jpeg?.base64EncodedString(),
                app: appName,
                title: title,
                width: Double(window.frame.width),
                height: Double(window.frame.height),
                cursorX: max(0, Double(cursor.x - window.frame.origin.x)),
                cursorY: max(0, Double(cursor.y - window.frame.origin.y)),
                privacyReason: nil
            )
        } catch {
            return emptyCapture(
                app: frontmostAppName,
                title: "",
                reason: "capture_failed"
            )
        }
    }

    func frontmostApp() -> (app: String, title: String) {
        guard let app = NSWorkspace.shared.frontmostApplication else {
            return ("Unknown App", "")
        }
        let windows = CGWindowListCopyWindowInfo(
            [.optionOnScreenOnly, .excludeDesktopElements],
            kCGNullWindowID
        ) as? [[String: Any]] ?? []
        let title = windows.first {
            ($0[kCGWindowOwnerPID as String] as? pid_t) == app.processIdentifier
                && ($0[kCGWindowLayer as String] as? Int) == 0
        }?[kCGWindowName as String] as? String ?? ""
        return (app.localizedName ?? "Unknown App", title)
    }

    private func isSensitive(app: String, title: String) -> Bool {
        let appValue = app.lowercased()
        let titleValue = title.lowercased()
        return sensitiveAppPatterns.contains { appValue.contains($0) }
            || sensitiveTitlePatterns.contains { titleValue.contains($0) }
    }

    private func emptyCapture(app: String, title: String, reason: String) -> WindowCapture {
        WindowCapture(
            base64Jpeg: nil,
            app: app,
            title: title,
            width: 0,
            height: 0,
            cursorX: 0,
            cursorY: 0,
            privacyReason: reason
        )
    }
}

@MainActor
final class AudioRecorderService: NSObject, AVAudioRecorderDelegate {
    private var recorder: AVAudioRecorder?
    private var outputURL: URL?

    func start() throws {
        let url = FileManager.default.temporaryDirectory.appendingPathComponent("lifeos-copilot-\(UUID().uuidString).m4a")
        outputURL = url
        let settings: [String: Any] = [
            AVFormatIDKey: Int(kAudioFormatMPEG4AAC),
            AVSampleRateKey: 44_100,
            AVNumberOfChannelsKey: 1,
            AVEncoderAudioQualityKey: AVAudioQuality.medium.rawValue
        ]
        recorder = try AVAudioRecorder(url: url, settings: settings)
        recorder?.delegate = self
        recorder?.record()
    }

    func stop() -> URL? {
        recorder?.stop()
        recorder = nil
        return outputURL
    }

    func cleanup(_ url: URL?) {
        guard let url else { return }
        try? FileManager.default.removeItem(at: url)
    }
}

@MainActor
final class LifeOSAPIClient {
    var serverBase: URL
    private let deviceToken: String?

    init() {
        let environment = ProcessInfo.processInfo.environment
        serverBase = URL(
            string: environment["LIFEOS_SERVER_URL"] ?? "http://localhost:3000"
        )!
        deviceToken = environment["LIFEOS_DEVICE_TOKEN"]
    }

    private func authorize(_ request: inout URLRequest) {
        if let deviceToken, !deviceToken.isEmpty {
            request.addValue("Bearer \(deviceToken)", forHTTPHeaderField: "Authorization")
        }
    }

    private func responseData(for request: URLRequest) async throws -> Data {
        let (data, response) = try await URLSession.shared.data(for: request)
        guard let http = response as? HTTPURLResponse, (200..<300).contains(http.statusCode) else {
            let status = (response as? HTTPURLResponse)?.statusCode ?? 0
            throw NSError(
                domain: "LifeOSAPI",
                code: status,
                userInfo: [NSLocalizedDescriptionKey: "LifeOS request failed with HTTP \(status)"]
            )
        }
        return data
    }

    func heartbeat() async throws -> NativeHeartbeatResponse {
        let url = serverBase.appendingPathComponent("/api/native/ingest")
        var request = URLRequest(url: url)
        request.httpMethod = "POST"
        request.addValue("application/json", forHTTPHeaderField: "Content-Type")
        authorize(&request)
        request.httpBody = try JSONSerialization.data(withJSONObject: ["kind": "capture_heartbeat"])
        let data = try await responseData(for: request)
        return try JSONDecoder().decode(NativeHeartbeatResponse.self, from: data)
    }

    func sendVisionHeartbeat() async throws {
        let url = serverBase.appendingPathComponent("/api/guardian/vision")
        var request = URLRequest(url: url)
        request.httpMethod = "POST"
        request.addValue("application/json", forHTTPHeaderField: "Content-Type")
        authorize(&request)
        request.httpBody = try JSONSerialization.data(withJSONObject: ["type": "heartbeat"])
        _ = try await responseData(for: request)
    }

    func visionState() async throws -> VisionStateResponse {
        let url = serverBase.appendingPathComponent("/api/guardian/vision")
        var request = URLRequest(url: url)
        authorize(&request)
        let data = try await responseData(for: request)
        return try JSONDecoder().decode(VisionStateResponse.self, from: data)
    }

    func sendVisionCapture(
        sessionId: String,
        base64Jpeg: String,
        app: String,
        title: String
    ) async throws {
        let url = serverBase.appendingPathComponent("/api/guardian/vision")
        var request = URLRequest(url: url)
        request.httpMethod = "POST"
        request.addValue("application/json", forHTTPHeaderField: "Content-Type")
        authorize(&request)
        request.httpBody = try JSONSerialization.data(withJSONObject: [
            "type": "capture",
            "sessionId": sessionId,
            "base64Jpeg": base64Jpeg,
            "appInFocus": app,
            "windowTitle": title
        ])
        _ = try await responseData(for: request)
    }

    func sendSensitivitySkip(sessionId: String, reason: String) async throws {
        let url = serverBase.appendingPathComponent("/api/native/ingest")
        var request = URLRequest(url: url)
        request.httpMethod = "POST"
        request.addValue("application/json", forHTTPHeaderField: "Content-Type")
        authorize(&request)
        request.httpBody = try JSONSerialization.data(withJSONObject: [
            "kind": "sensitivity_skip",
            "sessionId": sessionId,
            "appInFocus": "Sensitive App",
            "windowTitle": "",
            "reason": reason
        ])
        _ = try await responseData(for: request)
    }

    func sendAppDwell(sessionId: String, app: String, title: String, durationSeconds: Int) async throws {
        let url = serverBase.appendingPathComponent("/api/native/ingest")
        var request = URLRequest(url: url)
        request.httpMethod = "POST"
        request.addValue("application/json", forHTTPHeaderField: "Content-Type")
        authorize(&request)
        request.httpBody = try JSONSerialization.data(withJSONObject: [
            "kind": "app_dwell",
            "sessionId": sessionId,
            "appInFocus": app,
            "windowTitle": title,
            "durationSeconds": durationSeconds
        ])
        _ = try await responseData(for: request)
    }

    func sendTurn(sessionId: String, transcript: String?, audioURL: URL?, screenshotBase64: String?, selectedText: String?, app: String, title: String, screenSize: (width: Double, height: Double), cursorPoint: (x: Double, y: Double)) async throws -> CopilotTurnResponse {
        let url = serverBase.appendingPathComponent("/api/focus-copilot/turn")
        var request = URLRequest(url: url)
        request.httpMethod = "POST"
        authorize(&request)

        if let audioURL {
            let boundary = "LifeOSBoundary-\(UUID().uuidString)"
            request.addValue("multipart/form-data; boundary=\(boundary)", forHTTPHeaderField: "Content-Type")
            request.httpBody = try multipartBody(boundary: boundary, fields: [
                "sessionId": sessionId,
                "source": "native_ptt",
                "base64Jpeg": screenshotBase64 ?? "",
                "selectedText": selectedText ?? "",
                "appInFocus": app,
                "windowTitle": title,
                "screenSize": "{\"width\":\(screenSize.width),\"height\":\(screenSize.height)}",
                "cursorPoint": "{\"x\":\(cursorPoint.x),\"y\":\(cursorPoint.y)}"
            ], fileURL: audioURL)
        } else {
            request.addValue("application/json", forHTTPHeaderField: "Content-Type")
            request.httpBody = try JSONSerialization.data(withJSONObject: [
                "sessionId": sessionId,
                "source": selectedText?.isEmpty == false ? "native_selection" : "native_hotkey",
                "transcript": transcript ?? "",
                "question": transcript ?? "Explain what I am looking at in the context of my session goal.",
                "base64Jpeg": screenshotBase64 ?? "",
                "selectedText": selectedText ?? "",
                "appInFocus": app,
                "windowTitle": title,
                "screenSize": ["width": screenSize.width, "height": screenSize.height],
                "cursorPoint": ["x": cursorPoint.x, "y": cursorPoint.y]
            ])
        }

        let data = try await responseData(for: request)
        return try JSONDecoder().decode(CopilotTurnResponse.self, from: data)
    }

    private func multipartBody(boundary: String, fields: [String: String], fileURL: URL) throws -> Data {
        var data = Data()
        for (key, value) in fields {
            data.append("--\(boundary)\r\n")
            data.append("Content-Disposition: form-data; name=\"\(key)\"\r\n\r\n")
            data.append("\(value)\r\n")
        }
        data.append("--\(boundary)\r\n")
        data.append("Content-Disposition: form-data; name=\"audio\"; filename=\"speech.m4a\"\r\n")
        data.append("Content-Type: audio/mp4\r\n\r\n")
        data.append(try Data(contentsOf: fileURL))
        data.append("\r\n--\(boundary)--\r\n")
        return data
    }
}

private extension Data {
    mutating func append(_ string: String) {
        append(string.data(using: .utf8)!)
    }
}
