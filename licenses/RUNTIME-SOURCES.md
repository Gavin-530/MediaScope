# Downloaded runtime provenance

The small MediaScope ZIP contains no runtime binaries. First installation requires internet.

- Node.js 24.16.0: https://nodejs.org/dist/v24.16.0/ ; checksums: SHASUMS256.txt in that directory. MIT and bundled third-party notices are retained in the downloaded archive.
- FFmpeg 8.1.3 GPL static build: https://github.com/BtbN/FFmpeg-Builds/releases/tag/autobuild-2026-09-26-13-03 ; checksum source: checksums.sha256 in that release. Build recipes, dependencies and source retrieval: https://github.com/BtbN/FFmpeg-Builds . FFmpeg source: https://ffmpeg.org/download.html . This build includes GPL components (including x264/x265); it is not an LGPL-only build.

Runtime archives are extracted intact into the private runtime directory, preserving their licenses and documentation. Exact archive URLs and SHA-256 digests are pinned in runtime-lock.json. Do not replace them with moving latest URLs. Revalidate capabilities and the application's regression suite before changing a lock.

Checksums detect corruption relative to a trusted release package; an unsigned manifest does not authenticate a malicious replacement of the entire package. Obtain the package from the project's trusted release channel and compare its published ZIP digest.
