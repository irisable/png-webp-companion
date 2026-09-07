const assert = require("node:assert/strict");
const Module = require("node:module");

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

const { detectImageMagick, imageMagickCandidates } = PluginClass.__test;

async function run() {
  assert.deepEqual(imageMagickCandidates("darwin"), [
    "/opt/homebrew/bin/magick",
    "/usr/local/bin/magick",
    "magick",
  ]);
  assert.deepEqual(imageMagickCandidates("linux"), [
    "/usr/bin/magick",
    "/usr/local/bin/magick",
    "magick",
  ]);
  assert.deepEqual(imageMagickCandidates("win32"), ["magick.exe", "magick"]);
  assert.deepEqual(
    imageMagickCandidates("win32", " C:\\Tools\\ImageMagick\\magick.exe "),
    ["C:\\Tools\\ImageMagick\\magick.exe"],
  );

  const attempted = [];
  const detected = await detectImageMagick({
    platform: "darwin",
    run: async (executable) => {
      attempted.push(executable);
      if (executable !== "/usr/local/bin/magick") {
        const error = new Error("not found");
        error.code = "ENOENT";
        throw error;
      }
      return {
        stdout: "Version: ImageMagick 7.1.2-29 Q16-HDRI x86_64",
        stderr: "",
      };
    },
  });

  assert.deepEqual(attempted, [
    "/opt/homebrew/bin/magick",
    "/usr/local/bin/magick",
  ]);
  assert.equal(detected.executable, "/usr/local/bin/magick");
  assert.match(detected.version, /^Version: ImageMagick 7\.1\.2-29/u);

  const custom = await detectImageMagick({
    platform: "linux",
    configuredPath: "/srv/tools/magick",
    run: async (executable, args, options) => {
      assert.equal(executable, "/srv/tools/magick");
      assert.deepEqual(args, ["-version"]);
      assert.equal(options.timeout, 5000);
      return { stdout: "ImageMagick 7.1.1", stderr: "" };
    },
  });
  assert.equal(custom.executable, "/srv/tools/magick");

  const unrelatedBinary = await detectImageMagick({
    platform: "win32",
    run: async () => ({ stdout: "unrelated program", stderr: "" }),
  });
  assert.equal(unrelatedBinary, null);

  const missing = await detectImageMagick({
    platform: "linux",
    run: async () => {
      throw new Error("missing");
    },
  });
  assert.equal(missing, null);

  console.log("ImageMagick detection: 9 assertions passed");
}

run().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
