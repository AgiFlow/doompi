import AppKit
import ApplicationServices
import AVFoundation
import CoreGraphics
import DoomPiComputerUseCore
import Foundation
import ScreenCaptureKit

struct JSONValue: Encodable {
    let value: Any
    func encode(to encoder: Encoder) throws {
        var container = encoder.singleValueContainer()
        switch value {
        case let value as String: try container.encode(value)
        case let value as Int: try container.encode(value)
        case let value as Bool: try container.encode(value)
        case let value as [JSONValue]: try container.encode(value)
        case let value as [String: JSONValue]: try container.encode(value)
        default: try container.encodeNil()
        }
    }
}

func emit(_ result: Any) {
    let data = try! JSONEncoder().encode(["ok": JSONValue(value: true), "result": JSONValue(value: result)])
    print(String(decoding: data, as: UTF8.self))
    fflush(stdout)
}

func fail(_ error: Error) -> Never {
    let message = (error as? LocalizedError)?.errorDescription ?? String(describing: error)
    let data = try! JSONEncoder().encode(["ok": JSONValue(value: false), "error": JSONValue(value: message)])
    FileHandle.standardOutput.write(data)
    FileHandle.standardOutput.write(Data("\n".utf8))
    exit(1)
}

func input<T: Decodable>(_ type: T.Type) throws -> T {
    try JSONDecoder().decode(type, from: FileHandle.standardInput.readDataToEndOfFile())
}

func axValue(_ element: AXUIElement, _ attribute: String) -> CFTypeRef? {
    var value: CFTypeRef?
    guard AXUIElementCopyAttributeValue(element, attribute as CFString, &value) == .success else { return nil }
    return value
}

func axString(_ element: AXUIElement, _ attribute: String) -> String? { axValue(element, attribute) as? String }

func axBool(_ element: AXUIElement, _ attribute: String) -> Bool {
    (axValue(element, attribute) as? NSNumber)?.boolValue == true
}

func axFrame(_ element: AXUIElement) -> CGRect? {
    guard let positionValue = axValue(element, kAXPositionAttribute),
          let sizeValue = axValue(element, kAXSizeAttribute),
          CFGetTypeID(positionValue) == AXValueGetTypeID(),
          CFGetTypeID(sizeValue) == AXValueGetTypeID() else { return nil }
    var position = CGPoint.zero
    var size = CGSize.zero
    guard AXValueGetValue(positionValue as! AXValue, .cgPoint, &position),
          AXValueGetValue(sizeValue as! AXValue, .cgSize, &size) else { return nil }
    return CGRect(origin: position, size: size)
}

func axActions(_ element: AXUIElement) -> [String] {
    var names: CFArray?
    guard AXUIElementCopyActionNames(element, &names) == .success else { return [] }
    return names as? [String] ?? []
}

func targetElement(_ target: Target) throws -> AXUIElement {
    guard AXIsProcessTrusted() else { throw ProtocolError.invalid("Accessibility permission is not granted.") }
    guard let windowNumber = UInt32(target.windowId) else { throw ProtocolError.invalid("The verified target window id is invalid.") }
    let windowInfo = CGWindowListCopyWindowInfo([.optionIncludingWindow, .excludeDesktopElements], CGWindowID(windowNumber)) as? [[String: Any]] ?? []
    guard windowInfo.count == 1,
          let current = windowInfo.first,
          current[kCGWindowOwnerPID as String] as? Int32 == target.processId,
          current[kCGWindowName as String] as? String == target.windowTitle,
          let bounds = current[kCGWindowBounds as String] as? NSDictionary,
          let expectedFrame = CGRect(dictionaryRepresentation: bounds) else {
        throw ProtocolError.invalid("The verified target window identity changed.")
    }
    guard let running = NSRunningApplication(processIdentifier: target.processId),
          running.bundleIdentifier == target.bundleId, running.localizedName == target.applicationName else {
        throw ProtocolError.invalid("The verified target application identity changed.")
    }
    let app = AXUIElementCreateApplication(target.processId)
    guard let windows = axValue(app, kAXWindowsAttribute) as? [AXUIElement] else {
        throw ProtocolError.invalid("The target application has no accessible windows.")
    }
    let matches = windows.filter {
        guard axString($0, kAXTitleAttribute) == target.windowTitle, let frame = axFrame($0) else { return false }
        return abs(frame.origin.x - expectedFrame.origin.x) <= 2 && abs(frame.origin.y - expectedFrame.origin.y) <= 2 &&
            abs(frame.size.width - expectedFrame.size.width) <= 2 && abs(frame.size.height - expectedFrame.size.height) <= 2
    }
    guard matches.count == 1, let window = matches.first else {
        throw ProtocolError.invalid("The verified target window is no longer uniquely available.")
    }
    return window
}

func discoverTargets() throws -> [[String: JSONValue]] {
    guard AXIsProcessTrusted() else { throw ProtocolError.invalid("Accessibility permission is not granted.") }
    guard CGPreflightScreenCaptureAccess() else { throw ProtocolError.invalid("Screen Recording permission is not granted.") }
    let info = CGWindowListCopyWindowInfo([.optionOnScreenOnly, .excludeDesktopElements], kCGNullWindowID) as? [[String: Any]] ?? []
    var seen = Set<String>()
    return info.compactMap { window in
        guard let pid = window[kCGWindowOwnerPID as String] as? Int32,
              let windowId = window[kCGWindowNumber as String] as? Int,
              let title = window[kCGWindowName as String] as? String, !title.isEmpty,
              let app = NSRunningApplication(processIdentifier: pid),
              let bundleId = app.bundleIdentifier, let name = app.localizedName,
              let axWindows = axValue(AXUIElementCreateApplication(pid), kAXWindowsAttribute) as? [AXUIElement],
              axWindows.contains(where: { axString($0, kAXTitleAttribute) == title }),
              info.filter({ ($0[kCGWindowOwnerPID as String] as? Int32) == pid && ($0[kCGWindowName as String] as? String) == title }).count == 1,
              seen.insert("\(pid):\(windowId)").inserted else { return nil }
        return [
            "bundleId": JSONValue(value: bundleId), "applicationName": JSONValue(value: name),
            "processId": JSONValue(value: Int(pid)), "windowId": JSONValue(value: String(windowId)),
            "windowTitle": JSONValue(value: title),
        ]
    }
}

func children(_ element: AXUIElement) -> [AXUIElement] { axValue(element, kAXChildrenAttribute) as? [AXUIElement] ?? [] }

func stableHash(_ value: String) -> String {
    var hash: UInt64 = 14_695_981_039_346_656_037
    for byte in value.utf8 { hash = (hash ^ UInt64(byte)) &* 1_099_511_628_211 }
    return String(hash, radix: 16)
}

func semanticObservation(target: Target) throws -> [String: JSONValue] {
    let root = try targetElement(target)
    var nodes: [[String: JSONValue]] = []
    var signature = "\(target.processId)|\(target.windowId)|\(target.windowTitle)"
    func visit(_ element: AXUIElement, path: [Int], depth: Int) {
        guard nodes.count < maximumObservedElements, depth <= maximumObservationDepth else { return }
        let role = axString(element, kAXRoleAttribute) ?? "unknown"
        let subrole = axString(element, kAXSubroleAttribute)
        let secure = role == "AXSecureTextField" || subrole == "AXSecureTextField" || axBool(element, "AXProtectedContent")
        let title = axString(element, kAXTitleAttribute)
        let description = axString(element, kAXDescriptionAttribute)
        var node = [String: JSONValue](
            uniqueKeysWithValues: [
                ("ref", JSONValue(value: path.map(String.init).joined(separator: "."))),
                ("role", JSONValue(value: role)),
                ("enabled", JSONValue(value: axBool(element, kAXEnabledAttribute))),
                ("secure", JSONValue(value: secure)),
            ])
        if let label = title ?? description { node["label"] = JSONValue(value: String(label.prefix(2048))) }
        if !secure, let value = axString(element, kAXValueAttribute) {
            node["value"] = JSONValue(value: String(value.prefix(2048)))
        }
        let nativeActions = axActions(element)
        var actions: [JSONValue] = []
        if nativeActions.contains(kAXPressAction) { actions.append(JSONValue(value: "press")) }
        var valueSettable = DarwinBoolean(false)
        if !secure, AXUIElementIsAttributeSettable(element, kAXValueAttribute as CFString, &valueSettable) == .success,
           valueSettable.boolValue { actions.append(JSONValue(value: "set_value")) }
        var focusSettable = DarwinBoolean(false)
        if !secure, AXUIElementIsAttributeSettable(element, kAXFocusedAttribute as CFString, &focusSettable) == .success,
           focusSettable.boolValue { actions.append(JSONValue(value: "focus")) }
        if nativeActions.contains(where: { $0.hasPrefix("AXScroll") }) { actions.append(JSONValue(value: "scroll")) }
        node["actions"] = JSONValue(value: actions)
        signature += "|\(path)|\(role)|\(title ?? "")|\(secure ? "<secure>" : axString(element, kAXValueAttribute) ?? "")|\(children(element).count)"
        nodes.append(node)
        for (index, child) in children(element).prefix(100).enumerated() { visit(child, path: path + [index], depth: depth + 1) }
    }
    visit(root, path: [], depth: 0)
    return [
        "snapshotId": JSONValue(value: stableHash(signature)),
        "truncated": JSONValue(value: nodes.count >= maximumObservedElements),
        "elements": JSONValue(value: nodes.map { JSONValue(value: $0) }),
    ]
}

func screenshot(target: Target) async throws -> String {
    let content = try await SCShareableContent.excludingDesktopWindows(true, onScreenWindowsOnly: true)
    guard let window = content.windows.first(where: {
        String($0.windowID) == target.windowId && $0.owningApplication?.processID == target.processId && $0.title == target.windowTitle
    }) else { throw ProtocolError.invalid("The verified screenshot target is no longer available.") }
    let filter = SCContentFilter(desktopIndependentWindow: window)
    let configuration = SCStreamConfiguration()
    let scale = min(1, 1440 / max(window.frame.width, 1), 900 / max(window.frame.height, 1))
    configuration.width = max(1, Int(window.frame.width * scale))
    configuration.height = max(1, Int(window.frame.height * scale))
    configuration.showsCursor = true
    let image = try await SCScreenshotManager.captureImage(contentFilter: filter, configuration: configuration)
    guard let data = NSBitmapImageRep(cgImage: image).representation(using: .png, properties: [:]), data.count <= 6 * 1024 * 1024 else {
        throw ProtocolError.invalid("The authorized window screenshot exceeds the response limit.")
    }
    return data.base64EncodedString()
}

func observation(target: Target) async throws -> [String: JSONValue] {
    var result = try semanticObservation(target: target)
    result["screenshot"] = JSONValue(value: [
        "mimeType": JSONValue(value: "image/png"),
        "data": JSONValue(value: try await screenshot(target: target)),
    ])
    return result
}

func resolve(target: Target, reference: String) throws -> AXUIElement {
    var element = try targetElement(target)
    if reference.isEmpty { return element }
    for component in reference.split(separator: ".") {
        guard let index = Int(component), children(element).indices.contains(index) else {
            throw ProtocolError.invalid("The semantic element reference is stale.")
        }
        element = children(element)[index]
    }
    return element
}

func act(_ envelope: OperationEnvelope) throws -> [String: JSONValue] {
    guard let kind = envelope.request.kind, let reference = envelope.request.elementRef else {
        throw ProtocolError.invalid("A bounded semantic action is required.")
    }
    let target = envelope.activation.target
    let expectedSnapshot = try semanticObservation(target: target)["snapshotId"]?.value as? String
    guard envelope.request.snapshotId == expectedSnapshot else { throw ProtocolError.invalid("The semantic snapshot is stale.") }
    let element = try resolve(target: target, reference: try boundedString(reference, maximum: 256, label: "elementRef"))
    guard FileManager.default.fileExists(atPath: envelope.authorizationPath) else {
        throw ProtocolError.invalid("The computer-use authorization was revoked.")
    }
    let result: AXError
    switch kind {
    case "press": result = AXUIElementPerformAction(element, kAXPressAction as CFString)
    case "focus": result = AXUIElementSetAttributeValue(element, kAXFocusedAttribute as CFString, true as CFTypeRef)
    case "set_value":
        guard let value = envelope.request.value, value.count <= 16_384 else { throw ProtocolError.invalid("The value is too long.") }
        result = AXUIElementSetAttributeValue(element, kAXValueAttribute as CFString, value as CFTypeRef)
    case "scroll":
        guard let direction = envelope.request.direction, let amount = envelope.request.amount,
              ["up", "down", "left", "right"].contains(direction), ["line", "page"].contains(amount) else {
            throw ProtocolError.invalid("The semantic scroll action is invalid.")
        }
        let suffix = direction.prefix(1).uppercased() + direction.dropFirst()
        result = AXUIElementPerformAction(element, "AXScroll\(suffix)By\(amount == "line" ? "Line" : "Page")" as CFString)
    default: throw ProtocolError.invalid("Only press, focus, set_value, and scroll actions are supported.")
    }
    guard result == .success else { throw ProtocolError.invalid("The target rejected the semantic action (AX error \(result.rawValue)).") }
    return ["applied": JSONValue(value: true)]
}

final class StopController: @unchecked Sendable {
    private let lock = NSLock()
    private var continuation: CheckedContinuation<Void, Never>?
    private var finished = false

    func wait() async {
        await withCheckedContinuation { continuation in
            let resumeNow = lock.withLock { () -> Bool in
                if finished { return true }
                self.continuation = continuation
                return false
            }
            if resumeNow { continuation.resume() }
        }
    }

    func finish() {
        let continuation = lock.withLock { () -> CheckedContinuation<Void, Never>? in
            guard !finished else { return nil }
            finished = true
            defer { self.continuation = nil }
            return self.continuation
        }
        continuation?.resume()
    }
}

final class RecordingWriter: NSObject, SCStreamOutput, @unchecked Sendable {
    let queue = DispatchQueue(label: "ai.agimon.doompi.computer-use.recording")
    private let writer: AVAssetWriter
    private let video: AVAssetWriterInput
    private let audio: AVAssetWriterInput
    private let lock = NSLock()
    private var startedAt: CMTime?

    init(url: URL, width: Int, height: Int) throws {
        writer = try AVAssetWriter(outputURL: url, fileType: .mp4)
        video = AVAssetWriterInput(
            mediaType: .video,
            outputSettings: [
                AVVideoCodecKey: AVVideoCodecType.h264,
                AVVideoWidthKey: width,
                AVVideoHeightKey: height,
            ])
        audio = AVAssetWriterInput(
            mediaType: .audio,
            outputSettings: [
                AVFormatIDKey: kAudioFormatMPEG4AAC,
                AVSampleRateKey: 48_000,
                AVNumberOfChannelsKey: 2,
                AVEncoderBitRateKey: 128_000,
            ])
        video.expectsMediaDataInRealTime = true
        audio.expectsMediaDataInRealTime = true
        guard writer.canAdd(video), writer.canAdd(audio) else {
            throw ProtocolError.invalid("The recording writer cannot accept the configured streams.")
        }
        writer.add(video)
        writer.add(audio)
        guard writer.startWriting() else {
            throw writer.error ?? ProtocolError.invalid("The recording writer could not start.")
        }
    }

    func stream(_ stream: SCStream, didOutputSampleBuffer sampleBuffer: CMSampleBuffer, of type: SCStreamOutputType) {
        guard sampleBuffer.isValid, CMSampleBufferDataIsReady(sampleBuffer) else { return }
        lock.withLock {
            if startedAt == nil {
                guard type == .screen else { return }
                startedAt = sampleBuffer.presentationTimeStamp
                writer.startSession(atSourceTime: sampleBuffer.presentationTimeStamp)
            }
            guard let startedAt, CMTimeCompare(sampleBuffer.presentationTimeStamp, startedAt) >= 0 else { return }
            if type == .screen, video.isReadyForMoreMediaData {
                video.append(sampleBuffer)
            } else if type == .audio, audio.isReadyForMoreMediaData {
                audio.append(sampleBuffer)
            }
        }
    }

    func finish() async throws {
        await withCheckedContinuation { continuation in
            queue.async { continuation.resume() }
        }
        lock.withLock {
            video.markAsFinished()
            audio.markAsFinished()
        }
        await withCheckedContinuation { continuation in
            writer.finishWriting { continuation.resume() }
        }
        guard writer.status == .completed else {
            throw writer.error ?? ProtocolError.invalid("The recording writer did not finish successfully.")
        }
    }
}

func record(_ activation: ActivationEnvelope) async throws {
    guard AXIsProcessTrusted() else { throw ProtocolError.invalid("Accessibility permission is not granted.") }
    guard CGPreflightScreenCaptureAccess() else { throw ProtocolError.invalid("Screen Recording permission is not granted.") }
    let target = activation.payload.target
    _ = try targetElement(target)
    let remainingMilliseconds = activation.expiresAt - Int64(Date().timeIntervalSince1970 * 1000)
    guard remainingMilliseconds > 0 else { throw ProtocolError.invalid("The computer-use grant has expired.") }
    let content = try await SCShareableContent.excludingDesktopWindows(true, onScreenWindowsOnly: true)
    guard let window = content.windows.first(where: {
        String($0.windowID) == target.windowId && $0.owningApplication?.processID == target.processId && $0.title == target.windowTitle
    }) else {
        throw ProtocolError.invalid("The verified capture target is no longer available.")
    }
    let filter = SCContentFilter(desktopIndependentWindow: window)
    let configuration = SCStreamConfiguration()
    configuration.capturesAudio = true
    configuration.excludesCurrentProcessAudio = true
    configuration.captureMicrophone = false
    let captureScale = min(2, 1920 / max(window.frame.width, 1), 1080 / max(window.frame.height, 1))
    configuration.width = max(1, Int(window.frame.width * captureScale))
    configuration.height = max(1, Int(window.frame.height * captureScale))
    let directory = FileManager.default.temporaryDirectory.appendingPathComponent("doompi-computer-use", isDirectory: true)
    try FileManager.default.createDirectory(at: directory, withIntermediateDirectories: true)
    try FileManager.default.setAttributes([.posixPermissions: 0o700], ofItemAtPath: directory.path)
    let staged = try FileManager.default.contentsOfDirectory(
        at: directory,
        includingPropertiesForKeys: [.contentModificationDateKey, .isRegularFileKey],
        options: [.skipsHiddenFiles])
        .sorted {
            let left = (try? $0.resourceValues(forKeys: [.contentModificationDateKey]).contentModificationDate) ?? .distantPast
            let right = (try? $1.resourceValues(forKeys: [.contentModificationDateKey]).contentModificationDate) ?? .distantPast
            return left > right
        }
    let cutoff = Date().addingTimeInterval(-24 * 60 * 60)
    for (index, candidate) in staged.enumerated() {
        let values = try? candidate.resourceValues(forKeys: [.contentModificationDateKey, .isRegularFileKey])
        if values?.isRegularFile == true && (index >= 8 || (values?.contentModificationDate ?? .distantPast) < cutoff) {
            try? FileManager.default.removeItem(at: candidate)
        }
    }
    let url = directory.appendingPathComponent("\(UUID().uuidString).mp4")
    let output = try RecordingWriter(url: url, width: configuration.width, height: configuration.height)
    let stream = SCStream(filter: filter, configuration: configuration, delegate: nil)
    try stream.addStreamOutput(output, type: .screen, sampleHandlerQueue: output.queue)
    try stream.addStreamOutput(output, type: .audio, sampleHandlerQueue: output.queue)
    try await stream.startCapture()
    let stop = StopController()
    signal(SIGINT, SIG_IGN)
    let source = DispatchSource.makeSignalSource(signal: SIGINT, queue: .global())
    source.setEventHandler { stop.finish() }
    source.resume()
    let expiry = DispatchSource.makeTimerSource(queue: .global())
    expiry.schedule(deadline: .now() + .milliseconds(Int(min(remainingMilliseconds, 1_800_000))))
    expiry.setEventHandler { stop.finish() }
    expiry.resume()
    emit(["recording": JSONValue(value: true), "audioScope": JSONValue(value: "target_application")])
    await stop.wait()
    expiry.cancel()
    var stopError: Error?
    do {
        try await stream.stopCapture()
    } catch {
        let nativeError = error as NSError
        if nativeError.domain != SCStreamErrorDomain || nativeError.code != -3808 { stopError = error }
    }
    try? stream.removeStreamOutput(output, type: .screen)
    try? stream.removeStreamOutput(output, type: .audio)
    try await output.finish()
    if let stopError { throw stopError }
    try FileManager.default.setAttributes([.posixPermissions: 0o600], ofItemAtPath: url.path)
    emit(["stopped": JSONValue(value: true), "artifact": JSONValue(value: [
        "kind": JSONValue(value: "screen_recording"), "path": JSONValue(value: url.path),
        "contentType": JSONValue(value: "video/mp4"), "audioScope": JSONValue(value: "target_application"),
    ])])
}

let operation = CommandLine.arguments.dropFirst().first ?? ""
Task {
    do {
        switch operation {
        case "probe":
            emit(["protocolVersion": JSONValue(value: 1), "architecture": JSONValue(value: "arm64"),
                  "accessibility": JSONValue(value: AXIsProcessTrusted()), "screenRecording": JSONValue(value: CGPreflightScreenCaptureAccess())])
        case "targets": emit(try discoverTargets().map { JSONValue(value: $0) })
        case "observe":
            let envelope = try input(OperationEnvelope.self)
            emit(try await observation(target: envelope.activation.target))
        case "act": emit(try act(input(OperationEnvelope.self)))
        case "record": try await record(input(ActivationEnvelope.self))
        default: throw ProtocolError.invalid("Unsupported helper operation.")
        }
        exit(0)
    } catch { fail(error) }
}
dispatchMain()
