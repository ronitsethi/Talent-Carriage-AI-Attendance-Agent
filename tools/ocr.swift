import Foundation
import Vision
import AppKit

// Reads text out of an image with macOS's own OCR. Character recognition, not
// generation: it cannot invent a clause that is not on the page.
let args = CommandLine.arguments
guard args.count > 1, let image = NSImage(contentsOfFile: args[1]),
      let cg = image.cgImage(forProposedRect: nil, context: nil, hints: nil) else {
    FileHandle.standardError.write("cannot read image\n".data(using: .utf8)!)
    exit(1)
}

let request = VNRecognizeTextRequest()
request.recognitionLevel = .accurate
request.usesLanguageCorrection = false
request.recognitionLanguages = ["en-US"]

try? VNImageRequestHandler(cgImage: cg, options: [:]).perform([request])
for observation in request.results ?? [] {
    if let line = observation.topCandidates(1).first?.string { print(line) }
}
