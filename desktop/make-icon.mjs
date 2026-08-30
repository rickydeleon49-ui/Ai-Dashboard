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

// A smaller copy for the Linux AppImage and the in-window title bar.
await sharp(buffer).resize(512, 512).png().toFile(path.join(OUT, "icon@512.png"));

await writeFile(path.join(OUT, "icon.svg"), svg.trimStart());

console.log("Icons written to desktop/resources/");
