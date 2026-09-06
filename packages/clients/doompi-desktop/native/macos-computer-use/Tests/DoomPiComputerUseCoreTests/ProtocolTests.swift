import DoomPiComputerUseCore
import Foundation
import Testing

@Test func decodesVerifiedActivationFixture() throws {
    let data = Data(#"{"expiresAt":2000,"payload":{"target":{"bundleId":"com.example.fixture","applicationName":"Fixture","processId":42,"windowId":"7","windowTitle":"Document"}}}"#.utf8)
    let activation = try JSONDecoder().decode(ActivationEnvelope.self, from: data)
    #expect(activation.payload.target.processId == 42)
    #expect(activation.payload.target.windowId == "7")
}

@Test func decodesOperationAuthorizationPath() throws {
    let data = Data(#"{"activation":{"target":{"bundleId":"com.example.fixture","applicationName":"Fixture","processId":42,"windowId":"7","windowTitle":"Document"}},"authorizationPath":"/tmp/grant","request":{"kind":"press","snapshotId":"snapshot","elementRef":"0"}}"#.utf8)
    let operation = try JSONDecoder().decode(OperationEnvelope.self, from: data)
    #expect(operation.authorizationPath == "/tmp/grant")
}
@Test func rejectsUnboundedSemanticReferences() {
    #expect(throws: ProtocolError.self) { try boundedString(String(repeating: "x", count: 257), maximum: 256, label: "elementRef") }
}

@Test func observationBoundsStayConservative() {
    #expect(maximumObservedElements == 500)
    #expect(maximumObservationDepth == 12)
}
