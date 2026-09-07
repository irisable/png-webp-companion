# Changelog

All notable changes to PNG WebP Companion are documented here.

## 0.5.0

- Detect ImageMagick 7 through common macOS and Linux paths or the system
  `PATH`, including `magick.exe` on Windows, and verify real WebP encoding.
- Allow a custom ImageMagick executable path in plugin settings.
- Keep the plugin loaded and pause conversion when ImageMagick is unavailable.
- Respect a vault's custom Obsidian configuration-directory name.
- Add local detection tests, a real ImageMagick smoke test, a reproducible Linux
  Docker test, and a GitHub Actions cross-platform test matrix.
- Add English documentation and local-processing/privacy disclosures.

## 0.4.0

- Normalize newly created or renamed PNG filenames to conservative slugs.
- Preserve Unicode letters and skip renames when the destination exists.

## 0.3.0

- Preserve PNG originals and create validated same-name WebP companions.
- Rewrite only verified Markdown and Wiki image links while retaining metadata.
- Follow Obsidian and external filesystem renames using a SHA-256 ledger.
