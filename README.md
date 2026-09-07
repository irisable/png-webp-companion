# PNG WebP Companion

A small, non-destructive desktop plugin for Obsidian. It keeps each PNG as the
original, creates a same-name WebP companion, and changes only verified image
links to use the WebP.

## Features

- Waits for a newly added PNG to finish writing before processing it.
- Normalizes new or renamed PNG filenames to conservative slugs. For example,
  `My Image.PNG` becomes `my-image.png`; Unicode letters such as Chinese are
  preserved.
- Creates `name.webp` beside `name.png` with ImageMagick 7 (quality 82,
  WebP method 6).
- Validates the generated WebP before adding it to the vault.
- Preserves the original PNG.
- Rewrites only image links that Obsidian resolves to a plugin-tracked PNG.
  Markdown alt text and titles, plus Wiki-link aliases and sizes, are retained.
- Keeps the WebP companion synchronized after renames or moves inside Obsidian.
- Uses a SHA-256 ledger to follow external Finder/File Explorer renames without
  confusing a real copy with a rename.
- Never overwrites an existing PNG or WebP.
- Ignores PNG files inside the vault's configured settings folder and `.trash`.

Filename normalization is enabled by default and can be disabled in the plugin
settings. Existing images are not renamed or converted in bulk at startup.

## Usage

1. Install [ImageMagick 7](https://imagemagick.org/script/download.php) and
   enable the plugin.
2. Paste, drag, or otherwise add a PNG to the vault. You can rename it before
   or after conversion; the plugin keeps its companion synchronized.
3. After the PNG finishes writing, the plugin creates a same-name WebP beside
   it and updates verified image links to use the WebP. The PNG remains in
   place.

Open the plugin settings to disable filename normalization, specify a custom
`magick` executable, or run detection again.

## Requirements and ImageMagick detection

- Obsidian 1.4.0 or later on desktop.
- A local filesystem vault.
- ImageMagick 7 with the `magick` executable and working WebP encoding support.

When the path setting is empty, the plugin tries:

- Apple Silicon macOS: `/opt/homebrew/bin/magick`.
- Intel macOS: `/usr/local/bin/magick`.
- Linux: `/usr/bin/magick` and `/usr/local/bin/magick`.
- Windows, macOS, and Linux: `magick` or `magick.exe` through `PATH`.

You can also enter the full executable path in the plugin settings and select
**Detect**. Detection performs a tiny in-memory WebP conversion, so a binary
that exists but lacks a working WebP encoder is not reported as usable. If the
required capability is unavailable, the plugin remains loaded but pauses
conversion. It shows one actionable notice and does not block vault loading or
indexing.

## Installation

Copy `main.js` and `manifest.json` into:

```text
<vault>/.obsidian/plugins/png-webp-companion/
```

Then reload Obsidian and enable **PNG WebP Companion** under Community plugins.

For local development, the folder above may be a symlink to this repository.
Use a disposable test vault, not a production vault.

## Privacy and filesystem disclosure

The plugin works locally and makes no network requests. It invokes the locally
installed ImageMagick executable, reads PNG files in the vault, and uses the
operating system temporary directory while generating a WebP. Its `data.json`
stores only plugin settings and the paths, SHA-256 fingerprints, and timestamps
of companions it created.

## Tests

Run platform-independent logic tests:

```sh
npm test
```

Run a real conversion with the locally installed ImageMagick:

```sh
npm run test:imagemagick
```

Run the reproducible Linux/ImageMagick test on a Mac, Linux host, or NAS with
Docker:

```sh
docker build --file Dockerfile.test --tag png-webp-companion-test .
docker run --rm png-webp-companion-test
```

After the repository is hosted on GitHub, the included workflow runs simulated
path/error branches on Intel macOS, Windows x64, and Linux x64. It also runs a
real ImageMagick smoke conversion on Intel macOS, Windows x64, and Linux Docker.

## License

PNG WebP Companion is released under the [MIT License](LICENSE).

---

## 中文说明

这是一个小型、非破坏性的 Obsidian 桌面端插件：保留 PNG 原图，在旁边生成
同名 WebP，并只在转换和目标解析都确认成功后，将对应笔记图片链接改为
WebP。

插件会处理新建或改名后的 PNG，包括粘贴、拖入、Obsidian 内改名，以及
Finder 等外部改名。它通过自己保存的 SHA-256 内容指纹识别改名，不会把
保留着原文件的真正复制误判为移动。

插件默认自动检测 Apple Silicon Homebrew、Intel Mac Homebrew、Linux 常见
路径以及 Windows/macOS/Linux 的 `PATH`。也可以在设置中填写 `magick` 或
`magick.exe` 的完整路径。检测时会在内存中实际编码一张极小的 WebP；若
未安装 ImageMagick 7，或其 WebP 编码能力不可用，插件仍会正常加载，只
暂停转换并给出一次提示，不会阻塞 Vault 加载或索引。

本项目采用 [MIT License](LICENSE) 开源。
