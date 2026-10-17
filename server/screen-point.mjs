// The widget sends a position within the displayed image, not CSS pixels or
// JPEG pixels. Native input uses the device's current logical screen size.
export function screenPoint({ x, y, frameWidth, frameHeight }, { width, height } = {}) {
  if (![x, y].every((n) => Number.isFinite(n) && n >= 0 && n <= 1)) {
    throw Error('Invalid screen position');
  }
  if (![width, height, frameWidth, frameHeight].every((n) => Number.isFinite(n) && n >= 1)) {
    throw Error('Screen dimensions are unavailable');
  }
  // device.info can retain the previous orientation. Its logical short/long
  // dimensions remain valid; the upright frame determines the current axes.
  if (frameWidth > frameHeight !== width > height) {
    [width, height] = [height, width];
  }
  if (Math.abs(frameWidth / frameHeight / (width / height) - 1) > 0.02) {
    throw Error('屏幕方向已变化，请等待新画面后再点击');
  }
  return {
    x: Math.min(Math.floor(width) - 1, Math.floor(x * width)),
    y: Math.min(Math.floor(height) - 1, Math.floor(y * height)),
  };
}

export function jpegSize(data) {
  if (!data || data[0] !== 0xff || data[1] !== 0xd8) {
    return null;
  }
  let offset = 2;
  while (offset + 1 < data.length) {
    if (data[offset++] !== 0xff) {
      return null;
    }
    while (data[offset] === 0xff) {
      offset++;
    }
    const marker = data[offset++];
    if (marker === 0xda || marker === 0xd9 || offset + 2 > data.length) {
      return null;
    }
    if (marker === 0x01 || (marker >= 0xd0 && marker <= 0xd8)) {
      continue;
    }
    const length = data.readUInt16BE(offset);
    if (length < 2 || offset + length > data.length) {
      return null;
    }
    if (
      [0xc0, 0xc1, 0xc2, 0xc3, 0xc5, 0xc6, 0xc7, 0xc9, 0xca, 0xcb, 0xcd, 0xce, 0xcf].includes(
        marker,
      )
    ) {
      if (length < 8) {
        return null;
      }
      const width = data.readUInt16BE(offset + 5);
      const height = data.readUInt16BE(offset + 3);
      return width && height ? { width, height } : null;
    }
    offset += length;
  }
  return null;
}
