# DeviceKit MJPEG orientation

DeviceKit 0.0.33 scales the raw JPEG pixels without applying EXIF orientation.
The patch applies the transform during downsampling and writes upright pixels,
preserving the default half-resolution stream and avoiding orientation polling.

In your DeviceKit source checkout:

```sh
git apply /path/to/mobile-use-codex/patches/devicekit-mjpeg-orientation.patch
```

Rebuild, sign and install the test runner using your existing signing setup.
The plugin alone cannot update a device's separately signed native agent.

On macOS, verify pixel orientation and dimensions for all four rotations:

```sh
swiftc /path/to/devicekit-ios/DeviceKitTests/Streamer/MJPEG/MJPEGImageScaler.swift \
  /path/to/mobile-use-codex/patches/tests/main.swift -o /tmp/devicekit-orientation-check
/tmp/devicekit-orientation-check
```
