const {
  FileSystemAdapter,
  Notice,
  Plugin,
  PluginSettingTab,
  Setting,
  TFile,
  normalizePath,
} = require("obsidian");
const { execFile } = require("node:child_process");
const { createHash } = require("node:crypto");
const fs = require("node:fs/promises");
const os = require("node:os");
const path = require("node:path");
const { promisify } = require("node:util");

const execFileAsync = promisify(execFile);

const WEBP_QUALITY = 82;
const MAGICK_PROBE_TIMEOUT_MS = 5000;
const CREATE_DELAY_MS = 5000;
const NOTE_REWRITE_DELAY_MS = 350;
const STABILITY_POLL_MS = 400;
const STABILITY_ATTEMPTS = 15;
const MAX_LEDGER_ENTRIES = 5000;
const INTERNAL_RENAME_TTL_MS = 10000;
const LOG_PREFIX = "[PNG WebP Companion]";
const DEFAULT_SETTINGS = Object.freeze({
  normalizePngFileNames: true,
  imageMagickPath: "",
});

function imageMagickCandidates(
  platform = process.platform,
  configuredPath = "",
) {
  const customPath = configuredPath.trim();
  if (customPath) return [customPath];

  const candidates =
    platform === "darwin"
      ? [
          "/opt/homebrew/bin/magick",
          "/usr/local/bin/magick",
          "magick",
        ]
      : platform === "win32"
        ? ["magick.exe", "magick"]
        : ["/usr/bin/magick", "/usr/local/bin/magick", "magick"];

  return [...new Set(candidates)];
}

async function detectImageMagick({
  platform = process.platform,
  configuredPath = "",
  run = execFileAsync,
} = {}) {
  for (const executable of imageMagickCandidates(platform, configuredPath)) {
    try {
      const result = await run(executable, ["-version"], {
        maxBuffer: 1024 * 1024,
        timeout: MAGICK_PROBE_TIMEOUT_MS,
      });
      const stdout = Buffer.isBuffer(result?.stdout)
        ? result.stdout.toString("utf8")
        : (result?.stdout ?? "");
      const stderr = Buffer.isBuffer(result?.stderr)
        ? result.stderr.toString("utf8")
        : (result?.stderr ?? "");
      const output = `${stdout}\n${stderr}`;
      if (!/\bImageMagick\b/i.test(output)) continue;

      const webpProbe = await run(
        executable,
        ["-size", "1x1", "xc:none", "webp:-"],
        {
          encoding: "buffer",
          maxBuffer: 1024 * 1024,
          timeout: MAGICK_PROBE_TIMEOUT_MS,
        },
      );
      const webpBytes = Buffer.isBuffer(webpProbe?.stdout)
        ? webpProbe.stdout
        : Buffer.from(webpProbe?.stdout ?? "", "binary");
      const hasWebpSignature =
        webpBytes.length >= 12 &&
        webpBytes.subarray(0, 4).toString("ascii") === "RIFF" &&
        webpBytes.subarray(8, 12).toString("ascii") === "WEBP";
      if (!hasWebpSignature) continue;

      return {
        executable,
        version: output
          .split(/\r?\n/u)
          .map((line) => line.trim())
          .find(Boolean) ?? "ImageMagick",
      };
    } catch {
      // Try the next well-known path or PATH command.
    }
  }

  return null;
}

function isPng(vaultPath) {
  return /\.png$/i.test(vaultPath);
}

function shouldIgnore(vaultPath, configDir = ".obsidian") {
  const normalizedConfigDir = normalizePath(configDir).replace(/\/+$/u, "");
  const isInsideConfigDir =
    normalizedConfigDir.length > 0 &&
    (vaultPath === normalizedConfigDir ||
      vaultPath.startsWith(`${normalizedConfigDir}/`));

  return (
    isInsideConfigDir ||
    vaultPath.startsWith(".trash/") ||
    vaultPath.includes("/.trash/")
  );
}

function companionPath(vaultPath) {
  return normalizePath(vaultPath.replace(/\.png$/i, ".webp"));
}

function slugifyPngPath(vaultPath) {
  if (!isPng(vaultPath)) return vaultPath;

  const lastSlash = vaultPath.lastIndexOf("/");
  const folder = lastSlash === -1 ? "" : vaultPath.slice(0, lastSlash + 1);
  const fileName = vaultPath.slice(lastSlash + 1);
  const stem = fileName.slice(0, -4).replace(/(?:\.png)+$/i, "");
  const slug = stem
    .normalize("NFKC")
    .toLowerCase()
    .replace(/['’]/gu, "")
    .replace(/[^\p{L}\p{N}]+/gu, "-")
    .replace(/^-+|-+$/gu, "");

  if (!slug) return vaultPath;
  return normalizePath(`${folder}${slug}.png`);
}

function sleep(milliseconds) {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

function replacePngExtension(linkTarget) {
  return linkTarget.replace(/\.png(?=(?:[?#][\s\S]*)?\s*$)/i, ".webp");
}

function isEscaped(value, index) {
  let slashCount = 0;

  for (let position = index - 1; position >= 0; position -= 1) {
    if (value[position] !== "\\") break;
    slashCount += 1;
  }

  return slashCount % 2 === 1;
}

function rewriteWikiReference(original) {
  const opening = original.indexOf("[[");
  const closing = original.lastIndexOf("]]");
  if (opening === -1 || closing <= opening + 2) return original;

  const targetStart = opening + 2;
  let targetEnd = closing;

  for (let index = targetStart; index < closing; index += 1) {
    if (original[index] === "|" && !isEscaped(original, index)) {
      targetEnd = index;
      break;
    }
  }

  const target = original.slice(targetStart, targetEnd);
  const rewrittenTarget = replacePngExtension(target);
  if (rewrittenTarget === target) return original;

  return (
    original.slice(0, targetStart) +
    rewrittenTarget +
    original.slice(targetEnd)
  );
}

function rewriteMarkdownReference(original) {
  const opening = original.lastIndexOf("](");
  if (opening === -1) return original;

  let targetStart = opening + 2;
  while (/\s/.test(original[targetStart] ?? "")) targetStart += 1;
  if (targetStart >= original.length) return original;

  let targetEnd;
  let contentStart = targetStart;

  if (original[targetStart] === "<") {
    contentStart += 1;
    targetEnd = contentStart;
    while (targetEnd < original.length) {
      if (original[targetEnd] === ">" && !isEscaped(original, targetEnd)) break;
      targetEnd += 1;
    }
    if (targetEnd >= original.length) return original;
  } else {
    targetEnd = targetStart;
    let nestedParentheses = 0;

    while (targetEnd < original.length) {
      const character = original[targetEnd];

      if (character === "\\") {
        targetEnd += 2;
        continue;
      }
      if (character === "(") {
        nestedParentheses += 1;
      } else if (character === ")") {
        if (nestedParentheses === 0) break;
        nestedParentheses -= 1;
      } else if (/\s/.test(character) && nestedParentheses === 0) {
        break;
      }

      targetEnd += 1;
    }
  }

  const target = original.slice(contentStart, targetEnd);
  const rewrittenTarget = replacePngExtension(target);
  if (rewrittenTarget === target) return original;

  return (
    original.slice(0, contentStart) +
    rewrittenTarget +
    original.slice(targetEnd)
  );
}

function rewriteReference(original) {
  if (typeof original !== "string") return original;
  if (original.includes("[[")) return rewriteWikiReference(original);
  return rewriteMarkdownReference(original);
}

class PngWebpCompanionSettingTab extends PluginSettingTab {
  constructor(app, plugin) {
    super(app, plugin);
    this.plugin = plugin;
  }

  display() {
    const { containerEl } = this;
    containerEl.empty();

    const magickDescription =
      this.plugin.magickProbeState === "available"
        ? `已检测到：${this.plugin.magickExecutable}\n${this.plugin.magickVersion}`
        : this.plugin.magickProbeState === "missing"
          ? "未检测到可用的 ImageMagick 7 WebP 转换能力。插件保持加载，但暂停图片转换，不会影响 Vault 使用。"
          : this.plugin.magickProbeState === "checking"
            ? "正在检测 ImageMagick…"
            : "留空时自动检测常见安装路径和 PATH；也可以填写 magick 或 magick.exe 的完整路径。";

    new Setting(containerEl)
      .setName("ImageMagick 路径")
      .setDesc(magickDescription)
      .addText((text) =>
        text
          .setPlaceholder("自动检测（推荐）")
          .setValue(this.plugin.settings.imageMagickPath)
          .onChange(async (value) => {
            this.plugin.settings.imageMagickPath = value.trim();
            this.plugin.magickExecutable = null;
            this.plugin.magickVersion = "";
            this.plugin.magickProbeState = "unchecked";
            await this.plugin.savePluginData();
          }),
      )
      .addButton((button) =>
        button.setButtonText("检测").onClick(async () => {
          button.setDisabled(true);
          await this.plugin.refreshImageMagick({
            notifyIfMissing: true,
            notifyOnSuccess: true,
          });
          this.display();
        }),
      );

    new Setting(containerEl)
      .setName("自动规范化 PNG 文件名")
      .setDesc(
        "新建或重命名的 PNG 使用 slug 格式，例如 My Image.PNG → my-image.png。中文会保留；若目标已存在则跳过。",
      )
      .addToggle((toggle) =>
        toggle
          .setValue(this.plugin.settings.normalizePngFileNames)
          .onChange(async (value) => {
            this.plugin.settings.normalizePngFileNames = value;
            await this.plugin.savePluginData();
          }),
      );
  }
}

class PngWebpCompanionPlugin extends Plugin {
  async onload() {
    this.pending = new Map();
    this.tokens = new Map();
    this.noteRewriteTimers = new Map();
    this.internalRenameTimers = new Map();
    this.stopping = false;
    this.watching = false;
    this.magickExecutable = null;
    this.magickVersion = "";
    this.magickProbeState = "unchecked";
    this.hasShownMissingNotice = false;

    if (!(this.app.vault.adapter instanceof FileSystemAdapter)) {
      new Notice("PNG WebP Companion 只能在本机文件系统 Vault 中运行。");
      return;
    }

    this.vaultBasePath = this.app.vault.adapter.getBasePath();
    const savedData = await this.loadData();
    this.settings = {
      ...DEFAULT_SETTINGS,
      ...(savedData?.settings ?? {}),
    };
    this.companions = Array.isArray(savedData?.companions)
      ? savedData.companions.filter(
          (item) =>
            typeof item?.pngPath === "string" &&
            typeof item?.webpPath === "string" &&
            typeof item?.sha256 === "string",
        )
      : [];

    this.addSettingTab(new PngWebpCompanionSettingTab(this.app, this));
    this.app.workspace.onLayoutReady(() => {
      this.startWatching();
      void this.refreshImageMagick({ notifyIfMissing: true });
    });
    console.info(`${LOG_PREFIX} loaded; waiting for workspace`);
  }

  async refreshImageMagick({
    notifyIfMissing = false,
    notifyOnSuccess = false,
  } = {}) {
    this.magickProbeState = "checking";
    const result = await detectImageMagick({
      configuredPath: this.settings.imageMagickPath,
    });

    if (result) {
      this.magickExecutable = result.executable;
      this.magickVersion = result.version;
      this.magickProbeState = "available";
      this.hasShownMissingNotice = false;
      console.info(
        `${LOG_PREFIX} using ImageMagick: ${result.executable} (${result.version})`,
      );
      if (notifyOnSuccess) {
        new Notice(`已检测到 ImageMagick：${result.executable}`);
      }
      return true;
    }

    this.magickExecutable = null;
    this.magickVersion = "";
    this.magickProbeState = "missing";
    console.warn(
      `${LOG_PREFIX} ImageMagick 7 with WebP encoding is unavailable; conversion is paused`,
    );

    if (notifyIfMissing && !this.hasShownMissingNotice) {
      this.hasShownMissingNotice = true;
      new Notice(
        "未检测到可用的 ImageMagick 7 WebP 转换能力。PNG WebP Companion 已暂停转换；Vault 可正常使用。请安装支持 WebP 的 ImageMagick 7，或在插件设置中指定 magick 路径。",
        10000,
      );
    }

    return false;
  }

  startWatching() {
    if (this.stopping || this.watching) return;
    this.watching = true;

    this.registerEvent(
      this.app.vault.on("create", (file) => {
        if (file instanceof TFile && this.canHandle(file.path)) {
          this.schedule(file.path);
        }
      }),
    );

    this.registerEvent(
      this.app.vault.on("delete", (file) => {
        if (file instanceof TFile && this.canHandle(file.path)) {
          this.invalidate(file.path);
        }
      }),
    );

    this.registerEvent(
      this.app.vault.on("rename", (file, oldPath) => {
        if (file instanceof TFile && this.canHandle(file.path)) {
          if (this.consumeInternalRename(oldPath, file.path)) return;

          void this.handlePngRenameEvent(file, oldPath).catch((error) => {
            this.reportError(`处理 PNG 重命名失败：${oldPath}`, error);
          });
        }
      }),
    );

    this.registerEvent(
      this.app.metadataCache.on("changed", (file) => {
        if (file instanceof TFile && file.extension === "md") {
          this.scheduleTrackedReferenceRewrite(file.path);
        }
      }),
    );

    console.info(`${LOG_PREFIX} watching for new PNG files`);
  }

  onunload() {
    this.stopping = true;
    for (const item of this.pending.values()) {
      window.clearTimeout(item.timerId);
    }
    for (const timerId of this.noteRewriteTimers.values()) {
      window.clearTimeout(timerId);
    }
    for (const timerId of this.internalRenameTimers.values()) {
      window.clearTimeout(timerId);
    }
    this.pending.clear();
    this.tokens.clear();
    this.noteRewriteTimers.clear();
    this.internalRenameTimers.clear();
    console.info(`${LOG_PREFIX} unloaded`);
  }

  canHandle(vaultPath) {
    return (
      isPng(vaultPath) &&
      !shouldIgnore(vaultPath, this.app.vault.configDir)
    );
  }

  schedule(vaultPath) {
    this.invalidate(vaultPath);

    const token = Symbol(vaultPath);
    const timerId = window.setTimeout(() => {
      this.pending.delete(vaultPath);
      void this.createCompanion(vaultPath, token);
    }, CREATE_DELAY_MS);

    this.tokens.set(vaultPath, token);
    this.pending.set(vaultPath, { timerId, token });
  }

  invalidate(vaultPath) {
    const pending = this.pending.get(vaultPath);
    if (pending) {
      window.clearTimeout(pending.timerId);
      this.pending.delete(vaultPath);
    }
    this.tokens.delete(vaultPath);
  }

  isCurrent(vaultPath, token) {
    return !this.stopping && this.tokens.get(vaultPath) === token;
  }

  internalRenameKey(oldPath, newPath) {
    return `${oldPath}\u0000${newPath}`;
  }

  markInternalRename(oldPath, newPath) {
    const key = this.internalRenameKey(oldPath, newPath);
    const existingTimer = this.internalRenameTimers.get(key);
    if (existingTimer) window.clearTimeout(existingTimer);

    const timerId = window.setTimeout(() => {
      this.internalRenameTimers.delete(key);
    }, INTERNAL_RENAME_TTL_MS);
    this.internalRenameTimers.set(key, timerId);
  }

  clearInternalRename(oldPath, newPath) {
    const key = this.internalRenameKey(oldPath, newPath);
    const timerId = this.internalRenameTimers.get(key);
    if (timerId === undefined) return;
    window.clearTimeout(timerId);
    this.internalRenameTimers.delete(key);
  }

  consumeInternalRename(oldPath, newPath) {
    const key = this.internalRenameKey(oldPath, newPath);
    if (!this.internalRenameTimers.has(key)) return false;
    this.clearInternalRename(oldPath, newPath);
    return true;
  }

  async normalizePngFileName(file, token) {
    if (!this.settings.normalizePngFileNames) return file.path;

    const oldPath = file.path;
    const newPath = slugifyPngPath(oldPath);
    if (newPath === oldPath) return oldPath;

    const target = this.app.vault.getAbstractFileByPath(newPath);
    if (target && target !== file) {
      console.warn(`${LOG_PREFIX} kept ${oldPath}: ${newPath} already exists`);
      new Notice(`Slug 文件名已存在，保留原名：${oldPath}`);
      return oldPath;
    }

    this.markInternalRename(oldPath, newPath);
    try {
      await this.app.fileManager.renameFile(file, newPath);
    } catch (error) {
      this.clearInternalRename(oldPath, newPath);
      this.reportError(`无法规范化 PNG 文件名：${oldPath}`, error);
      return oldPath;
    }

    if (token && this.tokens.get(oldPath) === token) {
      this.tokens.delete(oldPath);
      this.tokens.set(newPath, token);
    }

    console.info(`${LOG_PREFIX} slugged ${oldPath} -> ${newPath}`);
    return newPath;
  }

  async handlePngRenameEvent(file, oldPath) {
    const eventPath = file.path;
    const newPath = await this.normalizePngFileName(file);
    if (newPath !== eventPath) this.invalidate(eventPath);
    await this.handlePngRename(newPath, oldPath);
  }

  scheduleTrackedReferenceRewrite(notePath) {
    const existingTimer = this.noteRewriteTimers.get(notePath);
    if (existingTimer) window.clearTimeout(existingTimer);

    const timerId = window.setTimeout(() => {
      this.noteRewriteTimers.delete(notePath);
      void this.rewriteTrackedReferencesInNote(notePath).catch((error) => {
        this.reportError(`更新 WebP 链接失败：${notePath}`, error);
      });
    }, NOTE_REWRITE_DELAY_MS);

    this.noteRewriteTimers.set(notePath, timerId);
  }

  async handlePngRename(newPath, oldPath) {
    this.invalidate(oldPath);

    const oldWebpPath = companionPath(oldPath);
    const newWebpPath = companionPath(newPath);
    const oldCompanion = this.app.vault.getAbstractFileByPath(oldWebpPath);

    let ledgerWebpPath = oldWebpPath;
    let companionRenameSucceeded = true;

    if (oldCompanion instanceof TFile && oldWebpPath !== newWebpPath) {
      const target = this.app.vault.getAbstractFileByPath(newWebpPath);

      if (target) {
        companionRenameSucceeded = false;
        console.warn(
          `${LOG_PREFIX} kept ${oldWebpPath}: ${newWebpPath} already exists`,
        );
        new Notice(`同名 WebP 已存在，未移动：${oldWebpPath}`);
      } else {
        try {
          await this.app.fileManager.renameFile(oldCompanion, newWebpPath);
          ledgerWebpPath = newWebpPath;
          console.info(`${LOG_PREFIX} renamed ${oldWebpPath} -> ${newWebpPath}`);
        } catch (error) {
          companionRenameSucceeded = false;
          this.reportError(`无法同步重命名 ${oldWebpPath}`, error);
        }
      }
    }

    const ledgerItem = this.companions.find((item) => item.pngPath === oldPath);
    if (ledgerItem && companionRenameSucceeded) {
      ledgerItem.pngPath = newPath;
      ledgerItem.webpPath = ledgerWebpPath;
      ledgerItem.updatedAt = Date.now();
      await this.saveLedger();
    }

    if (companionRenameSucceeded) {
      await this.rewriteReferencesForPng(newPath);
    }

    this.schedule(newPath);
  }

  async createCompanion(vaultPath, token) {
    let temporaryDirectory;

    try {
      if (!this.isCurrent(vaultPath, token)) return;

      const source = this.app.vault.getAbstractFileByPath(vaultPath);
      if (!(source instanceof TFile) || !this.canHandle(source.path)) return;

      let absoluteSourcePath = path.join(this.vaultBasePath, vaultPath);
      const stable = await this.waitUntilStable(absoluteSourcePath, vaultPath, token);
      if (!stable || !this.isCurrent(vaultPath, token)) return;

      const sourceHash = await this.hashFile(absoluteSourcePath);
      if (!this.isCurrent(vaultPath, token)) return;

      vaultPath = await this.normalizePngFileName(source, token);
      if (!this.isCurrent(vaultPath, token)) return;
      absoluteSourcePath = path.join(this.vaultBasePath, vaultPath);

      const webpPath = companionPath(vaultPath);
      if (this.app.vault.getAbstractFileByPath(webpPath)) return;

      const reused = await this.reuseRenamedCompanion(
        vaultPath,
        webpPath,
        sourceHash,
      );
      if (reused) {
        await this.rewriteReferencesForPng(vaultPath);
        return;
      }

      if (!this.magickExecutable) {
        console.warn(
          `${LOG_PREFIX} skipped ${vaultPath}: ImageMagick is unavailable`,
        );
        return;
      }

      const magickExecutable = this.magickExecutable;

      temporaryDirectory = await fs.mkdtemp(
        path.join(os.tmpdir(), "obsidian-png-webp-"),
      );
      const temporaryWebpPath = path.join(temporaryDirectory, "companion.webp");

      await execFileAsync(
        magickExecutable,
        [
          absoluteSourcePath,
          "-auto-orient",
          "-quality",
          String(WEBP_QUALITY),
          "-define",
          "webp:method=6",
          `webp:${temporaryWebpPath}`,
        ],
        { maxBuffer: 1024 * 1024 },
      );

      const identifyResult = await execFileAsync(
        magickExecutable,
        ["identify", "-format", "%m", temporaryWebpPath],
        { maxBuffer: 1024 * 1024 },
      );

      if (identifyResult.stdout.trim() !== "WEBP") {
        throw new Error("ImageMagick 输出文件不是有效的 WebP");
      }

      if (!this.isCurrent(vaultPath, token)) return;

      const currentSource = this.app.vault.getAbstractFileByPath(vaultPath);
      if (!(currentSource instanceof TFile)) return;
      if (this.app.vault.getAbstractFileByPath(webpPath)) return;

      const webpBytes = await fs.readFile(temporaryWebpPath);
      const webpArrayBuffer = webpBytes.buffer.slice(
        webpBytes.byteOffset,
        webpBytes.byteOffset + webpBytes.byteLength,
      );

      await this.app.vault.createBinary(webpPath, webpArrayBuffer);
      await this.recordCompanion(vaultPath, webpPath, sourceHash);
      console.info(`${LOG_PREFIX} created ${webpPath}`);

      try {
        await this.rewriteReferencesForPng(vaultPath);
      } catch (error) {
        this.reportError(`WebP 已生成，但更新笔记链接失败：${vaultPath}`, error);
      }
    } catch (error) {
      if (error?.code === "ENOENT") {
        this.magickExecutable = null;
        this.magickVersion = "";
        this.magickProbeState = "missing";
        if (!this.hasShownMissingNotice) {
          this.hasShownMissingNotice = true;
          new Notice(
            "ImageMagick 已不可用，PNG WebP Companion 已暂停转换；Vault 可正常使用。请在插件设置中重新检测。",
            10000,
          );
        }
        console.error(`${LOG_PREFIX} ImageMagick executable disappeared`, error);
      } else {
        this.reportError(`转换失败：${vaultPath}`, error);
      }
    } finally {
      if (this.tokens.get(vaultPath) === token) {
        this.tokens.delete(vaultPath);
      }
      if (temporaryDirectory) {
        await fs.rm(temporaryDirectory, { force: true, recursive: true }).catch(
          () => {},
        );
      }
    }
  }

  async hashFile(absolutePath) {
    const bytes = await fs.readFile(absolutePath);
    return createHash("sha256").update(bytes).digest("hex");
  }

  async reuseRenamedCompanion(pngPath, webpPath, sha256) {
    const candidates = [];

    for (const item of this.companions) {
      if (item.sha256 !== sha256 || item.pngPath === pngPath) continue;

      const oldPngExists = await fs
        .stat(path.join(this.vaultBasePath, item.pngPath))
        .then(() => true)
        .catch(() => false);
      const oldWebp = this.app.vault.getAbstractFileByPath(item.webpPath);

      if (!oldPngExists && oldWebp instanceof TFile) {
        candidates.push({ item, oldWebp });
      }
    }

    if (candidates.length !== 1) return false;
    if (this.app.vault.getAbstractFileByPath(webpPath)) return false;

    const [{ item, oldWebp }] = candidates;
    await this.app.fileManager.renameFile(oldWebp, webpPath);
    item.pngPath = pngPath;
    item.webpPath = webpPath;
    item.updatedAt = Date.now();
    await this.saveLedger();
    console.info(`${LOG_PREFIX} followed external rename -> ${webpPath}`);
    return true;
  }

  async rewriteReferencesForPng(pngPath) {
    const referringNotes = [];
    const resolvedLinks = this.app.metadataCache.resolvedLinks ?? {};

    for (const [notePath, destinations] of Object.entries(resolvedLinks)) {
      if ((destinations?.[pngPath] ?? 0) > 0) referringNotes.push(notePath);
    }

    let changedReferences = 0;
    for (const notePath of referringNotes) {
      changedReferences += await this.rewriteTrackedReferencesInNote(
        notePath,
        new Set([pngPath]),
      );
    }

    if (changedReferences > 0) {
      console.info(
        `${LOG_PREFIX} changed ${changedReferences} reference(s) to WebP`,
      );
    }

    return changedReferences;
  }

  async rewriteTrackedReferencesInNote(notePath, allowedPngPaths) {
    const note = this.app.vault.getAbstractFileByPath(notePath);
    if (!(note instanceof TFile) || note.extension !== "md") return 0;

    const trackedCompanions = new Map();
    for (const item of this.companions) {
      if (allowedPngPaths && !allowedPngPaths.has(item.pngPath)) continue;
      const webp = this.app.vault.getAbstractFileByPath(item.webpPath);
      if (webp instanceof TFile) trackedCompanions.set(item.pngPath, item);
    }
    if (trackedCompanions.size === 0) return 0;

    const cache = this.app.metadataCache.getFileCache(note);
    if (!cache) return 0;

    const references = [...(cache.links ?? []), ...(cache.embeds ?? [])];
    const candidates = [];
    const seenRanges = new Set();

    for (const reference of references) {
      const start = reference?.position?.start?.offset;
      const end = reference?.position?.end?.offset;
      if (
        typeof reference?.link !== "string" ||
        typeof reference?.original !== "string" ||
        !Number.isInteger(start) ||
        !Number.isInteger(end) ||
        end <= start
      ) {
        continue;
      }

      const destination = this.app.metadataCache.getFirstLinkpathDest(
        reference.link,
        note.path,
      );
      if (!(destination instanceof TFile)) continue;
      const trackedCompanion = trackedCompanions.get(destination.path);
      if (!trackedCompanion) continue;

      const rewrittenLink = replacePngExtension(reference.link);
      if (rewrittenLink === reference.link) continue;
      const rewrittenDestination = this.app.metadataCache.getFirstLinkpathDest(
        rewrittenLink,
        note.path,
      );
      if (
        !(rewrittenDestination instanceof TFile) ||
        rewrittenDestination.path !== trackedCompanion.webpPath
      ) {
        continue;
      }

      const rewritten = rewriteReference(reference.original);
      if (rewritten === reference.original) continue;

      const rangeKey = `${start}:${end}`;
      if (seenRanges.has(rangeKey)) continue;
      seenRanges.add(rangeKey);
      candidates.push({
        start,
        end,
        original: reference.original,
        rewritten,
      });
    }

    if (candidates.length === 0) return 0;
    candidates.sort((left, right) => right.start - left.start);

    let changedReferences = 0;
    await this.app.vault.process(note, (content) => {
      let updatedContent = content;

      for (const candidate of candidates) {
        if (
          updatedContent.slice(candidate.start, candidate.end) !==
          candidate.original
        ) {
          continue;
        }

        updatedContent =
          updatedContent.slice(0, candidate.start) +
          candidate.rewritten +
          updatedContent.slice(candidate.end);
        changedReferences += 1;
      }

      return updatedContent;
    });

    return changedReferences;
  }

  async recordCompanion(pngPath, webpPath, sha256) {
    this.companions = this.companions.filter(
      (item) => item.pngPath !== pngPath && item.webpPath !== webpPath,
    );
    this.companions.push({
      pngPath,
      webpPath,
      sha256,
      updatedAt: Date.now(),
    });

    if (this.companions.length > MAX_LEDGER_ENTRIES) {
      this.companions.sort((a, b) => b.updatedAt - a.updatedAt);
      this.companions.length = MAX_LEDGER_ENTRIES;
    }

    await this.saveLedger();
  }

  async saveLedger() {
    await this.savePluginData();
  }

  async savePluginData() {
    await this.saveData({
      version: 2,
      settings: this.settings,
      companions: this.companions,
    });
  }

  async waitUntilStable(absolutePath, vaultPath, token) {
    let previousSignature;
    let stableChecks = 0;

    for (let attempt = 0; attempt < STABILITY_ATTEMPTS; attempt += 1) {
      if (!this.isCurrent(vaultPath, token)) return false;

      try {
        const stat = await fs.stat(absolutePath);
        const signature = `${stat.size}:${stat.mtimeMs}`;

        if (stat.size > 0 && signature === previousSignature) {
          stableChecks += 1;
          if (stableChecks >= 2) return true;
        } else {
          previousSignature = signature;
          stableChecks = 0;
        }
      } catch {
        stableChecks = 0;
      }

      await sleep(STABILITY_POLL_MS);
    }

    throw new Error("PNG 文件在等待时间内没有完成写入");
  }

  reportError(context, error) {
    const detail = error instanceof Error ? error.message : String(error);
    console.error(`${LOG_PREFIX} ${context}`, error);
    new Notice(`${context}\n${detail}`);
  }
}

PngWebpCompanionPlugin.__test = {
  detectImageMagick,
  imageMagickCandidates,
  shouldIgnore,
  slugifyPngPath,
};

module.exports = PngWebpCompanionPlugin;
