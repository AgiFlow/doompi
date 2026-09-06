// swift-tools-version: 6.0
import PackageDescription

let package = Package(
    name: "DoomPiComputerUse",
    platforms: [.macOS(.v15)],
    products: [.executable(name: "doompi-computer-use-helper", targets: ["DoomPiComputerUse"])],
    targets: [
        .target(name: "DoomPiComputerUseCore"),
        .executableTarget(name: "DoomPiComputerUse", dependencies: ["DoomPiComputerUseCore"]),
        .testTarget(name: "DoomPiComputerUseCoreTests", dependencies: ["DoomPiComputerUseCore"]),
    ]
)
