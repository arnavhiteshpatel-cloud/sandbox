import Foundation
import Combine
import DragShelfCore

/// Persists `DragShelfSettings` in UserDefaults as one JSON value.
final class SettingsStore: ObservableObject {
    static let defaultsKey = "DragShelf.settings.v1"

    @Published var settings: DragShelfSettings {
        didSet {
            // Assigning inside didSet does not re-trigger the observer.
            let clamped = settings.clamped()
            if clamped != settings { settings = clamped }
            save()
        }
    }

    private let defaults: UserDefaults

    init(defaults: UserDefaults = .standard) {
        self.defaults = defaults
        if let data = defaults.data(forKey: Self.defaultsKey),
           let s = try? JSONDecoder().decode(DragShelfSettings.self, from: data) {
            settings = s.clamped()
        } else {
            settings = DragShelfSettings()
        }
    }

    private func save() {
        if let data = try? JSONEncoder().encode(settings) {
            defaults.set(data, forKey: Self.defaultsKey)
        }
    }

    func resetToDefaults() {
        settings = DragShelfSettings()
    }
}
