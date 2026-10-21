"""Prepare the pinned Linux x64 FFmpeg build used by the local engine."""
import hashlib
import os
from pathlib import Path
import shutil
import tarfile
import time
import urllib.request


# ffmpeg-static's Linux 7.0.2 binary crashes on MPEG-TS input (reproduced with
# complete HLS downloads). Its installer only handles that package's gzip assets.
# Reuse the engine's Python standard library for this checked BtbN release archive;
# the month-end release is retained upstream for two years, unlike daily builds.
RELEASE = 'autobuild-2026-09-30-13-08'
NAME = 'ffmpeg-n8.1.3-9-g29e619e767-linux64-gpl-8.1'
CHECKSUM = '97ce978979194b5cf7e06a5e68020dbdaa7a4f3294c5452b6a1bc347100dbb79'
ROOT = Path(__file__).resolve().parent.parent
CACHE = ROOT / 'engine-build' / 'ffmpeg' / f'{NAME}.tar.xz'
DESTINATION = ROOT / 'resources' / 'engine'


def checksum(path):
    with path.open('rb') as source:
        return hashlib.file_digest(source, 'sha256').hexdigest()


def main():
    CACHE.parent.mkdir(parents=True, exist_ok=True)
    if not CACHE.exists() or checksum(CACHE) != CHECKSUM:
        url = f'https://github.com/BtbN/FFmpeg-Builds/releases/download/{RELEASE}/{NAME}.tar.xz'
        partial = CACHE.with_suffix('.download')
        for attempt in range(3):
            try:
                print(f'Downloading pinned FFmpeg: {NAME}', flush=True)
                request = urllib.request.Request(url, headers={'User-Agent': 'Galaxy-Downloader-build'})
                with urllib.request.urlopen(request, timeout=60) as response, partial.open('wb') as output:
                    shutil.copyfileobj(response, output)
                if checksum(partial) != CHECKSUM:
                    raise ValueError('FFmpeg archive checksum mismatch')
                os.replace(partial, CACHE)
                break
            except Exception:
                partial.unlink(missing_ok=True)
                if attempt == 2:
                    raise
                time.sleep(attempt + 1)
    DESTINATION.mkdir(parents=True, exist_ok=True)
    # Extract only the named files; archive paths never select a destination path.
    with tarfile.open(CACHE, 'r:xz') as archive:
        for member, name in [('bin/ffmpeg', 'ffmpeg'), ('LICENSE.txt', 'ffmpeg-LICENSE.txt')]:
            output = DESTINATION / name
            temporary = output.with_suffix('.preparing')
            with archive.extractfile(f'{NAME}/{member}') as source, temporary.open('wb') as target:
                shutil.copyfileobj(source, target)
            temporary.chmod(0o755 if name == 'ffmpeg' else 0o644)
            os.replace(temporary, output)
    print(f'Prepared FFmpeg from {RELEASE} (SHA-256 verified)', flush=True)


if __name__ == '__main__':
    main()
