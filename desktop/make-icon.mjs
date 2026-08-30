/**
 * Generates the application icon.
 *
 * The mark matches the in-app logo (the sidebar brand tile): a rounded violet
 * square carrying a stacked-boxes glyph. electron-builder derives the .ico and
 * .icns it needs from the 1024px PNG produced here, so this is the only source
 * of truth for the icon across all three platforms.
 *
 * Run with `npm run desktop:icon` after changing the artwork.
 */
import { writeFile } from "node:fs/promises";
import path from "node:path";
import sharp from "sharp";

/**
 * Builds a Windows .ico containing several sizes.
 *
 * Each entry is a classic BMP/DIB rather than an embedded PNG: NSIS parses the
 * installer icon itself and rejects PNG-compressed entries with "invalid icon
 * file", so a PNG — or a PNG-based .ico — cannot be used for the installer.
 */
async function buildIco(svgBuffer, sizes) {
  const images = [];

  for (const size of sizes) {
    const rgba = await sharp(svgBuffer)
      .resize(size, size)
      .ensureAlpha()
      .raw()
      .toBuffer();

    // DIB pixel data is BGRA and stored bottom-up.
    const xor = Buffer.alloc(size * size * 4);
    for (let y = 0; y < size; y += 1) {
      const src = (size - 1 - y) * size * 4;
      const dst = y * size * 4;
      for (let x = 0; x < size * 4; x += 4) {
        xor[dst + x] = rgba[src + x + 2];
        xor[dst + x + 1] = rgba[src + x + 1];
        xor[dst + x + 2] = rgba[src + x];
        xor[dst + x + 3] = rgba[src + x + 3];
      }
    }

    // 1bpp AND mask, rows padded to 4 bytes. Alpha carries transparency, so
    // the mask is fully opaque (all zero) — but the structure must be present.
    const maskRow = Math.ceil(size / 32) * 4;
    const mask = Buffer.alloc(maskRow * size);

    const header = Buffer.alloc(40);
    header.writeUInt32LE(40, 0); // biSize
    header.writeInt32LE(size, 4); // biWidth
    header.writeInt32LE(size * 2, 8); // biHeight: XOR image plus AND mask
    header.writeUInt16LE(1, 12); // biPlanes
    header.writeUInt16LE(32, 14); // biBitCount
    header.writeUInt32LE(0, 16); // biCompression: BI_RGB
    header.writeUInt32LE(xor.length + mask.length, 20); // biSizeImage

    images.push({ size, data: Buffer.concat([header, xor, mask]) });
  }

  const dir = Buffer.alloc(6);
  dir.writeUInt16LE(0, 0); // reserved
  dir.writeUInt16LE(1, 2); // type: icon
  dir.writeUInt16LE(images.length, 4);

  const entries = Buffer.alloc(16 * images.length);
  let offset = dir.length + entries.length;

  images.forEach((image, i) => {
    const at = i * 16;
    // 256 is encoded as 0 in a single byte.
    entries.writeUInt8(image.size === 256 ? 0 : image.size, at);
    entries.writeUInt8(image.size === 256 ? 0 : image.size, at + 1);
    entries.writeUInt8(0, at + 2); // palette colours
    entries.writeUInt8(0, at + 3); // reserved
    entries.writeUInt16LE(1, at + 4); // colour planes
    entries.writeUInt16LE(32, at + 6); // bits per pixel
    entries.writeUInt32LE(image.data.length, at + 8);
    entries.writeUInt32LE(offset, at + 12);
    offset += image.data.length;
  });

  return Buffer.concat([dir, entries, ...images.map((i) => i.data)]);
}

const OUT = path.join(process.cwd(), "desktop", "resources");

/*
 * Drawn at a 1024 viewBox. The glyph is Lucide's "boxes" path, scaled and
 * centred, stroked in white on the brand violet used by --accent.
 */
const svg = `
<svg xmlns="http://www.w3.org/2000/svg" width="1024" height="1024" viewBox="0 0 1024 1024">
  <defs>
    <linearGradient id="bg" x1="0" y1="0" x2="0" y2="1">
      <stop offset="0%" stop-color="#7c66d9"/>
      <stop offset="100%" stop-color="#5b45b0"/>
    </linearGradient>
  </defs>

  <rect width="1024" height="1024" rx="228" fill="url(#bg)"/>

  <g transform="translate(512 512) scale(21.3) translate(-12 -12)"
     fill="none" stroke="#ffffff" stroke-width="1.7"
     stroke-linecap="round" stroke-linejoin="round">
    <path d="M2.97 12.92A2 2 0 0 0 2 14.63v3.24a2 2 0 0 0 .97 1.71l3 1.8a2 2 0 0 0 2.06 0L12 19.05v-5.66l-3.03-1.82a2 2 0 0 0-2.06 0z"/>
    <path d="m7 16.5-4.74-2.85"/>
    <path d="m7 16.5 5-3"/>
    <path d="M7 16.5v5.17"/>
    <path d="M12 13.39v5.66l3.97 2.33a2 2 0 0 0 2.06 0l3-1.8a2 2 0 0 0 .97-1.71v-3.24a2 2 0 0 0-.97-1.71l-3-1.8a2 2 0 0 0-2.06 0z"/>
    <path d="m17 16.5-5-3"/>
    <path d="m17 16.5 4.74-2.85"/>
    <path d="M17 16.5v5.17"/>
    <path d="M7.97 4.42A2 2 0 0 0 7 6.13v4.35l3.03 1.82a2 2 0 0 0 2.06 0L15 10.5V6.13a2 2 0 0 0-.97-1.71l-3-1.8a2 2 0 0 0-2.06 0z"/>
    <path d="M12 8 7.26 5.15"/>
    <path d="m12 8 4.74-2.85"/>
    <path d="M12 13.5V8"/>
  </g>
</svg>`;

const buffer = Buffer.from(svg);

// electron-builder generates .ico / .icns from this single 1024px source.
await sharp(buffer).resize(1024, 1024).png().toFile(path.join(OUT, "icon.png"));

await writeFile(path.join(OUT, "icon.svg"), svg.trimStart());

// Windows: the app icon, the installer and the uninstaller all read this.
const ico = await buildIco(buffer, [16, 24, 32, 48, 64, 128, 256]);
await writeFile(path.join(OUT, "icon.ico"), ico);

console.log("Icons written to desktop/resources/");
