import Foundation

/// Listens to the service's live events natively.
///
/// The HUD's web page is paused by macOS while its window is hidden, so it noticed "Hey JARVIS" late
/// (the HUD appeared when JARVIS started talking). The app listens itself and shows the HUD the moment
/// the wake word fires. Loopback only; reconnects after a service restart.
final class EventStream {
    private let url: URL
    private var task: URLSessionWebSocketTask?
    private var stopped = true
    var onEvent: (([String: Any]) -> Void)?

    init(port: Int, token: String) {
        var comps = URLComponents()
        comps.scheme = "ws"
        comps.host = "127.0.0.1"
        comps.port = port
        comps.path = "/api/events"
        comps.queryItems = [URLQueryItem(name: "token", value: token)]
        url = comps.url!
    }

    func start() {
        guard stopped else { return }
        stopped = false
        connect()
    }

    func stop() {
        stopped = true
        task?.cancel(with: .goingAway, reason: nil)
        task = nil
    }

    private func connect() {
        guard !stopped else { return }
        let t = URLSession.shared.webSocketTask(with: url)
        task = t
        t.resume()
        receive(t)
    }

    private func receive(_ t: URLSessionWebSocketTask) {
        t.receive { [weak self] result in
            guard let self = self, t === self.task else { return }
            switch result {
            case .success(let message):
                var data: Data?
                switch message {
                case .string(let s): data = s.data(using: .utf8)
                case .data(let d): data = d
                @unknown default: data = nil
                }
                if let d = data, let obj = (try? JSONSerialization.jsonObject(with: d)) as? [String: Any] {
                    DispatchQueue.main.async { self.onEvent?(obj) }
                }
                self.receive(t)
            case .failure:
                DispatchQueue.main.asyncAfter(deadline: .now() + 1.0) { [weak self] in
                    guard let self = self, t === self.task else { return }
                    self.connect()
                }
            }
        }
    }
}
