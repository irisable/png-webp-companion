const assert = require("node:assert/strict");
const { execFile } = require("node:child_process");
const fs = require("node:fs/promises");
const Module = require("node:module");
const os = require("node:os");
const path = require("node:path");
const { promisify } = require("node:util");

const execFileAsync = promisify(execFile);
const originalLoad = Module._load;
Module._load = function loadWithObsidianStub(request, parent, isMain) {
  if (request === "obsidian") {
    return {
      FileSystemAdapter: class FileSystemAdapter {},
      Notice: class Notice {},
      Plugin: class Plugin {},
      PluginSettingTab: class PluginSettingTab {},
      Setting: class Setting {},
      TFile: class TFile {},
      normalizePath: (value) => value,
    };
  }
  return originalLoad.call(this, request, parent, isMain);
};

const PluginClass = require("../main.js");
Module._load = originalLoad;

const { detectImageMagick } = PluginClass.__test;

async function run() {
  const detected = await detectImageMagick({
    configuredPath: process.env.IMAGEMAGICK_PATH ?? "",
  });
  assert.ok(detected, "ImageMagick 7 magick executable was not detected");

  const temporaryDirectory = await fs.mkdtemp(
    path.join(os.tmpdir(), "png-webp-smoke-"),
  );
  const pngPath = path.join(temporaryDirectory, "My Image.PNG");
  const webpPath = path.join(temporaryDirectory, "my-image.webp");

  try {
    await execFileAsync(detected.executable, [
      "-size",
      "16x12",
      "xc:#336699",
      pngPath,
    ]);
    await execFileAsync(detected.executable, [
      pngPath,
      "-auto-orient",
      "-quality",
      "82",
      "-define",
      "webp:method=6",
      `webp:${webpPath}`,
    ]);
    const identified = await execFileAsync(detected.executable, [
      "identify",
      "-format",
      "%m %wx%h",
      webpPath,
    ]);

    assert.equal(identified.stdout.trim(), "WEBP 16x12");
    assert.ok((await fs.stat(webpPath)).size > 0);
    console.log(
      `ImageMagick smoke: ${process.platform}/${process.arch} using ${detected.executable}`,
    );
  } finally {
    await fs.rm(temporaryDirectory, { force: true, recursive: true });
  }
}

run().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
