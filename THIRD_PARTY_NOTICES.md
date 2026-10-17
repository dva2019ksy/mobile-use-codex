# Third-party dependencies

Mobile Use for Codex uses [mobile-mcp](https://github.com/mobile-next/mobile-mcp),
published as `@mobilenext/mobile-mcp` version 1.0.9 under Apache-2.0.
Device operation tools run the unmodified upstream package. Its license is
included in [licenses/mobile-mcp-Apache-2.0.txt](licenses/mobile-mcp-Apache-2.0.txt).

The optional [DeviceKit MJPEG orientation patch](patches/devicekit-mjpeg-orientation.patch)
modifies [DeviceKit iOS](https://github.com/mobile-next/devicekit-ios) source from
Mobile Next HQ, Inc. Its Functional Source License 1.1 with ALv2 future license
is included in [licenses/devicekit-FSL-1.1-ALv2.txt](licenses/devicekit-FSL-1.1-ALv2.txt).

Other dependencies and platform binaries retain their respective licenses.
Exact versions are recorded in `package-lock.json`; license files are installed
with the packages in `node_modules`. The project's MIT license covers this
project's own source code.
