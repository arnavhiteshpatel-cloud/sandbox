import AppKit
import WebKit

/// A WKWebView that accepts the first click even in a non-activating panel (HUD Yes/No buttons).
final class ClickThroughWebView: WKWebView {
    override func acceptsFirstMouse(for event: NSEvent?) -> Bool { true }
}

/// Builds web views that load the local UI with the API token injected (never in the URL).
final class WebFactory: NSObject, WKScriptMessageHandler, WKNavigationDelegate {
    let daemon: Daemon
    var onMessage: (([String: Any]) -> Void)?

    init(daemon: Daemon) { self.daemon = daemon }

    func make(view: String, transparent: Bool = false, hash: String = "") -> WKWebView {
        let cfg = WKWebViewConfiguration()
        cfg.websiteDataStore = .nonPersistent()
        let ucc = WKUserContentController()
        let tokenJS = "window.JARVIS_TOKEN = \(jsString(daemon.token));"
        ucc.addUserScript(WKUserScript(source: tokenJS, injectionTime: .atDocumentStart, forMainFrameOnly: true))
        ucc.add(WeakHandler(self), name: "jarvis")
        cfg.userContentController = ucc
        let wv = ClickThroughWebView(frame: .zero, configuration: cfg)
        wv.navigationDelegate = self
        if transparent { wv.setValue(false, forKey: "drawsBackground") }
        var comps = URLComponents(url: daemon.baseURL.appendingPathComponent("ui/index.html"), resolvingAgainstBaseURL: false)!
        comps.queryItems = [URLQueryItem(name: "view", value: view)]
        if !hash.isEmpty { comps.fragment = hash }
        wv.load(URLRequest(url: comps.url!))
        return wv
    }

    func userContentController(_ ucc: WKUserContentController, didReceive message: WKScriptMessage) {
        if let body = message.body as? [String: Any] { onMessage?(body) }
    }

    /// Only the local UI may load inside JARVIS; any other link opens in the default browser.
    func webView(_ webView: WKWebView, decidePolicyFor action: WKNavigationAction, decisionHandler: @escaping (WKNavigationActionPolicy) -> Void) {
        guard let url = action.request.url else { return decisionHandler(.cancel) }
        if url.host == "127.0.0.1" && url.port == daemon.port { return decisionHandler(.allow) }
        if url.scheme == "about" { return decisionHandler(.allow) }
        NSWorkspace.shared.open(url)
        decisionHandler(.cancel)
    }

    private func jsString(_ s: String) -> String {
        let data = try! JSONSerialization.data(withJSONObject: [s])
        let arr = String(data: data, encoding: .utf8)!
        return String(arr.dropFirst().dropLast())
    }
}

/// Avoids the WKUserContentController -> handler retain cycle.
final class WeakHandler: NSObject, WKScriptMessageHandler {
    weak var target: WKScriptMessageHandler?
    init(_ t: WKScriptMessageHandler) { target = t }
    func userContentController(_ c: WKUserContentController, didReceive m: WKScriptMessage) { target?.userContentController(c, didReceive: m) }
}
