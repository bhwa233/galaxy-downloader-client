"""Offline media operations. Every input path is resolved and authorized by Electron main."""
import os
import re
import shutil
import subprocess
import tarfile
import tempfile
from pathlib import Path


def inspect(ffmpeg, source):
    process = subprocess.run([ffmpeg, '-hide_banner', '-i', source], capture_output=True, timeout=120)
    text = process.stderr.decode('utf-8', 'replace')
    match = re.search(r'Duration: (\d+):(\d+):(\d+(?:\.\d+)?)', text)
    duration = int(match[1]) * 3600 + int(match[2]) * 60 + float(match[3]) if match else 0
    return {'durationSeconds': duration, 'video': bool(re.search(r'Stream .*Video:', text)),
            'subtitles': [{'index': int(found[1]), 'language': found[2] or 'und'}
                          for found in re.finditer(r'Stream #0:(\d+)(?:\[[^\]]*\])?(?:\(([^)]+)\))?: Subtitle:', text)]}


def run(request, emit):
    operation = request['operation']
    if operation == 'unpack':
        destination = Path(request['output']).resolve()
        wanted = set(request['archiveFiles'])
        with tarfile.open(request['input']) as archive:
            for member in archive:
                name = member.name.removeprefix('./')
                if name not in wanted:
                    continue
                target = (destination / name).resolve()
                if not member.isfile() or not target.is_relative_to(destination):
                    raise ValueError('Unsafe model archive member')
                target.parent.mkdir(parents=True, exist_ok=True)
                with archive.extractfile(member) as source, target.open('wb') as output:
                    shutil.copyfileobj(source, output)
                wanted.remove(name)
        if wanted:
            raise ValueError('Model archive missing required files: ' + ', '.join(sorted(wanted)))
        emit('result', result={'ok': True})
        return
    ffmpeg, source = request['ffmpeg'], request['input']
    metadata = inspect(ffmpeg, source)
    if operation == 'inspect':
        emit('result', result=metadata)
        return
    if operation == 'audio':
        subprocess.run([ffmpeg, '-hide_banner', '-nostdin', '-y', '-i', source, '-vn', '-ac', '1', '-ar', '16000', '-c:a', 'pcm_s16le', request['output']], check=True, stdout=subprocess.DEVNULL, stderr=subprocess.PIPE)
        emit('result', result={'durationSeconds': inspect(ffmpeg, request['output'])['durationSeconds']})
        return
    if operation == 'embedded-captions':
        destination = Path(request['output'])
        destination.mkdir(parents=True, exist_ok=True)
        tracks = []
        for track in metadata['subtitles'][:20]:
            output = destination / f"embedded-{track['index']}.srt"
            process = subprocess.run([ffmpeg, '-hide_banner', '-nostdin', '-y', '-i', source, '-map', f"0:{track['index']}", '-c:s', 'srt', str(output)], capture_output=True)
            if process.returncode == 0 and output.stat().st_size:
                tracks.append({**track, 'file': str(output)})
        emit('result', result={'tracks': tracks})
        return
    if operation != 'render':
        raise ValueError('Unknown local media operation')
    output = Path(request['output'])
    if output.resolve() == Path(source).resolve() or output.exists():
        raise ValueError('Output must be a new file')
    mode = request.get('renderMode', 'video')
    if not metadata['video']:
        raise ValueError('The source has no video stream')
    with tempfile.TemporaryDirectory(prefix='galaxy-render-') as directory:
        temporary = str(output.with_name(output.stem + '.processing' + output.suffix))
        args = [ffmpeg, '-hide_banner', '-nostdin', '-y', '-i', source]
        if mode == 'soft':
            tracks = request.get('captionFiles') or [{'file': request['captionFile'], 'language': 'und'}]
            for track in tracks[:5]:
                args += ['-i', track['file']]
            args += ['-map', '0:v:0', '-map', '0:a?']
            for index, track in enumerate(tracks[:5]):
                args += ['-map', f'{index + 1}:0', f'-metadata:s:s:{index}', f"language={track['language']}"]
            args += ['-c', 'copy', '-c:s', 'mov_text' if output.suffix.lower() == '.mp4' else 'srt']
        else:
            args += ['-map', '0:v:0', '-map', '0:a?']
            filters = []
            if mode == 'burn':
                shutil.copyfile(request['captionFile'], Path(directory) / 'captions.srt')
                fonts = Path(getattr(__import__('sys'), '_MEIPASS', Path(__file__).parent)) / 'fonts'
                if not fonts.exists():
                    fonts = Path(ffmpeg).parent / 'fonts'
                if fonts.exists():
                    shutil.copytree(fonts, Path(directory) / 'fonts')
                filters.append("subtitles=filename=captions.srt:fontsdir=fonts:force_style='FontName=Noto Sans CJK SC,FontSize=24,Bold=1,Outline=2,Shadow=1'")
            resolution = request.get('outputResolution', 'original')
            if resolution != 'original':
                limit = int(resolution)
                factor = f'min(1,{limit}/min(iw,ih))'
                filters.append(f"scale=w='max(2,trunc(iw*{factor}/2)*2)':h='max(2,trunc(ih*{factor}/2)*2)'")
            if filters:
                args += ['-vf', ','.join(filters)]
            args += ['-c:v', 'libx264', '-crf', '20', '-preset', 'medium', '-pix_fmt', 'yuv420p', '-c:a', 'aac', '-b:a', '192k']
        if output.suffix.lower() == '.mp4':
            args += ['-movflags', '+faststart']
        args += ['-progress', 'pipe:1', '-nostats', temporary]
        try:
            with tempfile.TemporaryFile() as errors:
                process = subprocess.Popen(args, cwd=directory, stdout=subprocess.PIPE, stderr=errors, text=True, encoding='utf-8')
                for line in process.stdout:
                    if line.startswith('out_time_us=') and metadata['durationSeconds']:
                        try:
                            progress = min(.99, int(line.split('=')[1]) / 1_000_000 / metadata['durationSeconds'])
                            emit('processing', status='exporting', progress=progress)
                        except ValueError:
                            pass
                if process.wait() != 0:
                    errors.seek(0)
                    raise RuntimeError(errors.read().decode('utf-8', 'replace')[-4000:])
            os.replace(temporary, output)
        finally:
            Path(temporary).unlink(missing_ok=True)
    emit('result', result={'file': str(output)})
