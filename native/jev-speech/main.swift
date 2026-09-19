// jev-speech: on-device streaming speech recognition for the Jev companion.
//
//   stdin  : raw little-endian 16-bit PCM, mono, at the sample rate given as argv[1] (default 16000)
//   stdout : JSON lines
//            {"type":"ready","onDevice":true}
//            {"type":"transcript","text":"…","final":false}
//            {"type":"transcript","text":"…","final":true}      one per utterance
//            {"type":"error","message":"…"}
//
// Utterances are cut by the helper itself: after speech, `silenceMs` of low energy ends the current
// recognition request (which yields the final) and a fresh request takes the next audio.
//
// Build: swiftc -O -framework Speech -framework AVFoundation -o jev-speech main.swift

import AVFoundation
import Foundation
import Speech

// TCC attributes a spawned process to the app that launched it (Terminal, Electron, whatever) and
// looks for the usage description there. Re-exec ourselves with the parent's responsibility
// disclaimed so the check — and the permission prompt — apply to this binary's own Info.plist.
@_silgen_name("responsibility_spawnattrs_setdisclaim")
private func responsibility_spawnattrs_setdisclaim(_ attrs: UnsafeMutablePointer<posix_spawnattr_t?>, _ disclaim: Int32) -> Int32

// If whoever spawned us dies without cleaning up (a crashed or SIGKILLed companion), leave
// rather than linger as an orphan holding the recognizer and, worse, a permission prompt.
let watchdog = DispatchSource.makeTimerSource(queue: DispatchQueue.global())
watchdog.schedule(deadline: .now() + 1, repeating: 1)
watchdog.setEventHandler { if getppid() == 1 { kill(0, SIGTERM); exit(0) } }
watchdog.resume()

if ProcessInfo.processInfo.environment["JEV_SPEECH_DISCLAIMED"] == nil {
    var attrs: posix_spawnattr_t? = nil
    posix_spawnattr_init(&attrs)
    _ = responsibility_spawnattrs_setdisclaim(&attrs, 1)
    var env = ProcessInfo.processInfo.environment
    env["JEV_SPEECH_DISCLAIMED"] = "1"
    let cEnv: [UnsafeMutablePointer<CChar>?] = env.map { strdup("\($0.key)=\($0.value)") } + [nil]
    let cArgs: [UnsafeMutablePointer<CChar>?] = CommandLine.arguments.map { strdup($0) } + [nil]
    var pid: pid_t = 0
    let rc = posix_spawn(&pid, CommandLine.arguments[0], nil, &attrs, cArgs, cEnv)
    posix_spawnattr_destroy(&attrs)
    if rc != 0 {
        FileHandle.standardError.write("jev-speech: posix_spawn failed (\(rc))\n".data(using: .utf8)!)
        exit(1)
    }
    signal(SIGTERM) { _ in kill(0, SIGTERM); exit(143) }
    var status: Int32 = 0
    waitpid(pid, &status, 0)
    exit((status & 0x7f) == 0 ? (status >> 8) & 0xff : 128 + (status & 0x7f))
}

let sampleRate = Double(CommandLine.arguments.count > 1 ? CommandLine.arguments[1] : "16000") ?? 16000
let localeId = CommandLine.arguments.count > 2 ? CommandLine.arguments[2] : "en-US"
let contextual = CommandLine.arguments.count > 3 ? Array(CommandLine.arguments[3...]) : []
let silenceMs = 700.0
let maxUtteranceMs = 30_000.0
let energyGate: Float = 0.012 // RMS of int16/32768 samples; room noise sits well below this

let debug = ProcessInfo.processInfo.environment["JEV_SPEECH_DEBUG"] != nil
func trace(_ msg: String) {
    if debug { FileHandle.standardError.write("[jev-speech] \(msg)\n".data(using: .utf8)!) }
}
let out = FileHandle.standardOutput
let outQueue = DispatchQueue(label: "jev-speech.out")
func emit(_ obj: [String: Any]) {
    guard let data = try? JSONSerialization.data(withJSONObject: obj), var line = String(data: data, encoding: .utf8) else { return }
    line += "\n"
    outQueue.sync { out.write(line.data(using: .utf8)!) }
}
func fail(_ message: String, code: Int32) -> Never {
    emit(["type": "error", "message": message])
    exit(code)
}

guard let recognizer = SFSpeechRecognizer(locale: Locale(identifier: localeId)) else {
    fail("no recognizer for locale \(localeId)", code: 2)
}

// Authorization: the prompt is attributed to the process that launched us (Terminal, the app).
let authDone = DispatchSemaphore(value: 0)
var authStatus = SFSpeechRecognizer.authorizationStatus()
if authStatus == .notDetermined {
    emit(["type": "permission", "state": "prompting"])
    SFSpeechRecognizer.requestAuthorization { status in
        authStatus = status
        authDone.signal()
    }
    if authDone.wait(timeout: .now() + 300) == .timedOut { fail("speech recognition permission not answered", code: 3) }
}
guard authStatus == .authorized else { fail("speech recognition not authorized (status \(authStatus.rawValue)); allow it in System Settings → Privacy & Security → Speech Recognition", code: 3) }
guard recognizer.isAvailable else { fail("speech recognizer unavailable", code: 4) }

let onDevice = recognizer.supportsOnDeviceRecognition
guard let format = AVAudioFormat(commonFormat: .pcmFormatInt16, sampleRate: sampleRate, channels: 1, interleaved: true) else {
    fail("bad audio format", code: 2)
}

/// One recognition request = one utterance. Serialised on `queue`.
final class Utterance {
    let request = SFSpeechAudioBufferRecognitionRequest()
    var task: SFSpeechRecognitionTask?
    var lastText = ""
    var startedAt = Date()
    var lastSpeechAt: Date? = nil
    var ended = false
    var finished = false
}

let queue = DispatchQueue(label: "jev-speech.state")
var current: Utterance? = nil
var stdinClosed = false
/// Requests that have had endAudio() but not yet delivered (or been forced to) their final.
var draining = 0

/// After EOF: leave once nothing is still draining.
func exitIfDone() {
    if stdinClosed && draining == 0 { exit(0) }
}

func startUtterance() {
    let u = Utterance()
    u.request.shouldReportPartialResults = true
    u.request.requiresOnDeviceRecognition = onDevice
    if #available(macOS 13.0, *) { u.request.addsPunctuation = true }
    if !contextual.isEmpty { u.request.contextualStrings = contextual }
    current = u
    u.task = recognizer.recognitionTask(with: u.request) { result, error in
        queue.async {
            if let result = result {
                let text = result.bestTranscription.formattedString
                if result.isFinal {
                    finish(u, text: text)
                } else if text != u.lastText {
                    u.lastText = text
                    emit(["type": "transcript", "text": text, "final": false])
                }
            }
            if let error = error as NSError? {
                trace("error \(error.domain) \(error.code) \(error.localizedDescription)")
                // Ending a request with no speech in it reports "no speech detected" — that is not an error for us.
                if !u.finished {
                    if u.ended || error.code == 1110 || error.code == 216 { finish(u, text: u.lastText) }
                    else { emit(["type": "error", "message": error.localizedDescription]); finish(u, text: u.lastText) }
                }
            }
        }
    }
}

func finish(_ u: Utterance, text: String) {
    trace("finish finished=\(u.finished) ended=\(u.ended) text=\(text) isCurrent=\(current === u) stdinClosed=\(stdinClosed)")
    if u.finished { return }
    u.finished = true
    if u.ended { draining -= 1 }
    u.task?.cancel()
    let t = text.trimmingCharacters(in: .whitespacesAndNewlines)
    if !t.isEmpty { emit(["type": "transcript", "text": t, "final": true]) }
    if current === u {
        current = nil
        if !stdinClosed { startUtterance() }
    }
    exitIfDone()
}

func endUtterance(_ u: Utterance) {
    if u.ended { return }
    u.ended = true
    draining += 1
    u.request.endAudio()
    // Recognizers sometimes never deliver the final for a request that ended on silence; don't wait forever.
    queue.asyncAfter(deadline: .now() + 2.5) { if !u.finished { finish(u, text: u.lastText) } }
    if current === u && !stdinClosed { startUtterance() } // route new audio to a fresh request straight away
}

func rms(_ samples: UnsafeBufferPointer<Int16>) -> Float {
    if samples.isEmpty { return 0 }
    var acc: Float = 0
    for s in samples { let f = Float(s) / 32768; acc += f * f }
    return (acc / Float(samples.count)).squareRoot()
}

func feed(_ chunk: Data) {
    let frames = chunk.count / 2
    guard frames > 0, let buffer = AVAudioPCMBuffer(pcmFormat: format, frameCapacity: AVAudioFrameCount(frames)) else { return }
    buffer.frameLength = AVAudioFrameCount(frames)
    chunk.withUnsafeBytes { raw in
        let src = raw.bindMemory(to: Int16.self)
        buffer.int16ChannelData![0].update(from: src.baseAddress!, count: frames)
    }
    let level = chunk.withUnsafeBytes { rms($0.bindMemory(to: Int16.self)) }
    queue.sync {
        guard let u = current, !u.ended else { return }
        u.request.append(buffer)
        let now = Date()
        if level >= energyGate { u.lastSpeechAt = now }
        if let spoke = u.lastSpeechAt {
            let quietMs = now.timeIntervalSince(spoke) * 1000
            let ageMs = now.timeIntervalSince(u.startedAt) * 1000
            if quietMs >= silenceMs || ageMs >= maxUtteranceMs { endUtterance(u) }
        } else if now.timeIntervalSince(u.startedAt) > 55 {
            // nothing said for almost a minute: recycle the request before the recognizer times it out
            endUtterance(u)
        }
    }
}

queue.sync { startUtterance() }
emit(["type": "ready", "onDevice": onDevice, "locale": localeId])

let reader = Thread {
    let stdin = FileHandle.standardInput
    let chunkBytes = Int(sampleRate / 10) * 2 // 100 ms
    var pending = Data()
    while true {
        let data = stdin.availableData
        if data.isEmpty { break }
        pending.append(data)
        while pending.count >= chunkBytes {
            feed(pending.prefix(chunkBytes))
            pending.removeFirst(chunkBytes)
        }
    }
    if !pending.isEmpty { feed(pending) }
    queue.sync {
        stdinClosed = true
        trace("EOF current=\(current == nil ? "nil" : "u") lastSpeechAt=\(String(describing: current?.lastSpeechAt)) ended=\(current?.ended ?? false) lastText=\(current?.lastText ?? "")")
        if let u = current, u.lastSpeechAt != nil { endUtterance(u) }
        exitIfDone()
    }
    queue.asyncAfter(deadline: .now() + 3) { exit(0) }
}
reader.start()
dispatchMain()
