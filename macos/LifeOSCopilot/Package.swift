// swift-tools-version: 6.0
import PackageDescription

let package = Package(
    name: "LifeOSCopilot",
    platforms: [.macOS(.v14)],
    products: [
        .executable(name: "LifeOSCopilot", targets: ["LifeOSCopilot"])
    ],
    targets: [
        .executableTarget(name: "LifeOSCopilot")
    ]
)
