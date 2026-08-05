import AppKit

/// Non-blocking confirmation prompt for static work. It must not stop the
/// heartbeat loop, otherwise the server would confuse a visible prompt with a
/// disconnected capture client.
@MainActor
final class PresencePromptController {
    private var panel: NSPanel?
    private var currentCheckId: String?
    private var countdownLabel: NSTextField?
    private var countdownTimer: Timer?
    private var deadline = Date()
    private var onChoose: ((String) -> Void)?

    func show(checkId: String, targetTitle: String, secondsRemaining: Int, onChoose: @escaping (String) -> Void) {
        if currentCheckId == checkId, panel?.isVisible == true { return }
        hide()
        currentCheckId = checkId
        self.onChoose = onChoose
        deadline = Date().addingTimeInterval(TimeInterval(max(0, secondsRemaining)))

        let width: CGFloat = 500
        let height: CGFloat = 190
        let screen = NSScreen.main?.visibleFrame ?? .zero
        let panel = NSPanel(
            contentRect: NSRect(
                x: screen.midX - width / 2,
                y: screen.maxY - height - 48,
                width: width,
                height: height
            ),
            styleMask: [.titled, .nonactivatingPanel, .fullSizeContentView],
            backing: .buffered,
            defer: false
        )
        panel.title = "LifeOS Presence Check"
        panel.isFloatingPanel = true
        panel.level = .floating
        panel.collectionBehavior = [.canJoinAllSpaces, .fullScreenAuxiliary]
        panel.hidesOnDeactivate = false
        panel.backgroundColor = NSColor(calibratedWhite: 0.08, alpha: 0.97)
        panel.titlebarAppearsTransparent = true

        let view = PresencePromptView(targetTitle: targetTitle) { [weak self] action in
            self?.onChoose?(action)
            self?.hide()
        }
        countdownLabel = view.countdownLabel
        panel.contentView = view
        panel.orderFrontRegardless()
        self.panel = panel
        updateCountdown()
        countdownTimer = Timer.scheduledTimer(withTimeInterval: 1, repeats: true) { [weak self] _ in
            Task { @MainActor in self?.updateCountdown() }
        }
    }

    private func updateCountdown() {
        let seconds = max(0, Int(ceil(deadline.timeIntervalSinceNow)))
        countdownLabel?.stringValue = seconds > 0
            ? "Guardian pauses in \(seconds)s if unanswered. The interval is currently unscored."
            : "Guardian is paused. The uncertain interval remains unscored."
    }

    func hide() {
        countdownTimer?.invalidate()
        countdownTimer = nil
        panel?.orderOut(nil)
        panel = nil
        currentCheckId = nil
        countdownLabel = nil
        onChoose = nil
    }
}
@MainActor
private final class PresencePromptView: NSView {
    let countdownLabel = NSTextField(wrappingLabelWithString: "")
    private let onChoose: (String) -> Void

    init(targetTitle: String, onChoose: @escaping (String) -> Void) {
        self.onChoose = onChoose
        super.init(frame: NSRect(x: 0, y: 0, width: 500, height: 190))

        let title = NSTextField(wrappingLabelWithString: "Are you still working on “\(targetTitle)”? ")
        title.font = .systemFont(ofSize: 16, weight: .semibold)
        title.textColor = .white
        title.translatesAutoresizingMaskIntoConstraints = false

        let explanation = NSTextField(wrappingLabelWithString: "No interaction was detected for 3 minutes. LifeOS cannot reliably distinguish reading or thinking from being away.")
        explanation.font = .systemFont(ofSize: 12)
        explanation.textColor = NSColor(calibratedWhite: 0.78, alpha: 1)
        explanation.translatesAutoresizingMaskIntoConstraints = false

        countdownLabel.font = .systemFont(ofSize: 11, weight: .medium)
        countdownLabel.textColor = .systemOrange
        countdownLabel.translatesAutoresizingMaskIntoConstraints = false

        let yes = makeButton("Yes, still working", action: "still_working", color: .systemGreen)
        let pause = makeButton("Taking a break", action: "break", color: .systemOrange)
        let end = makeButton("End session", action: "end", color: .systemRed)
        let row = NSStackView(views: [yes, pause, end])
        row.orientation = .horizontal
        row.spacing = 10
        row.distribution = .fillEqually
        row.translatesAutoresizingMaskIntoConstraints = false

        addSubview(title)
        addSubview(explanation)
        addSubview(countdownLabel)
        addSubview(row)
        NSLayoutConstraint.activate([
            title.topAnchor.constraint(equalTo: topAnchor, constant: 18),
            title.leadingAnchor.constraint(equalTo: leadingAnchor, constant: 18),
            title.trailingAnchor.constraint(equalTo: trailingAnchor, constant: -18),
            explanation.topAnchor.constraint(equalTo: title.bottomAnchor, constant: 9),
            explanation.leadingAnchor.constraint(equalTo: title.leadingAnchor),
            explanation.trailingAnchor.constraint(equalTo: title.trailingAnchor),
            countdownLabel.topAnchor.constraint(equalTo: explanation.bottomAnchor, constant: 8),
            countdownLabel.leadingAnchor.constraint(equalTo: title.leadingAnchor),
            countdownLabel.trailingAnchor.constraint(equalTo: title.trailingAnchor),
            row.leadingAnchor.constraint(equalTo: title.leadingAnchor),
            row.trailingAnchor.constraint(equalTo: title.trailingAnchor),
            row.bottomAnchor.constraint(equalTo: bottomAnchor, constant: -16),
            row.heightAnchor.constraint(equalToConstant: 36),
        ])
    }

    @available(*, unavailable)
    required init?(coder: NSCoder) { fatalError("init(coder:) has not been implemented") }

    private func makeButton(_ title: String, action: String, color: NSColor) -> NSButton {
        let button = NSButton(title: title, target: self, action: #selector(buttonClicked(_:)))
        button.identifier = NSUserInterfaceItemIdentifier(action)
        button.bezelStyle = .rounded
        button.contentTintColor = color
        return button
    }

    @objc private func buttonClicked(_ sender: NSButton) {
        guard let action = sender.identifier?.rawValue else { return }
        onChoose(action)
    }
}
