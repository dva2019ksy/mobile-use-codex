import CoreGraphics
import Foundation
import ImageIO
import UniformTypeIdentifiers

let width = 80, height = 120
var pixels = [UInt8](repeating: 255, count: width * height * 4)
let colors: [[UInt8]] = [[240, 15, 15], [15, 240, 15], [15, 15, 240], [240, 240, 15]]
for y in 0..<height {
    for x in 0..<width {
        let quadrant = (y >= height / 2 ? 2 : 0) + (x >= width / 2 ? 1 : 0)
        for c in 0..<3 { pixels[(y * width + x) * 4 + c] = colors[quadrant][c] }
    }
}
let provider = CGDataProvider(data: Data(pixels) as CFData)!
let original = CGImage(width: width, height: height, bitsPerComponent: 8, bitsPerPixel: 32,
    bytesPerRow: width * 4, space: CGColorSpaceCreateDeviceRGB(),
    bitmapInfo: CGBitmapInfo(rawValue: CGImageAlphaInfo.noneSkipLast.rawValue), provider: provider,
    decode: nil, shouldInterpolate: false, intent: .defaultIntent)!
for (orientation, corner) in [(1, 0), (3, 3), (6, 2), (8, 1)] {
    let input = NSMutableData()
    let encoder = CGImageDestinationCreateWithData(input, UTType.jpeg.identifier as CFString, 1, nil)!
    CGImageDestinationAddImage(encoder, original, [kCGImagePropertyOrientation: orientation,
        kCGImageDestinationLossyCompressionQuality: 1] as CFDictionary)
    precondition(CGImageDestinationFinalize(encoder))
    let output = MJPEGImageScaler().scaleJPEG(input as Data, scaleFactor: 0.5, quality: 1)!
    let source = CGImageSourceCreateWithData(output as CFData, nil)!
    let image = CGImageSourceCreateImageAtIndex(source, 0, nil)!
    precondition(image.width == (orientation >= 6 ? 60 : 40))
    precondition(image.height == (orientation >= 6 ? 40 : 60))
    var decoded = [UInt8](repeating: 0, count: image.width * image.height * 4)
    decoded.withUnsafeMutableBytes { buffer in
        let context = CGContext(data: buffer.baseAddress, width: image.width, height: image.height,
            bitsPerComponent: 8, bytesPerRow: image.width * 4, space: CGColorSpaceCreateDeviceRGB(),
            bitmapInfo: CGImageAlphaInfo.noneSkipLast.rawValue)!
        context.draw(image, in: CGRect(x: 0, y: 0, width: image.width, height: image.height))
    }
    let offset = (5 * image.width + 5) * 4
    for c in 0..<3 { precondition(abs(Int(decoded[offset+c])-Int(colors[corner][c])) < 35) }
    let properties = CGImageSourceCopyPropertiesAtIndex(source, 0, nil) as! [CFString: Any]
    precondition((properties[kCGImagePropertyOrientation] as? Int ?? 1) == 1)
    print("EXIF \(orientation): \(image.width)x\(image.height), upright pixels verified")
}
