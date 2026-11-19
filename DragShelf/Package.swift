// swift-tools-version:5.9
//
// DragShelf — a hidden, edge-activated drag-and-drop shelf for macOS.
//
// Two layers:
//   • DragShelfCore  – Foundation-only logic (activation geometry, hide rules, shelf model,
//                      storage, retention, layout). Builds and is unit-tested on macOS *and* Linux.
//   • DragShelf      – the AppKit/SwiftUI application (macOS only).
//
// The app target is only declared when the manifest is evaluated on macOS, so `swift test`
// works on Linux CI for the core.

import PackageDescription

var products: [Product] = [
    .library(name: "DragShelfCore", targets: ["DragShelfCore"]),
]

var targets: [Target] = [
    .target(name: "DragShelfCore", path: "Sources/DragShelfCore"),
    .testTarget(name: "DragShelfCoreTests", dependencies: ["DragShelfCore"], path: "Tests/DragShelfCoreTests"),
]

#if os(macOS)
products.append(.executable(name: "DragShelf", targets: ["DragShelf"]))
targets.append(
    .executableTarget(
        name: "DragShelf",
        dependencies: ["DragShelfCore"],
        path: "Sources/DragShelf",
        linkerSettings: [
            .linkedFramework("AppKit"),
            .linkedFramework("Carbon"),
            .linkedFramework("QuickLookThumbnailing"),
            .linkedFramework("Quartz"),
            .linkedFramework("ServiceManagement"),
            .linkedFramework("UniformTypeIdentifiers"),
        ]
    )
)
#endif

let package = Package(
    name: "DragShelf",
    platforms: [.macOS(.v13)],
    products: products,
    targets: targets
)
