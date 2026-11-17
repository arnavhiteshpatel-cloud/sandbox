import Foundation

/// Starts and supervises the bundled Python service (`python -m jarvis serve`).
/// Restarts it with backoff if it crashes; stops it cleanly when the app quits.
final class Daemon {
    let port: Int
    let token: String
    private var process: Process?
    private var quitting = false
    private var restarts: [Date] = []
    private var generation = 0   // ignores termination of processes we already replaced or stopped
    var onReady: (() -> Void)?
    var onStatus: ((String) -> Void)?

    init(port: Int = 47823) {
        self.port = port
        var bytes = [UInt8](repeating: 0, count: 32)
        _ = SecRandomCopyBytes(kSecRandomDefault, bytes.count, &bytes)
        self.token = Data(bytes).base64EncodedString()
            .replacingOccurrences(of: "+", with: "-").replacingOccurrences(of: "/", with: "_").replacingOccurrences(of: "=", with: "")
    }

    var baseURL: URL { URL(string: "http://127.0.0.1:\(port)")! }

    /// Bundled interpreter (Contents/Resources/python) or, for development, JARVIS_PYTHON / python3 on PATH.
    private func pythonCommand() -> (URL, [String]) {
        if let res = Bundle.main.resourceURL {
            let bundled = res.appendingPathComponent("python/bin/python3")
            if FileManager.default.isExecutableFile(atPath: bundled.path) {
                return (bundled, ["-m", "jarvis", "serve", "--port", "\(port)"])
            }
        }
        if let custom = ProcessInfo.processInfo.environment["JARVIS_PYTHON"] {
            return (URL(fileURLWithPath: custom), ["-m", "jarvis", "serve", "--port", "\(port)"])
        }
        return (URL(fileURLWithPath: "/usr/bin/env"), ["python3", "-m", "jarvis", "serve", "--port", "\(port)"])
    }

    func start() {
        quitting = false
        let (exe, args) = pythonCommand()
        let p = Process()
        p.executableURL = exe
        p.arguments = args
        var env = ProcessInfo.processInfo.environment
        env["JARVIS_TOKEN"] = token
        env["PYTHONNOUSERSITE"] = "1"
        env["PYTHONUNBUFFERED"] = "1"
        // Never write .pyc files into the signed bundle (would break its code signature).
        env["PYTHONPYCACHEPREFIX"] = FileManager.default.homeDirectoryForCurrentUser.appendingPathComponent("Library/Caches/JARVIS/pycache").path
        env["PATH"] = "/usr/bin:/bin:/usr/sbin:/sbin:/opt/homebrew/bin:/usr/local/bin"
        env.removeValue(forKey: "PYTHONPATH")
        p.environment = env
        let logDir = FileManager.default.homeDirectoryForCurrentUser.appendingPathComponent("Library/Logs/JARVIS")
        try? FileManager.default.createDirectory(at: logDir, withIntermediateDirectories: true)
        let logURL = logDir.appendingPathComponent("daemon.log")
        if !FileManager.default.fileExists(atPath: logURL.path) {
            _ = FileManager.default.createFile(atPath: logURL.path, contents: nil)
        }
        if let fh = try? FileHandle(forWritingTo: logURL) {
            fh.seekToEndOfFile()
            p.standardOutput = fh
            p.standardError = fh
        }
        generation += 1
        let myGeneration = generation
        p.terminationHandler = { [weak self] proc in
            DispatchQueue.main.async {
                guard let self = self, !self.quitting, myGeneration == self.generation else { return }
                self.crashed(code: proc.terminationStatus)
            }
        }
        do {
            try p.run()
            process = p
            onStatus?("starting")
            waitUntilHealthy(deadline: Date().addingTimeInterval(60))
        } catch {
            onStatus?("failed to start: \(error.localizedDescription)")
        }
    }

    private func crashed(code: Int32) {
        let now = Date()
        restarts = restarts.filter { now.timeIntervalSince($0) < 300 } + [now]
        if restarts.count > 5 {
            onStatus?("stopped after repeated crashes (exit \(code)). See ~/Library/Logs/JARVIS/daemon.log")
            return
        }
        let delay = pow(2.0, Double(restarts.count - 1))
        onStatus?("restarting in \(Int(delay))s")
        DispatchQueue.main.asyncAfter(deadline: .now() + delay) { [weak self] in self?.start() }
    }

    private func waitUntilHealthy(deadline: Date) {
        var req = URLRequest(url: baseURL.appendingPathComponent("health"))
        req.timeoutInterval = 1
        URLSession.shared.dataTask(with: req) { [weak self] _, resp, _ in
            guard let self = self else { return }
            if (resp as? HTTPURLResponse)?.statusCode == 200 {
                DispatchQueue.main.async { self.onStatus?("ready"); self.onReady?() }
            } else if Date() < deadline, !self.quitting {
                DispatchQueue.global().asyncAfter(deadline: .now() + 0.4) { self.waitUntilHealthy(deadline: deadline) }
            } else {
                DispatchQueue.main.async { self.onStatus?("not responding") }
            }
        }.resume()
    }

    func stop() {
        quitting = true
        generation += 1
        guard let p = process, p.isRunning else { return }
        p.terminate()  // SIGTERM: the service unloads models and closes the database cleanly
        let deadline = Date().addingTimeInterval(4)
        while p.isRunning && Date() < deadline { usleep(50_000) }
        if p.isRunning {
            kill(p.processIdentifier, SIGKILL)
            p.waitUntilExit()  // the port must be free before a restart
        }
    }

    // MARK: API

    func post(_ path: String, _ body: [String: Any] = [:]) {
        var req = URLRequest(url: baseURL.appendingPathComponent(path))
        req.httpMethod = "POST"
        req.setValue(token, forHTTPHeaderField: "X-Jarvis-Token")
        req.setValue("application/json", forHTTPHeaderField: "Content-Type")
        req.httpBody = try? JSONSerialization.data(withJSONObject: body)
        req.timeoutInterval = 5
        URLSession.shared.dataTask(with: req).resume()
    }
}
