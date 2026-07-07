import AppKit
import AVFoundation
import Foundation
import ScreenCaptureKit

@MainActor
final class ScreenCaptureService {
    func captureMainDisplayJpegBase64() -> String? {
        guard let image = CGDisplayCreateImage(CGMainDisplayID()) else { return nil }
        let bitmap = NSBitmapImageRep(cgImage: image)
        guard let data = bitmap.representation(using: .jpeg, properties: [.compressionFactor: 0.72]) else { return nil }
        return data.base64EncodedString()
    }

    func frontmostApp() -> (app: String, title: String) {
        let app = NSWorkspace.shared.frontmostApplication?.localizedName ?? "Unknown App"
        return (app, "")
    }

    func currentScreenSize() -> (width: Double, height: Double) {
        let frame = NSScreen.main?.frame ?? .zero
        return (Double(frame.width), Double(frame.height))
    }

    func cursorPoint() -> (x: Double, y: Double) {
        let point = NSEvent.mouseLocation
        let height = NSScreen.main?.frame.height ?? 0
        return (Double(point.x), Double(max(0, height - point.y)))
    }
}

@MainActor
final class ClipboardSelectionService {
    func captureSelectedText() -> String {
        let pasteboard = NSPasteboard.general
        let original = pasteboard.string(forType: .string)

        let source = CGEventSource(stateID: .combinedSessionState)
        let down = CGEvent(keyboardEventSource: source, virtualKey: 8, keyDown: true)
        let up = CGEvent(keyboardEventSource: source, virtualKey: 8, keyDown: false)
        down?.flags = .maskCommand
        up?.flags = .maskCommand
        down?.post(tap: .cghidEventTap)
        up?.post(tap: .cghidEventTap)

        Thread.sleep(forTimeInterval: 0.12)
        let selected = pasteboard.string(forType: .string) ?? ""

        pasteboard.clearContents()
        if let original {
            pasteboard.setString(original, forType: .string)
        }
        return selected.trimmingCharacters(in: .whitespacesAndNewlines)
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
    var serverBase = URL(string: "http://localhost:3000")!

    func heartbeat() async throws -> NativeHeartbeatResponse {
        let url = serverBase.appendingPathComponent("/api/native/ingest")
        var request = URLRequest(url: url)
        request.httpMethod = "POST"
        request.addValue("application/json", forHTTPHeaderField: "Content-Type")
        request.httpBody = try JSONSerialization.data(withJSONObject: ["kind": "capture_heartbeat"])
        let (data, _) = try await URLSession.shared.data(for: request)
        return try JSONDecoder().decode(NativeHeartbeatResponse.self, from: data)
    }

    func sendAppDwell(sessionId: String, app: String, title: String, durationSeconds: Int) async throws {
        let url = serverBase.appendingPathComponent("/api/native/ingest")
        var request = URLRequest(url: url)
        request.httpMethod = "POST"
        request.addValue("application/json", forHTTPHeaderField: "Content-Type")
        request.httpBody = try JSONSerialization.data(withJSONObject: [
            "kind": "app_dwell",
            "sessionId": sessionId,
            "appInFocus": app,
            "windowTitle": title,
            "durationSeconds": durationSeconds
        ])
        _ = try await URLSession.shared.data(for: request)
    }

    func sendTurn(sessionId: String, transcript: String?, audioURL: URL?, screenshotBase64: String?, selectedText: String?, app: String, title: String, screenSize: (width: Double, height: Double), cursorPoint: (x: Double, y: Double)) async throws -> CopilotTurnResponse {
        let url = serverBase.appendingPathComponent("/api/focus-copilot/turn")
        var request = URLRequest(url: url)
        request.httpMethod = "POST"

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

        let (data, _) = try await URLSession.shared.data(for: request)
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
