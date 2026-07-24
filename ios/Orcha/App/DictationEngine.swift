import AVFoundation
import Foundation
import Observation
import Speech

/// On-device live dictation on the iOS 26 SpeechAnalyzer stack — the modern
/// replacement for SFSpeechRecognizer: streaming volatile + finalized results,
/// long-form audio, zero cloud (nothing leaves the phone, matching the rest of
/// Orcha's privacy story). An AVAudioEngine tap feeds an AsyncStream of
/// AnalyzerInput; results land on the main actor as they stream.
@available(iOS 26, *)
@MainActor
@Observable
final class DictationEngine {
    enum State: Equatable {
        case idle, preparing, recording, finishing
        case failed(String)
    }

    private(set) var state: State = .idle
    /// Text finalized by the recognizer so far (stable).
    private(set) var finalized = ""
    /// The in-flight hypothesis (may still change).
    private(set) var volatile = ""
    /// 0…1 input level for the mic pulse.
    private(set) var level: Float = 0

    private let audioEngine = AVAudioEngine()
    private var analyzer: SpeechAnalyzer?
    private var transcriber: SpeechTranscriber?
    private var inputBuilder: AsyncStream<AnalyzerInput>.Continuation?
    private var resultsTask: Task<Void, Never>?
    private var levelThrottle = 0

    var isActive: Bool {
        state == .preparing || state == .recording || state == .finishing
    }

    /// Everything transcribed so far, volatile hypothesis included.
    var liveText: String {
        (finalized + volatile).trimmingCharacters(in: .whitespaces)
    }

    func start() async {
        guard state == .idle || state.isFailure else { return }
        state = .preparing
        finalized = ""
        volatile = ""

        guard await AVAudioApplication.requestRecordPermission() else {
            state = .failed("Microphone access is off for Orcha — enable it in iOS Settings.")
            return
        }
        do {
            let locale = await Self.usableLocale()
            let transcriber = SpeechTranscriber(
                locale: locale,
                transcriptionOptions: [],
                reportingOptions: [.volatileResults],
                attributeOptions: []
            )
            self.transcriber = transcriber
            // First use per language downloads the on-device model.
            if let request = try await AssetInventory.assetInstallationRequest(supporting: [transcriber]) {
                try await request.downloadAndInstall()
            }
            let analyzer = SpeechAnalyzer(modules: [transcriber])
            self.analyzer = analyzer
            guard let analyzerFormat = await SpeechAnalyzer.bestAvailableAudioFormat(compatibleWith: [transcriber]) else {
                state = .failed("On-device dictation isn't available for this language yet.")
                return
            }

            let (inputSequence, inputBuilder) = AsyncStream.makeStream(of: AnalyzerInput.self)
            self.inputBuilder = inputBuilder

            resultsTask = Task { [weak self] in
                do {
                    for try await result in transcriber.results {
                        guard let self else { return }
                        let text = String(result.text.characters)
                        if result.isFinal {
                            self.finalized += text
                            self.volatile = ""
                        } else {
                            self.volatile = text
                        }
                    }
                } catch {
                    self?.state = .failed("Dictation stopped: \(error.localizedDescription)")
                }
            }

            try Self.configureSession()
            let input = audioEngine.inputNode
            let micFormat = input.outputFormat(forBus: 0)
            let tapConverter = AVAudioConverter(from: micFormat, to: analyzerFormat)
            // The tap runs on the audio thread: yield straight to the (Sendable)
            // continuation so buffer ORDER is preserved — no actor hops on the
            // audio path. Only the UI level update hops to the main actor.
            input.installTap(onBus: 0, bufferSize: 4096, format: micFormat) { [weak self] buffer, _ in
                if let converted = Self.convert(buffer, with: tapConverter, to: analyzerFormat) {
                    inputBuilder.yield(AnalyzerInput(buffer: converted))
                }
                let display = Self.rmsLevel(buffer)
                Task { @MainActor [weak self] in self?.bumpLevel(display) }
            }
            audioEngine.prepare()
            try audioEngine.start()
            try await analyzer.start(inputSequence: inputSequence)
            state = .recording
        } catch {
            teardownAudio()
            state = .failed("Couldn't start dictation: \(error.localizedDescription)")
        }
    }

    /// Stops listening, waits for the recognizer to finalize, and returns the
    /// full transcript.
    func stop() async -> String {
        guard state == .recording || state == .preparing else { return liveText }
        state = .finishing
        teardownAudio()
        inputBuilder?.finish()
        try? await analyzer?.finalizeAndFinishThroughEndOfInput()
        resultsTask?.cancel()
        let text = liveText
        reset()
        return text
    }

    func cancel() {
        teardownAudio()
        inputBuilder?.finish()
        resultsTask?.cancel()
        Task { [analyzer] in try? await analyzer?.cancelAndFinishNow() }
        reset()
    }

    // MARK: internals

    private func reset() {
        analyzer = nil
        transcriber = nil
        inputBuilder = nil
        resultsTask = nil
        finalized = ""
        volatile = ""
        level = 0
        state = .idle
    }

    private func teardownAudio() {
        audioEngine.inputNode.removeTap(onBus: 0)
        audioEngine.stop()
        try? AVAudioSession.sharedInstance().setActive(false, options: .notifyOthersOnDeactivation)
    }

    private func bumpLevel(_ display: Float) {
        levelThrottle += 1
        if levelThrottle % 3 == 0 || display > level {
            level = level * 0.6 + display * 0.4
        }
    }

    /// Audio-thread helpers: pure functions over the captured converter/format —
    /// no shared mutable state, no isolation to violate.
    private nonisolated static func convert(
        _ buffer: AVAudioPCMBuffer,
        with converter: AVAudioConverter?,
        to format: AVAudioFormat
    ) -> AVAudioPCMBuffer? {
        guard buffer.format != format else { return buffer }
        guard let converter else { return nil }
        let ratio = format.sampleRate / buffer.format.sampleRate
        let capacity = AVAudioFrameCount(Double(buffer.frameLength) * ratio) + 16
        guard let out = AVAudioPCMBuffer(pcmFormat: format, frameCapacity: capacity) else { return nil }
        var error: NSError?
        var fed = false
        converter.convert(to: out, error: &error) { _, status in
            if fed {
                status.pointee = .noDataNow
                return nil
            }
            fed = true
            status.pointee = .haveData
            return buffer
        }
        return error == nil ? out : nil
    }

    private nonisolated static func rmsLevel(_ buffer: AVAudioPCMBuffer) -> Float {
        guard let data = buffer.floatChannelData?[0] else { return 0 }
        let n = Int(buffer.frameLength)
        guard n > 0 else { return 0 }
        var sum: Float = 0
        for i in stride(from: 0, to: n, by: 8) { sum += data[i] * data[i] }
        let rms = (sum / Float(max(n / 8, 1))).squareRoot()
        return min(1, rms * 14)
    }

    private static func configureSession() throws {
        let session = AVAudioSession.sharedInstance()
        try session.setCategory(.playAndRecord, mode: .spokenAudio, options: [.duckOthers])
        try session.setActive(true, options: .notifyOthersOnDeactivation)
    }

    /// Current locale when the on-device model supports it, else English.
    private static func usableLocale() async -> Locale {
        let supported = await SpeechTranscriber.supportedLocales
        let current = Locale.current
        if supported.contains(where: { $0.identifier(.bcp47) == current.identifier(.bcp47) }) {
            return current
        }
        return Locale(identifier: "en-US")
    }
}

@available(iOS 26, *)
extension DictationEngine.State {
    var isFailure: Bool {
        if case .failed = self { return true }
        return false
    }

    var failureMessage: String? {
        if case let .failed(message) = self { return message }
        return nil
    }
}
