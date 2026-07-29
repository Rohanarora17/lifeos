import AppKit

/// Clickable on-screen prompt for ambiguous native-app classification during focus sessions.
@MainActor
final class ClassificationPromptController {
    private var panel: NSPanel?
    private var currentApp: String?
    private var onChoose: ((String) -> Void)?

    var isVisible: Bool { panel?.isVisible == true }

    func show(app: String, sessionTitle: String, reason: String, onChoose: @escaping (String) -> Void) {
        // Refresh in place if already showing same app
        if isVisible, currentApp?.lowercased() == app.lowercased() {
            self.onChoose = onChoose
            return
        }
        hide()
        self.currentApp = app
        self.onChoose = onChoose

        let width: CGFloat = 420
        let height: CGFloat = 168
        let screen = NSScreen.main?.visibleFrame ?? .zero
        let origin = NSPoint(
            x: screen.midX - width / 2,
            y: screen.maxY - height - 48
        )

        let panel = NSPanel(
            contentRect: NSRect(origin: origin, size: NSSize(width: width, height: height)),
            styleMask: [.titled, .nonactivatingPanel, .fullSizeContentView],
            backing: .buffered,
            defer: false
        )
        panel.title = "LifeOS"
        panel.isFloatingPanel = true
        panel.level = .floating
        panel.collectionBehavior = [.canJoinAllSpaces, .fullScreenAuxiliary]
        panel.isMovableByWindowBackground = true
        panel.hidesOnDeactivate = false
        panel.backgroundColor = NSColor(calibratedWhite: 0.08, alpha: 0.96)
        panel.titlebarAppearsTransparent = true

        let content = ClassificationPromptView(
            app: app,
            sessionTitle: sessionTitle,
            reason: reason
        ) { [weak self] category in
            self?.onChoose?(category)
            self?.hide()
        }
        panel.contentView = content
        panel.orderFrontRegardless()
        self.panel = panel
    }

    func hide() {
        panel?.orderOut(nil)
        panel = nil
        currentApp = nil
        onChoose = nil
    }
}

@MainActor
private final class ClassificationPromptView: NSView {
    private let onChoose: (String) -> Void

    init(app: String, sessionTitle: String, reason: String, onChoose: @escaping (String) -> Void) {
        self.onChoose = onChoose
        super.init(frame: NSRect(x: 0, y: 0, width: 420, height: 168))
        wantsLayer = true

        let title = NSTextField(labelWithString: "Classify \(app)")
        title.font = .systemFont(ofSize: 15, weight: .semibold)
        title.textColor = .white
        title.translatesAutoresizingMaskIntoConstraints = false

        let subtitle = NSTextField(wrappingLabelWithString: "During: \(sessionTitle)\n\(reason)")
        subtitle.font = .systemFont(ofSize: 12, weight: .regular)
        subtitle.textColor = NSColor(calibratedWhite: 0.78, alpha: 1)
        subtitle.maximumNumberOfLines = 3
        subtitle.translatesAutoresizingMaskIntoConstraints = false

        let productive = makeButton(title: "Productive", color: NSColor.systemGreen, category: "productive")
        let neutral = makeButton(title: "Neutral", color: NSColor.systemYellow, category: "neutral")
        let distraction = makeButton(title: "Distraction", color: NSColor.systemRed, category: "distraction")

        let row = NSStackView(views: [productive, neutral, distraction])
        row.orientation = .horizontal
        row.spacing = 10
        row.distribution = .fillEqually
        row.translatesAutoresizingMaskIntoConstraints = false

        addSubview(title)
        addSubview(subtitle)
        addSubview(row)

        NSLayoutConstraint.activate([
            title.topAnchor.constraint(equalTo: topAnchor, constant: 14),
            title.leadingAnchor.constraint(equalTo: leadingAnchor, constant: 16),
            title.trailingAnchor.constraint(equalTo: trailingAnchor, constant: -16),

            subtitle.topAnchor.constraint(equalTo: title.bottomAnchor, constant: 8),
            subtitle.leadingAnchor.constraint(equalTo: leadingAnchor, constant: 16),
            subtitle.trailingAnchor.constraint(equalTo: trailingAnchor, constant: -16),

            row.leadingAnchor.constraint(equalTo: leadingAnchor, constant: 16),
            row.trailingAnchor.constraint(equalTo: trailingAnchor, constant: -16),
            row.bottomAnchor.constraint(equalTo: bottomAnchor, constant: -16),
            row.heightAnchor.constraint(equalToConstant: 36),
        ])
    }

    @available(*, unavailable)
    required init?(coder: NSCoder) { fatalError("init(coder:) has not been implemented") }

    private func makeButton(title: String, color: NSColor, category: String) -> NSButton {
        let button = NSButton(title: title, target: self, action: #selector(buttonClicked(_:)))
        button.bezelStyle = .rounded
        button.isBordered = true
        button.font = .systemFont(ofSize: 12, weight: .semibold)
        button.contentTintColor = color
        button.identifier = NSUserInterfaceItemIdentifier(category)
        button.setButtonType(.momentaryPushIn)
        return button
    }

    @objc private func buttonClicked(_ sender: NSButton) {
        guard let category = sender.identifier?.rawValue else { return }
        onChoose(category)
    }
}
