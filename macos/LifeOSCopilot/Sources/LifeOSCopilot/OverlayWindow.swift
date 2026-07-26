import AppKit

final class OverlayWindow: NSWindow {
    private let overlayView = OverlayView()
    private var dismissTask: Task<Void, Never>?

    init() {
        let screenFrame = NSScreen.main?.frame ?? .zero
        super.init(contentRect: screenFrame, styleMask: [.borderless], backing: .buffered, defer: false)
        isOpaque = false
        backgroundColor = .clear
        ignoresMouseEvents = true
        level = .screenSaver
        collectionBehavior = [.canJoinAllSpaces, .fullScreenAuxiliary, .stationary]
        contentView = overlayView
        orderOut(nil)
    }

    func show(callouts: [CopilotCallout], message: String?) {
        dismissTask?.cancel()
        setFrame(NSScreen.main?.frame ?? frame, display: true)
        overlayView.update(callouts: callouts, message: message)
        orderFrontRegardless()
        dismissTask = Task { [weak self] in
            try? await Task.sleep(for: .seconds(12))
            guard !Task.isCancelled else { return }
            await MainActor.run {
                self?.hideOverlay()
            }
        }
    }

    func hideOverlay() {
        dismissTask?.cancel()
        dismissTask = nil
        orderOut(nil)
    }
}

final class OverlayView: NSView {
    private var callouts: [CopilotCallout] = []
    private var message: String?

    override var isFlipped: Bool { true }

    func update(callouts: [CopilotCallout], message: String?) {
        self.callouts = callouts
        self.message = message
        needsDisplay = true
    }

    override func draw(_ dirtyRect: NSRect) {
        super.draw(dirtyRect)
        NSColor.clear.setFill()
        dirtyRect.fill()

        if let message, !message.isEmpty {
            drawMessage(message)
        }

        for callout in callouts {
            drawCallout(callout)
        }
    }

    private func drawMessage(_ text: String) {
        let maxWidth: CGFloat = 520
        let attributes: [NSAttributedString.Key: Any] = [
            .font: NSFont.systemFont(ofSize: 15, weight: .medium),
            .foregroundColor: NSColor.white
        ]
        let attributed = NSAttributedString(string: text, attributes: attributes)
        let rect = NSRect(x: (bounds.width - maxWidth) / 2, y: bounds.height - 120, width: maxWidth, height: 72)
        NSColor(calibratedWhite: 0.05, alpha: 0.88).setFill()
        NSBezierPath(roundedRect: rect, xRadius: 12, yRadius: 12).fill()
        attributed.draw(in: rect.insetBy(dx: 18, dy: 16))
    }

    private func drawCallout(_ callout: CopilotCallout) {
        let rect = NSRect(
            x: callout.x,
            y: callout.y,
            width: max(callout.width ?? 140, 18),
            height: max(callout.height ?? 42, 18)
        )

        NSColor.systemBlue.withAlphaComponent(0.18).setFill()
        NSColor.systemBlue.setStroke()
        let path = NSBezierPath(roundedRect: rect, xRadius: 7, yRadius: 7)
        path.lineWidth = 3
        path.fill()
        path.stroke()

        let labelRect = NSRect(x: rect.minX, y: max(12, rect.minY - 34), width: max(160, rect.width), height: 28)
        NSColor(calibratedWhite: 0.04, alpha: 0.9).setFill()
        NSBezierPath(roundedRect: labelRect, xRadius: 8, yRadius: 8).fill()

        let attrs: [NSAttributedString.Key: Any] = [
            .font: NSFont.systemFont(ofSize: 12, weight: .semibold),
            .foregroundColor: NSColor.white
        ]
        NSAttributedString(string: callout.label, attributes: attrs).draw(in: labelRect.insetBy(dx: 10, dy: 6))
    }
}
