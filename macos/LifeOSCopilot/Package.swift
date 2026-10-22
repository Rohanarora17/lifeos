// swift-tools-version: 6.0
import PackageDescription

let package = Package(
    name: "LifeOSCopilot",
    platforms: [.macOS(.v14)],
    products: [
        .executable(name: "LifeOSCopilot", targets: ["LifeOSCopilot"])
    ],
    targets: [
        .target(name: "StudyChatCore"),
        .executableTarget(name: "LifeOSCopilot", dependencies: ["StudyChatCore"]),
        .executableTarget(name: "StudyChatCoreTests", dependencies: ["StudyChatCore"], path: "Tests/StudyChatCoreTests")
    ]
)
