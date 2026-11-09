/**
 * Copies the terminal's runtime files into desktop/vendor.
 *
 * The installer ships `desktop/**` but not node_modules, so node-pty and xterm
 * are copied here, trimmed to what runs. node-pty is N-API: its prebuilds load
 * in Electron with no rebuild.
 */
import { cp, mkdir, rm, stat } from "node:fs/promises";
import path from "node:path";

async function isFile(p) {
  try {
    return (await stat(p)).isFile();
  } catch {
    return false;
  }
}

/**
 * @param {string} root project root (holds node_modules)
 * @param {string} destDir the vendor folder to (re)create
 * @param {{ platform?: string, arch?: string }} [target]
 */
export async function copyTerminalVendor(root, destDir, { platform = process.platform, arch = process.arch } = {}) {
  const modules = path.join(root, "node_modules");
  const pty = path.join(modules, "node-pty");
  const prebuild = path.join(pty, "prebuilds", `${platform}-${arch}`);
  // node-pty ships prebuilds for Windows and macOS only. Elsewhere (Linux) npm
  // compiles it into build/Release, which node-pty's loader checks first.
  const hasPrebuild = Boolean(await stat(prebuild).catch(() => null));
  const compiled = path.join(pty, "build", "Release");
  if (!hasPrebuild && !(await isFile(path.join(compiled, "pty.node")))) {
    throw new Error(`node-pty has no prebuild or local build for ${platform}-${arch}.`);
  }

  await rm(destDir, { recursive: true, force: true });
  const ptyOut = path.join(destDir, "node-pty");
  await mkdir(ptyOut, { recursive: true });
  await cp(path.join(pty, "package.json"), path.join(ptyOut, "package.json"));
  await cp(path.join(pty, "lib"), path.join(ptyOut, "lib"), {
    recursive: true,
    filter: (src) => !/\.(test\.js|map)$/.test(src),
  });
  if (hasPrebuild) {
    await cp(prebuild, path.join(ptyOut, "prebuilds", `${platform}-${arch}`), {
      recursive: true,
      filter: (src) => !src.endsWith(".pdb"),
    });
  } else {
    // Only the addon and its helper binaries, not the object files.
    await cp(compiled, path.join(ptyOut, "build", "Release"), {
      recursive: true,
      filter: (src) => !/[\\/](obj|obj\.target|\.deps)([\\/]|$)/.test(src) && !/\.(o|d|mk)$/.test(src),
    });
  }

  const xtermOut = path.join(destDir, "xterm");
  await mkdir(xtermOut, { recursive: true });
  const files = [
    ["@xterm/xterm/lib/xterm.js", "xterm.js"],
    ["@xterm/xterm/css/xterm.css", "xterm.css"],
    ["@xterm/addon-fit/lib/addon-fit.js", "addon-fit.js"],
  ];
  for (const [from, to] of files) {
    const src = path.join(modules, from);
    if (!(await isFile(src))) throw new Error(`Missing ${from}; run npm install.`);
    await cp(src, path.join(xtermOut, to));
  }
}
