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

const { slugifyPngPath } = PluginClass.__test;

const cases = [
  ["My Image.png", "my-image.png"],
  ["img/My__Image  2.PNG", "img/my-image-2.png"],
  ["img/图片 My Image.png", "img/图片-my-image.png"],
  ["John's (Final) Image.png", "johns-final-image.png"],
  ["Ｍｙ　Image.PNG", "my-image.png"],
  ["Second Picture Final.PNG.png", "second-picture-final.png"],
  ["already-a-slug.png", "already-a-slug.png"],
  ["img/!!!.png", "img/!!!.png"],
  ["My Image.jpg", "My Image.jpg"],
];

for (const [input, expected] of cases) {
  assert.equal(slugifyPngPath(input), expected, input);
}

console.log(`slugify: ${cases.length} cases passed`);
