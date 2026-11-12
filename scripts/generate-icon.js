/**
 * Icon Generator for XYRON CENTER
 * Generates assets/icon.png and assets/icon.ico (Windows multi-resolution icon)
 * with a high-fidelity dark carbon / neon cyan-green HUD theme.
 */

const fs = require('fs');
const path = require('path');
const zlib = require('zlib');

// CRC32 table and calculation for PNG chunks
function createCrcTable() {
  const table = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) {
      c = (c & 1) ? (0xedb88320 ^ (c >>> 1)) : (c >>> 1);
    }
    table[n] = c;
  }
  return table;
}

const crcTable = createCrcTable();

function crc32(buffer) {
  let crc = 0xffffffff;
  for (let i = 0; i < buffer.length; i++) {
    crc = (crc >>> 8) ^ crcTable[(crc ^ buffer[i]) & 0xff];
  }
  return (crc ^ 0xffffffff) >>> 0;
}

function createPngChunk(type, data) {
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length, 0);
  const typeBuf = Buffer.from(type, 'ascii');
  const toCrc = Buffer.concat([typeBuf, data]);
  const crcBuf = Buffer.alloc(4);
  crcBuf.writeUInt32BE(crc32(toCrc), 0);
  return Buffer.concat([len, toCrc, crcBuf]);
}

function encodePng(width, height, pixelRgbaFn) {
  const scanlineWidth = 1 + width * 4;
  const rawBytes = Buffer.alloc(height * scanlineWidth);
  let offset = 0;

  for (let y = 0; y < height; y++) {
    rawBytes[offset++] = 0; // Filter: None
    for (let x = 0; x < width; x++) {
      const [r, g, b, a] = pixelRgbaFn(x, y, width, height);
      rawBytes[offset++] = Math.round(Math.max(0, Math.min(255, r)));
      rawBytes[offset++] = Math.round(Math.max(0, Math.min(255, g)));
      rawBytes[offset++] = Math.round(Math.max(0, Math.min(255, b)));
      rawBytes[offset++] = Math.round(Math.max(0, Math.min(255, a)));
    }
  }

  const compressed = zlib.deflateSync(rawBytes, { level: 9 });

  const signature = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 8; // 8-bit depth
  ihdr[9] = 6; // RGBA color type
  ihdr[10] = 0; // Deflate
  ihdr[11] = 0; // Filter
  ihdr[12] = 0; // Interlace

  return Buffer.concat([
    signature,
    createPngChunk('IHDR', ihdr),
    createPngChunk('IDAT', compressed),
    createPngChunk('IEND', Buffer.alloc(0))
  ]);
}

// Procedural rendering of the XYRON CENTER HUD Icon
function renderHudIconPixel(x, y, width, height) {
  // Normalize to [0, 1]
  const u = x / (width - 1);
  const v = y / (height - 1);
  const nx = (u - 0.5) * 2; // [-1, 1]
  const ny = (v - 0.5) * 2; // [-1, 1]
  const r = Math.sqrt(nx * nx + ny * ny);

  // Rounded rectangle bounds for outer shield
  const roundDist = Math.max(Math.abs(nx), Math.abs(ny));
  const cornerDist = Math.sqrt(Math.max(0, Math.abs(nx) - 0.65) ** 2 + Math.max(0, Math.abs(ny) - 0.65) ** 2);
  const inOuterShield = roundDist <= 0.90 && cornerDist <= 0.28;

  if (!inOuterShield) {
    return [0, 0, 0, 0]; // Transparent outside icon shape
  }

  // Base background: Dark Carbon / Titanium (#070a0e to #0f1722)
  const bgGrad = 1 - Math.min(1, r * 0.7);
  let red = 7 + bgGrad * 10;
  let green = 10 + bgGrad * 14;
  let blue = 14 + bgGrad * 20;
  let alpha = 255;

  // Outer Border Glow (Cyan #00e5ff / Green #00ff88)
  const isOuterBorder = (roundDist > 0.83 || cornerDist > 0.22);
  if (isOuterBorder) {
    const t = (ny + 1) * 0.5; // Top cyan, bottom green gradient
    red = 0;
    green = Math.round(229 * (1 - t) + 255 * t);
    blue = Math.round(255 * (1 - t) + 136 * t);
    return [red, green, blue, 255];
  }

  // 4 Corner Sci-Fi Brackets (⌜ ⌝ ⌞ ⌟)
  const ax = Math.abs(nx);
  const ay = Math.abs(ny);
  const isBracketH = (ay >= 0.70 && ay <= 0.75 && ax >= 0.55 && ax <= 0.78);
  const isBracketV = (ax >= 0.73 && ax <= 0.78 && ay >= 0.55 && ay <= 0.75);
  if (isBracketH || isBracketV) {
    return [0, 255, 136, 255]; // Neon emerald #00ff88
  }

  // Circular Reticle Outer Ring (r ~ 0.56)
  if (Math.abs(r - 0.56) < 0.025) {
    return [0, 229, 255, 230]; // Neon cyan #00e5ff
  }

  // Circular Reticle Inner Ring (r ~ 0.38)
  if (Math.abs(r - 0.38) < 0.018) {
    // Tick marks: every 45 degrees
    const angle = Math.atan2(ny, nx);
    const tick = Math.cos(angle * 8);
    if (tick > 0.2) {
      return [0, 229, 255, 240];
    }
  }

  // Crosshairs: Vertical and Horizontal lines
  const isCrosshairX = (Math.abs(ny) < 0.015 && ax >= 0.15 && ax <= 0.65);
  const isCrosshairY = (Math.abs(nx) < 0.015 && ay >= 0.15 && ay <= 0.65);
  if (isCrosshairX || isCrosshairY) {
    return [0, 229, 255, 200];
  }

  // Center Core Hexagon / Reticle (r < 0.22)
  if (r < 0.22) {
    // Center glowing diamond
    const diamond = Math.abs(nx) + Math.abs(ny);
    if (Math.abs(diamond - 0.18) < 0.02) {
      return [0, 255, 136, 255]; // Bright green diamond
    }
    if (diamond < 0.14) {
      // Core glowing nexus
      const core = 1 - diamond / 0.14;
      red = Math.round(core * 0);
      green = Math.round(core * 229 + 10);
      blue = Math.round(core * 255 + 20);
      return [red, green, blue, 255];
    }
  }

  return [red, green, blue, alpha];
}

// Create a Windows 32-bit DIB (Device Independent Bitmap) for ICO entries
function createDibBitmap(width, height, pixelFn) {
  const xorSize = width * height * 4;
  const andRowBytes = Math.ceil(width / 32) * 4;
  const andSize = andRowBytes * height;
  const headerSize = 40;
  const totalSize = headerSize + xorSize + andSize;

  const buffer = Buffer.alloc(totalSize);

  // BITMAPINFOHEADER (40 bytes)
  buffer.writeUInt32LE(40, 0); // biSize
  buffer.writeInt32LE(width, 4); // biWidth
  buffer.writeInt32LE(height * 2, 8); // biHeight (doubled for XOR + AND mask)
  buffer.writeUInt16LE(1, 12); // biPlanes
  buffer.writeUInt16LE(32, 14); // biBitCount (32-bit RGBA)
  buffer.writeUInt32LE(0, 16); // biCompression (BI_RGB)
  buffer.writeUInt32LE(xorSize, 20); // biSizeImage
  buffer.writeInt32LE(0, 24); // biXPelsPerMeter
  buffer.writeInt32LE(0, 28); // biYPelsPerMeter
  buffer.writeUInt32LE(0, 32); // biClrUsed
  buffer.writeUInt32LE(0, 36); // biClrImportant

  // XOR mask (BGRA, bottom-to-top)
  let xorOffset = headerSize;
  for (let y = height - 1; y >= 0; y--) {
    for (let x = 0; x < width; x++) {
      const [r, g, b, a] = pixelFn(x, y, width, height);
      buffer[xorOffset++] = Math.round(b);
      buffer[xorOffset++] = Math.round(g);
      buffer[xorOffset++] = Math.round(r);
      buffer[xorOffset++] = Math.round(a);
    }
  }

  // AND mask (1 bit per pixel, 0 for opaque/semitransparent, 1 for fully transparent)
  let andOffset = headerSize + xorSize;
  for (let y = height - 1; y >= 0; y--) {
    let rowBits = 0;
    let bitCount = 0;
    for (let x = 0; x < width; x++) {
      const [, , , a] = pixelFn(x, y, width, height);
      if (a < 128) {
        rowBits |= (1 << (7 - (bitCount % 8)));
      }
      bitCount++;
      if (bitCount % 8 === 0) {
        buffer[andOffset++] = rowBits;
        rowBits = 0;
      }
    }
    if (bitCount % 8 !== 0) {
      buffer[andOffset++] = rowBits;
    }
    // Pad to 4-byte boundary
    const bytesWrittenInRow = Math.ceil(width / 8);
    const padding = andRowBytes - bytesWrittenInRow;
    for (let p = 0; p < padding; p++) {
      buffer[andOffset++] = 0;
    }
  }

  return buffer;
}

// Assemble multi-resolution ICO file
function generateMultiResIco(entries) {
  // entries: Array of { width, height, buffer, isPng }
  const count = entries.length;
  const header = Buffer.alloc(6);
  header.writeUInt16LE(0, 0); // reserved
  header.writeUInt16LE(1, 2); // 1 = ICO
  header.writeUInt16LE(count, 4);

  let currentOffset = 6 + count * 16;
  const dirEntries = [];

  for (const entry of entries) {
    const dir = Buffer.alloc(16);
    dir.writeUInt8(entry.width >= 256 ? 0 : entry.width, 0);
    dir.writeUInt8(entry.height >= 256 ? 0 : entry.height, 1);
    dir.writeUInt8(0, 2); // Color count
    dir.writeUInt8(0, 3); // Reserved
    dir.writeUInt16LE(1, 4); // Planes
    dir.writeUInt16LE(32, 6); // Bit count
    dir.writeUInt32LE(entry.buffer.length, 8); // Size of image
    dir.writeUInt32LE(currentOffset, 12); // Offset to image
    dirEntries.push(dir);
    currentOffset += entry.buffer.length;
  }

  return Buffer.concat([
    header,
    ...dirEntries,
    ...entries.map(e => e.buffer)
  ]);
}

function main() {
  const assetsDir = path.resolve(__dirname, '..', 'assets');
  if (!fs.existsSync(assetsDir)) {
    fs.mkdirSync(assetsDir, { recursive: true });
  }

  console.log('[IconGenerator] Generating 256x256 PNG master asset...');
  const png256 = encodePng(256, 256, renderHudIconPixel);
  const pngPath = path.join(assetsDir, 'icon.png');
  fs.writeFileSync(pngPath, png256);
  console.log(`[IconGenerator] Wrote PNG: ${pngPath} (${png256.length} bytes)`);

  console.log('[IconGenerator] Generating multi-size Windows ICO...');
  const dib16 = createDibBitmap(16, 16, renderHudIconPixel);
  const dib32 = createDibBitmap(32, 32, renderHudIconPixel);
  const dib48 = createDibBitmap(48, 48, renderHudIconPixel);

  const icoBuffer = generateMultiResIco([
    { width: 16, height: 16, buffer: dib16, isPng: false },
    { width: 32, height: 32, buffer: dib32, isPng: false },
    { width: 48, height: 48, buffer: dib48, isPng: false },
    { width: 256, height: 256, buffer: png256, isPng: true }
  ]);

  const icoPath = path.join(assetsDir, 'icon.ico');
  fs.writeFileSync(icoPath, icoBuffer);
  console.log(`[IconGenerator] Wrote ICO: ${icoPath} (${icoBuffer.length} bytes, 4 resolutions: 16x16, 32x32, 48x48, 256x256)`);
}

if (require.main === module) {
  main();
}

module.exports = {
  renderHudIconPixel,
  encodePng,
  createDibBitmap,
  generateMultiResIco
};
