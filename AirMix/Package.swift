// swift-tools-version:5.9
// AirMix — per-application audio mixer for macOS.
//
// Targets
//   AirMixDSP    C, real-time audio kernel (portable; unit-tested on macOS and Linux)
//   AirMixCore   Swift, models / EQ design / ducking / profiles / persistence (portable)
//   AirMixAudio  Swift, Core Audio process taps, devices, engine (macOS only)
//   AirMix       SwiftUI menu-bar app (macOS only)

import PackageDescription

var targets: [Target] = [
    .target(
        name: "AirMixDSP",
        path: "Sources/AirMixDSP",
        linkerSettings: [.linkedFramework("CoreAudio", .when(platforms: [.macOS]))]
    ),
    .target(name: "AirMixCore", dependencies: ["AirMixDSP"], path: "Sources/AirMixCore"),
    .testTarget(name: "AirMixDSPTests", dependencies: ["AirMixDSP"], path: "Tests/AirMixDSPTests"),
    .testTarget(name: "AirMixCoreTests", dependencies: ["AirMixCore"], path: "Tests/AirMixCoreTests"),
]
var products: [Product] = [.library(name: "AirMixCore", targets: ["AirMixCore"])]

#if os(macOS)
targets += [
    .target(
        name: "AirMixAudio",
        dependencies: ["AirMixCore", "AirMixDSP"],
        path: "Sources/AirMixAudio",
        linkerSettings: [
            .linkedFramework("CoreAudio"),
            .linkedFramework("AudioToolbox"),
            .linkedFramework("AppKit"),
        ]
    ),
    .executableTarget(
        name: "AirMix",
        dependencies: ["AirMixAudio", "AirMixCore"],
        path: "Sources/AirMix",
        linkerSettings: [
            .linkedFramework("Carbon"),
            .linkedFramework("ServiceManagement"),
        ]
    ),
]
products.append(.executable(name: "AirMix", targets: ["AirMix"]))
#endif

let package = Package(
    name: "AirMix",
    platforms: [.macOS("14.2")],
    products: products,
    targets: targets
)
