// macOS capture helper for the live glass.
//
// Why this exists: on macOS, setContentProtection only hides a window from
// *other* processes' captures. desktopCapturer runs inside the app that owns
// the bar, so the bar shows up in its own capture and the shader refracts
// itself — a feedback loop of ghost text and tracks inside the glass. Windows'
// WDA_EXCLUDEFROMCAPTURE has no such exception, which is why it only bites here.
//
// ScreenCaptureKit lets a capture name the windows to leave out, so this asks
// for just the strip of desktop around the bar with every window of the parent
// app excluded. It also drops the mouse pointer from the capture, so there is
// no ghost cursor for the shader to dodge.
//
// Protocol
//   stdin   one JSON object per line: {"display":<CGDirectDisplayID>,
//           "x","y","w","h": rect in display-local points, "scale": px/pt}
//           Newer lines replace older ones; repeats are ignored.
//   stdout  frames: 32-byte little-endian header
//             u32 magic 'GLSF' · u32 width · u32 height · u32 displayId
//             f32 x · f32 y · f32 w · f32 h   (rect the frame covers, points)
//           then width*height*4 bytes of tightly packed BGRA.
//   stderr  diagnostics only.
// Exits when stdin closes, i.e. when the app that spawned it goes away.
//
// Permission: macOS only applies a Screen Recording grant to processes started
// after it, and every capture call made without one raises the system prompt
// again. So the helper checks silently first and, lacking access, exits with
// status 3 instead of retrying; the app starts a fresh helper a few seconds
// later, which is how a grant made meanwhile gets picked up. The prompt itself
// is only raised when the app passes --request, once per launch.
import CoreMedia
import CoreVideo
import Foundation
import ScreenCaptureKit

struct Request: Decodable, Equatable {
  let display: UInt32
  let x: Double, y: Double, w: Double, h: Double
  let scale: Double
}

func log(_ s: String) { FileHandle.standardError.write((s + "\n").data(using: .utf8)!) }

final class Capturer: NSObject, SCStreamOutput, SCStreamDelegate, @unchecked Sendable {
  private let ownerPid = getppid()
  private let frameQueue = DispatchQueue(label: "glass.frames")
  private let out = FileHandle.standardOutput

  private var stream: SCStream?
  private var running: Request?   // what the live stream is configured for
  private var covered: Request?   // rect stamped on outgoing frames
  private var busy = false
  private var pending: Request?

  // Called from the stdin thread. Requests are applied one at a time, and only
  // the newest one waiting is kept, so a burst of moves during a drag
  // collapses into a single reconfigure.
  func submit(_ r: Request) {
    DispatchQueue.main.async {
      self.pending = r
      self.pump()
    }
  }

  private func pump() {
    guard !busy, let r = pending else { return }
    pending = nil
    if r == running && stream != nil { return }
    busy = true
    Task {
      await self.apply(r)
      DispatchQueue.main.async {
        self.busy = false
        self.pump()
      }
    }
  }

  private func configuration(for r: Request) -> SCStreamConfiguration {
    let c = SCStreamConfiguration()
    c.sourceRect = CGRect(x: r.x, y: r.y, width: r.w, height: r.h)
    c.width = max(1, Int((r.w * r.scale).rounded()))
    c.height = max(1, Int((r.h * r.scale).rounded()))
    c.pixelFormat = kCVPixelFormatType_32BGRA
    c.colorSpaceName = CGColorSpace.sRGB
    c.showsCursor = false
    c.minimumFrameInterval = CMTime(value: 1, timescale: 60)
    c.queueDepth = 4
    return c
  }

  private func apply(_ r: Request) async {
    let config = configuration(for: r)

    // Same display: retarget the running stream instead of restarting it.
    if let s = stream, let cur = running, cur.display == r.display {
      do {
        try await s.updateConfiguration(config)
        running = r
        frameQueue.sync { covered = r }
        return
      } catch {
        log("glass-capture: reconfigure failed, restarting: \(error)")
      }
    }

    if let s = stream { try? await s.stopCapture() }
    stream = nil
    running = nil

    do {
      let content = try await SCShareableContent.excludingDesktopWindows(false, onScreenWindowsOnly: true)
      guard let display = content.displays.first(where: { $0.displayID == r.display }) else {
        log("glass-capture: display \(r.display) not among \(content.displays.map { $0.displayID })")
        return
      }
      // Every window of the app that spawned us: the bar, but also its menu
      // and the sign-in window when they overlap it.
      let mine = content.windows.filter { $0.owningApplication?.processID == ownerPid }
      if mine.isEmpty {
        // The window list was read before the bar reached the screen. Leave
        // the stream stopped; the app re-sends its rect every couple of
        // seconds, and the next attempt will find it.
        log("glass-capture: no windows of pid \(ownerPid) yet")
        return
      }
      let filter = SCContentFilter(display: display, excludingWindows: mine)
      let s = SCStream(filter: filter, configuration: config, delegate: self)
      try s.addStreamOutput(self, type: .screen, sampleHandlerQueue: frameQueue)
      frameQueue.sync { covered = r }
      try await s.startCapture()
      stream = s
      running = r
    } catch {
      // Most likely Screen Recording permission is missing. Stay stopped; the
      // periodic re-send retries once it has been granted.
      log("glass-capture: start failed: \(error)")
    }
  }

  func stream(_ stream: SCStream, didStopWithError error: Error) {
    log("glass-capture: stream stopped: \(error)")
    DispatchQueue.main.async {
      if self.stream === stream { self.stream = nil; self.running = nil }
    }
  }

  func stream(_ stream: SCStream, didOutputSampleBuffer sb: CMSampleBuffer, of type: SCStreamOutputType) {
    guard type == .screen, sb.isValid, let r = covered else { return }
    // Idle and blank frames carry no new pixels.
    guard let infos = CMSampleBufferGetSampleAttachmentsArray(sb, createIfNecessary: false) as? [[SCStreamFrameInfo: Any]],
          let raw = infos.first?[.status] as? Int,
          SCFrameStatus(rawValue: raw) == .complete,
          let pb = CMSampleBufferGetImageBuffer(sb) else { return }

    CVPixelBufferLockBaseAddress(pb, .readOnly)
    defer { CVPixelBufferUnlockBaseAddress(pb, .readOnly) }
    guard let base = CVPixelBufferGetBaseAddress(pb) else { return }
    let w = CVPixelBufferGetWidth(pb), h = CVPixelBufferGetHeight(pb)
    let bpr = CVPixelBufferGetBytesPerRow(pb)
    let row = w * 4

    var data = Data(capacity: 32 + row * h)
    func u32(_ v: UInt32) { withUnsafeBytes(of: v.littleEndian) { data.append(contentsOf: $0) } }
    func f32(_ v: Double) { withUnsafeBytes(of: Float(v).bitPattern.littleEndian) { data.append(contentsOf: $0) } }
    u32(0x4653_4C47) // "GLSF"
    u32(UInt32(w)); u32(UInt32(h)); u32(r.display)
    f32(r.x); f32(r.y); f32(r.w); f32(r.h)
    for y in 0..<h {
      data.append(base.advanced(by: y * bpr).assumingMemoryBound(to: UInt8.self), count: row)
    }
    out.write(data)
  }
}

signal(SIGPIPE, SIG_IGN)

if !CGPreflightScreenCaptureAccess() {
  if CommandLine.arguments.contains("--request") { _ = CGRequestScreenCaptureAccess() }
  log("glass-capture: no screen recording permission")
  exit(3)
}

let capturer = Capturer()

Thread {
  let decoder = JSONDecoder()
  while let line = readLine() {
    if let r = try? decoder.decode(Request.self, from: Data(line.utf8)) { capturer.submit(r) }
  }
  exit(0)
}.start()

dispatchMain()
