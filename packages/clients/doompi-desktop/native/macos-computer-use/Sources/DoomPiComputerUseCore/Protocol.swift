import Foundation

public let maximumObservedElements = 500
public let maximumObservationDepth = 12

public struct Target: Codable, Equatable, Sendable {
    public let bundleId: String
    public let applicationName: String
    public let processId: Int32
    public let windowId: String
    public let windowTitle: String

    public init(bundleId: String, applicationName: String, processId: Int32, windowId: String, windowTitle: String) {
        self.bundleId = bundleId
        self.applicationName = applicationName
        self.processId = processId
        self.windowId = windowId
        self.windowTitle = windowTitle
    }
}

public struct ActivationEnvelope: Decodable, Sendable {
    public struct Payload: Decodable, Sendable { public let target: Target }
    public let expiresAt: Int64
    public let payload: Payload
}

public struct OperationEnvelope: Decodable, Sendable {
    public let activation: ActivationEnvelope.Payload
    public let authorizationPath: String
    public let request: Request
    public struct Request: Decodable, Sendable {
        public let kind: String?
        public let snapshotId: String?
        public let elementRef: String?
        public let value: String?
        public let direction: String?
        public let amount: String?
    }
}

public func boundedString(_ value: String, maximum: Int, label: String) throws -> String {
    guard !value.isEmpty, value.count <= maximum else { throw ProtocolError.invalid("\(label) is outside its permitted bounds.") }
    return value
}

public enum ProtocolError: Error, LocalizedError {
    case invalid(String)
    public var errorDescription: String? {
        switch self { case .invalid(let message): message }
    }
}
