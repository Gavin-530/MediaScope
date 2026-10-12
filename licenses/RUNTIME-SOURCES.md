# Downloaded runtime provenance

The small MediaScope ZIP contains no runtime binaries. First installation requires internet.

- Node.js 24.16.0: https://nodejs.org/dist/v24.16.0/ ; checksums: SHASUMS256.txt in that directory. MIT and bundled third-party notices are retained in the downloaded archive.
- FFmpeg 8.1 release-branch GPL static build (`n8.1.3-9-g29e619e767`, 2026-09-30): https://github.com/BtbN/FFmpeg-Builds/releases/tag/autobuild-2026-09-30-13-08 . The original upstream ZIP is pinned without repackaging; its SHA-256 is `7b801cdd3a1a0bb54ae6f572187e68b4ed54f52086cfee133fab2180bfb429fa`, verified against both upstream `checksums.sha256` and the GitHub asset digest. Build recipes, dependencies and source retrieval: https://github.com/BtbN/FFmpeg-Builds/tree/autobuild-2026-09-30-13-08 . FFmpeg source: https://github.com/FFmpeg/FFmpeg/tree/29e619e767 . BtbN retains the last build of each month for two years; this fixed monthly build is not a permanent upstream availability guarantee. This build includes GPL components (including x264/x265); it is not an LGPL-only build.

Runtime archives are extracted intact into the private runtime directory, preserving their licenses and documentation. Exact archive URLs and SHA-256 digests are pinned in runtime-lock.json. Do not replace them with moving latest URLs. Revalidate capabilities and the application's regression suite before changing a lock.

Checksums detect corruption relative to a trusted release package; an unsigned manifest does not authenticate a malicious replacement of the entire package. Obtain the package from the project's trusted release channel and compare its published ZIP digest.
