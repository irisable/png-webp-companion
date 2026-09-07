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

function webpBytes() {
  const bytes = Buffer.alloc(12);
  bytes.write("RIFF", 0, "ascii");
  bytes.write("WEBP", 8, "ascii");
  return bytes;
}

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
    run: async (executable, args, options) => {
      attempted.push(`${executable}:${args[0]}`);
      if (executable !== "/usr/local/bin/magick") {
        const error = new Error("not found");
        error.code = "ENOENT";
        throw error;
      }
      if (args[0] === "-size") {
        assert.deepEqual(args, ["-size", "1x1", "xc:none", "webp:-"]);
        assert.equal(options.encoding, "buffer");
        return { stdout: webpBytes(), stderr: Buffer.alloc(0) };
      }
      return {
        stdout: "Version: ImageMagick 7.1.2-29 Q16-HDRI x86_64",
        stderr: "",
      };
    },
  });

  assert.deepEqual(attempted, [
    "/opt/homebrew/bin/magick:-version",
    "/usr/local/bin/magick:-version",
    "/usr/local/bin/magick:-size",
  ]);
  assert.equal(detected.executable, "/usr/local/bin/magick");
  assert.match(detected.version, /^Version: ImageMagick 7\.1\.2-29/u);

  const custom = await detectImageMagick({
    platform: "linux",
    configuredPath: "/srv/tools/magick",
    run: async (executable, args, options) => {
      assert.equal(executable, "/srv/tools/magick");
      assert.equal(options.timeout, 5000);
      if (args[0] === "-size") {
        assert.deepEqual(args, ["-size", "1x1", "xc:none", "webp:-"]);
        return { stdout: webpBytes(), stderr: Buffer.alloc(0) };
      }
      assert.deepEqual(args, ["-version"]);
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

  const missingWebpEncoder = await detectImageMagick({
    platform: "linux",
    configuredPath: "/usr/bin/magick",
    run: async (_executable, args) => {
      if (args[0] === "-version") {
        return { stdout: "ImageMagick 7.1.2", stderr: "" };
      }
      const error = new Error("delegate failed: cwebp");
      error.code = 1;
      throw error;
    },
  });
  assert.equal(missingWebpEncoder, null);

  const invalidWebpOutput = await detectImageMagick({
    platform: "win32",
    configuredPath: "magick.exe",
    run: async (_executable, args) =>
      args[0] === "-version"
        ? { stdout: "ImageMagick 7.1.2", stderr: "" }
        : { stdout: Buffer.from("not-webp"), stderr: Buffer.alloc(0) },
  });
  assert.equal(invalidWebpOutput, null);

  console.log("ImageMagick detection and WebP capability: all assertions passed");
}

run().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
