import UIKit
import WebKit

/// Hosts the bundled web app (www/) and exposes native Bluetooth to it as window.FahisNative,
/// the same contract the Android shell uses (see obd-scanner/src/transport-native.js).
final class WebViewController: UIViewController, WKNavigationDelegate, WKScriptMessageHandler {
    static let scheme = "fahis"

    private var webView: WKWebView!
    private lazy var bluetooth = BLEBridge { [weak self] js in
        self?.webView.evaluateJavaScript(js, completionHandler: nil)
    }

    override func loadView() {
        let config = WKWebViewConfiguration()
        config.setURLSchemeHandler(AssetSchemeHandler(), forURLScheme: Self.scheme)

        let bridge = """
        (function () {
          var post = function (m) { window.webkit.messageHandlers.fahis.postMessage(m); };
          window.FahisNative = {
            platform: 'ios',
            scan: function () { post({ op: 'scan' }); },
            connect: function (address, kind) { post({ op: 'connect', address: String(address), kind: String(kind) }); },
            write: function (data) { post({ op: 'write', data: String(data) }); },
            disconnect: function () { post({ op: 'disconnect' }); },
            saveFile: function (name, content) { post({ op: 'saveFile', name: String(name), content: String(content) }); }
          };
        })();
        """
        let controller = config.userContentController
        controller.addUserScript(WKUserScript(source: bridge, injectionTime: .atDocumentStart, forMainFrameOnly: true))
        controller.add(WeakMessageHandler(self), name: "fahis")

        webView = WKWebView(frame: .zero, configuration: config)
        webView.navigationDelegate = self
        webView.isOpaque = false
        webView.backgroundColor = UIColor(red: 0x0d / 255, green: 0x11 / 255, blue: 0x17 / 255, alpha: 1)
        webView.scrollView.contentInsetAdjustmentBehavior = .never
        view = webView
    }

    override func viewDidLoad() {
        super.viewDidLoad()
        webView.load(URLRequest(url: URL(string: "\(Self.scheme)://app/index.html")!))
    }

    // Only our bundled pages may load: the bridge must never be reachable by other content.
    func webView(_ webView: WKWebView, decidePolicyFor action: WKNavigationAction,
                 decisionHandler: @escaping (WKNavigationActionPolicy) -> Void) {
        decisionHandler(action.request.url?.scheme == Self.scheme ? .allow : .cancel)
    }

    func userContentController(_ controller: WKUserContentController, didReceive message: WKScriptMessage) {
        guard message.frameInfo.isMainFrame,
              message.frameInfo.request.url?.scheme == Self.scheme,
              let body = message.body as? [String: Any],
              let op = body["op"] as? String else { return }
        switch op {
        case "scan": bluetooth.scan()
        case "connect": bluetooth.connect(identifier: body["address"] as? String ?? "")
        case "write": bluetooth.write(body["data"] as? String ?? "")
        case "disconnect": bluetooth.disconnect()
        case "saveFile": share(name: body["name"] as? String ?? "fahis.csv", content: body["content"] as? String ?? "")
        default: break
        }
    }

    private func share(name: String, content: String) {
        let safe = String(name.map { $0.isLetter || $0.isNumber || "._-".contains($0) ? $0 : "_" }.prefix(80))
        let url = FileManager.default.temporaryDirectory.appendingPathComponent(safe.isEmpty ? "fahis.csv" : safe)
        do {
            try content.write(to: url, atomically: true, encoding: .utf8)
        } catch {
            return
        }
        let sheet = UIActivityViewController(activityItems: [url], applicationActivities: nil)
        sheet.popoverPresentationController?.sourceView = view
        present(sheet, animated: true)
    }
}

/// Breaks the WKUserContentController -> handler retain cycle.
private final class WeakMessageHandler: NSObject, WKScriptMessageHandler {
    weak var target: WKScriptMessageHandler?
    init(_ target: WKScriptMessageHandler) { self.target = target }
    func userContentController(_ c: WKUserContentController, didReceive m: WKScriptMessage) {
        target?.userContentController(c, didReceive: m)
    }
}

/// Serves files from the app bundle's www/ folder at fahis://app/...
final class AssetSchemeHandler: NSObject, WKURLSchemeHandler {
    private let root: URL = Bundle.main.url(forResource: "www", withExtension: nil)!.standardizedFileURL

    private static let types: [String: String] = [
        "html": "text/html; charset=utf-8", "js": "text/javascript; charset=utf-8",
        "css": "text/css; charset=utf-8", "svg": "image/svg+xml", "png": "image/png",
        "json": "application/json", "webmanifest": "application/manifest+json",
    ]

    func webView(_ webView: WKWebView, start task: WKURLSchemeTask) {
        guard let url = task.request.url else { return }
        var path = url.path
        if path.isEmpty || path == "/" { path = "/index.html" }
        let file = root.appendingPathComponent(String(path.dropFirst())).standardizedFileURL
        // Refuse anything that escapes www/ (e.g. ../).
        guard file.path.hasPrefix(root.path + "/"), let data = try? Data(contentsOf: file) else {
            let notFound = HTTPURLResponse(url: url, statusCode: 404, httpVersion: "HTTP/1.1", headerFields: nil)!
            task.didReceive(notFound)
            task.didFinish()
            return
        }
        let type = Self.types[file.pathExtension.lowercased()] ?? "application/octet-stream"
        let response = HTTPURLResponse(url: url, statusCode: 200, httpVersion: "HTTP/1.1",
                                       headerFields: ["Content-Type": type, "Content-Length": "\(data.count)"])!
        task.didReceive(response)
        task.didReceive(data)
        task.didFinish()
    }

    func webView(_ webView: WKWebView, stop task: WKURLSchemeTask) {}
}
