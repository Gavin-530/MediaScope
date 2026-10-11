# Downloaded runtime provenance

The small MediaScope ZIP contains no runtime binaries. First installation requires internet.

- Node.js 24.16.0: https://nodejs.org/dist/v24.16.0/ ; checksums: SHASUMS256.txt in that directory. MIT and bundled third-party notices are retained in the downloaded archive.
- FFmpeg 8.1.3 GPL static build (`n8.1.3-20260926`): the original BtbN release `autobuild-2026-09-26-13-03` was removed. The same installed build is now available as a verified repack at https://github.com/Gavin-530/MediaScope/releases/tag/runtime-ffmpeg-8.1.3-20260926 . All 44 original files, including binaries, licenses, documentation and presets, are preserved byte-for-byte; no recompilation was performed. The ZIP packaging and archive SHA-256 changed. The companion `ffmpeg-n8.1.3-win64-gpl-8.1-repacked.manifest.json` records original provenance and every file digest. Original archive SHA-256 (not recovered): `d20ef03f0f4161453b9f46a72471eb5370f56b6410fe8bca14a4b0220c6c924a`; repacked archive SHA-256: `235ecd4adbbf52933378c8da4d6b0438eabe60dfb5a867f70784ec8b1162597c`. Build recipes, dependencies and source retrieval: https://github.com/BtbN/FFmpeg-Builds/tree/58cc05f . FFmpeg source: https://github.com/FFmpeg/FFmpeg/tree/n8.1.3 . This build includes GPL components (including x264/x265); it is not an LGPL-only build.

Runtime archives are extracted intact into the private runtime directory, preserving their licenses and documentation. Exact archive URLs and SHA-256 digests are pinned in runtime-lock.json. Do not replace them with moving latest URLs. Revalidate capabilities and the application's regression suite before changing a lock.

Checksums detect corruption relative to a trusted release package; an unsigned manifest does not authenticate a malicious replacement of the entire package. Obtain the package from the project's trusted release channel and compare its published ZIP digest.
