"""Local subtitle selection, timeline composition and atomic video postprocessing."""
import html
import math
import os
import re
import subprocess
import sys
import tempfile
import time
import unicodedata
from pathlib import Path

from yt_dlp import YoutubeDL
from yt_dlp.postprocessor.ffmpeg import FFmpegPostProcessor, FFmpegSubtitlesConvertorPP
from yt_dlp.utils import PostProcessingError


class SubtitleDownloader(YoutubeDL):
    def __init__(self, options, language=None):
        self.language = language
        super().__init__(options)

    def process_subtitles(self, video_id, normal_subtitles, automatic_captions):
        if not self.language:
            return super().process_subtitles(video_id, normal_subtitles, automatic_captions)
        manual = normal_subtitles or {}
        automatic = (automatic_captions or {}) if self.params.get('writeautomaticsub') else {}
        available = {**automatic, **manual}
        chosen = []
        for prefix in (['zh', 'en'] if self.language == 'bilingual' else [self.language]):
            preferences = ['zh-Hans', 'zh-CN', 'zh', 'zh-Hant', 'zh-TW'] if prefix == 'zh' else ['en', 'en-orig', 'en-US', 'en-GB']
            candidates = [key for key in available if key == prefix or key.startswith(prefix + '-')]
            candidates.sort(key=lambda key: (key not in manual, preferences.index(key) if key in preferences else len(preferences), key))
            if candidates:
                chosen.append(candidates[0])
        previous = self.params.get('subtitleslangs')
        self.params['subtitleslangs'] = [re.escape(key) for key in chosen] or ['(?!)']
        try:
            return super().process_subtitles(video_id, manual, automatic)
        finally:
            self.params['subtitleslangs'] = previous

    def _write_subtitles(self, info_dict, filename):
        # A caption CDN refusal must not prevent the media itself being saved. Keep
        # extraction, media downloads and postprocessing strict outside this call.
        previous = self.params.get('ignoreerrors')
        self.params['ignoreerrors'] = True
        try:
            return super()._write_subtitles(info_dict, filename)
        finally:
            self.params['ignoreerrors'] = previous


def milliseconds(value):
    hours, minutes, seconds, fraction = re.split(r'[:,.]', value)
    return ((int(hours) * 60 + int(minutes)) * 60 + int(seconds)) * 1000 + int(fraction.ljust(3, '0')[:3])


def timestamp(value, ass=False):
    hours, remainder = divmod(value, 3600000)
    minutes, remainder = divmod(remainder, 60000)
    seconds, fraction = divmod(remainder, 1000)
    return f'{hours}:{minutes:02}:{seconds:02}.{fraction // 10:02}' if ass else f'{hours:02}:{minutes:02}:{seconds:02},{fraction:03}'


def read_cues(filename, normalize):
    text = Path(filename).read_text(encoding='utf-8-sig')
    cues = []
    for block in re.split(r'\r?\n\s*\r?\n', text.strip()):
        lines = block.splitlines()
        timing = next((index for index, line in enumerate(lines) if '-->' in line), None)
        if timing is None:
            continue
        match = re.match(r'(\d+:\d+:\d+[,.]\d+)\s*-->\s*(\d+:\d+:\d+[,.]\d+)', lines[timing])
        if not match:
            continue
        body = html.unescape(re.sub(r'<[^>]*>', '', '\n'.join(lines[timing + 1:]))).strip()
        start, end = map(milliseconds, match.groups())
        if body and end > start:
            cues.append((start, end, body))
    cues.sort(key=lambda cue: cue[0])
    if normalize:
        cues = [(start, min(end, cues[index + 1][0]) if index + 1 < len(cues) else end, body)
                for index, (start, end, body) in enumerate(cues)]
    return [cue for cue in cues if cue[1] > cue[0]]


def write_srt(filename, cues):
    Path(filename).write_text(''.join(f'{index}\n{timestamp(start)} --> {timestamp(end)}\n{body}\n\n'
                                    for index, (start, end, body) in enumerate(cues, 1)), encoding='utf-8')


def subtitle_intervals(tracks):
    # Sweep cue boundaries rather than pairing lines: translations often split a
    # sentence differently. Active Chinese lines always precede active English.
    events = {}
    for language, cues in enumerate(tracks):
        for index, (start, end, body) in enumerate(cues):
            events.setdefault(start, []).append((language, index, body))
            events.setdefault(end, []).append((language, index, None))
    points = sorted(events)
    active = [{} for _ in tracks]
    result = []
    for index, start in enumerate(points[:-1]):
        for language, key, body in events[start]:
            if body is None:
                active[language].pop(key, None)
            else:
                active[language][key] = body
        bodies = ['\n'.join(dict.fromkeys(track.values())) for track in active]
        if not any(bodies):
            continue
        end = points[index + 1]
        if result and result[-1][1] == start and result[-1][2] == bodies:
            result[-1] = (result[-1][0], end, bodies)
        else:
            result.append((start, end, bodies))
    return result


def compose_bilingual(chinese, english):
    return [(start, end, '\n'.join(body for body in bodies if body))
            for start, end, bodies in subtitle_intervals((chinese, english))]


def wrap_caption(body, size, width):
    # The bundled libass may lack Unicode line breaking. Supply safe CJK breaks
    # explicitly and keep Latin words together; libass can refine Latin wrapping.
    # Noto's ASS em is about 0.67 of the requested size; use a little spare width.
    limit = max(1, (width - 144) / (size * 0.75))
    tokens = re.findall(r"[A-Za-z0-9_]+(?:['’\-][A-Za-z0-9_]+)*|\s+|.", body)
    def units(text):
        return sum(1 if unicodedata.east_asian_width(char) in ('W', 'F') or char in 'MW@'
                   else 0.3 if char in " ilI'.,!:;|"
                   else 0.4 if char in 'fjrt()[]'
                   else 0.65 for char in text)
    lines, line, used = [], '', 0
    for token in tokens:
        # Split unusually long words/URLs as well, instead of clipping them.
        pieces = list(token) if units(token) > limit else [token]
        for piece in pieces:
            length = units(piece)
            if line and used + length > limit and piece not in '，。！？；：、,.!?;:)]}”’':
                lines.append(line.strip())
                line, used = '', 0
            if not line and piece.isspace():
                continue
            line += piece
            used += length
    if line.strip():
        lines.append(line.strip())
    return r'\N'.join(lines)


def paginate_caption(start, end, body, max_lines=2):
    lines = body.split(r'\N')
    pages = [r'\N'.join(lines[index:index + max_lines]) for index in range(0, len(lines), max_lines)]
    if len(pages) == 1:
        return [(start, end, body)]
    # Keep every word inside the source cue's time range, with longer pages
    # receiving proportionally more time. ASS has centisecond precision.
    if end - start < len(pages) * 10:
        raise PostProcessingError('Subtitle text is too long for its timing; cannot split it without losing text')
    weights = [max(1, len(page.replace(r'\N', '').replace(' ', ''))) for page in pages]
    total, used, cursor = sum(weights), 0, start
    result = []
    for index, (page, weight) in enumerate(zip(pages, weights)):
        used += weight
        boundary = end if index == len(pages) - 1 else min(end - (len(pages) - index - 1) * 10,
                                                         max(cursor + 10, start + round((end - start) * used / total)))
        result.append((cursor, boundary, page))
        cursor = boundary
    return result


def write_ass(filename, tracks, info):
    source_width, source_height = info.get('width') or 1920, info.get('height') or 1080
    scale = 1080 / min(source_width, source_height)
    width, height = max(320, round(source_width * scale)), max(320, round(source_height * scale))
    header = f'''[Script Info]
ScriptType: v4.00+
PlayResX: {width}
PlayResY: {height}
WrapStyle: 2
ScaledBorderAndShadow: yes

[V4+ Styles]
Format: Name, Fontname, Fontsize, PrimaryColour, SecondaryColour, OutlineColour, BackColour, Bold, Italic, Underline, StrikeOut, ScaleX, ScaleY, Spacing, Angle, BorderStyle, Outline, Shadow, Alignment, MarginL, MarginR, MarginV, Encoding
Style: Default,Noto Sans CJK SC,64,&H00FFFFFF,&H00FFFFFF,&H00251B12,&H60251B12,-1,0,0,0,100,100,0,0,1,3,1.5,2,72,72,80,1

[Events]
Format: Layer, Start, End, Style, Name, MarginL, MarginR, MarginV, Effect, Text
'''
    lines = []
    languages = list(tracks)
    prepared = []
    for language, cues in tracks.items():
        pages = []
        for start, end, body in cues:
            body = ' '.join(body.split())
            body = body.replace('\\', '＼').replace('{', '｛').replace('}', '｝')
            size = 64 if language == 'zh' else 60
            pages.extend(paginate_caption(start, end, wrap_caption(body, size, width)))
        prepared.append(pages)
    # Split each source language before sweeping boundaries, so another
    # language's cue changes cannot restart a long sentence's pagination.
    for start, end, bodies in subtitle_intervals(prepared):
        # Overlapping source cues can exceed the cap even after each cue was
        # split. Cap their combined display as well without discarding text.
        pages = [paginate_caption(start, end, body.replace('\n', r'\N')) for body in bodies]
        for page_start, page_end, page_bodies in subtitle_intervals(pages):
            rows = []
            for language, body in zip(languages, page_bodies):
                size = 64 if language == 'zh' else 60
                # Reserve the missing row during temporary bilingual gaps.
                rows.append(f'{{\\fs{size}}}' + (body or r'\h'))
            body = r'\N'.join(rows)
            lines.append(f'Dialogue: 0,{timestamp(page_start, True)},{timestamp(page_end, True)},Default,,0,0,0,,{body}\n')
    Path(filename).write_text(header + ''.join(lines), encoding='utf-8')


class SubtitleProcessor(FFmpegPostProcessor):
    def __init__(self, downloader, request, emit):
        super().__init__(downloader)
        self.request = request
        self.emit = emit

    def warning(self, chinese, english):
        self.emit('warning', message=chinese if self.request.get('locale') == 'zh' else english)

    def ffmpeg(self, info, inputs, options, output, stage, workdir=None):
        command = [self.executable, '-y', '-hide_banner', '-nostdin', '-loglevel', 'error']
        for filename in inputs:
            command += ['-i', os.path.abspath(filename)]
        command += options + ['-progress', 'pipe:1', '-nostats', os.path.abspath(output)]
        duration = info.get('duration') or 0
        self.emit('processing', status=stage, progress=0, eta=None)
        started = time.monotonic()
        rate = None
        # FFmpeg's stderr can exceed a pipe buffer. Spool it without blocking the
        # progress reader; only a bounded tail is ever returned as an error.
        with tempfile.TemporaryFile() as errors:
            with subprocess.Popen(command, stdout=subprocess.PIPE, stderr=errors, text=True,
                                  encoding='utf-8', errors='replace', cwd=workdir or os.path.dirname(os.path.abspath(output)),
                                  creationflags=subprocess.CREATE_NO_WINDOW if os.name == 'nt' else 0) as process:
                for line in process.stdout:
                    if duration and line.startswith('out_time_us='):
                        try:
                            position = max(0, int(line.split('=', 1)[1]) / 1000000)
                            now = time.monotonic()
                            elapsed = now - started
                            # Wait for real work before estimating, then smooth
                            # changing encode speeds instead of assuming a fixed
                            # video-to-wall-time ratio from another machine.
                            if elapsed >= 3 and position > 0:
                                # Include startup and stalls in measured time:
                                # FFmpeg reports frames in batches, so the time
                                # between two updates is not an encode speed.
                                sample = position / elapsed
                                rate = sample if rate is None else rate * 0.8 + sample * 0.2
                            eta = math.ceil(max(0, duration - position) / rate) if rate else None
                            self.emit('processing', status=stage, progress=min(0.99, position / duration), eta=eta)
                        except ValueError:
                            pass
                code = process.wait()
            if code:
                errors.seek(0, os.SEEK_END)
                errors.seek(max(0, errors.tell() - 3000))
                raise PostProcessingError('FFmpeg media processing failed: ' + errors.read().decode('utf-8', 'replace'))
        self.emit('processing', status=stage, progress=1, eta=0)

    def run(self, info):
        mode = self.request.get('subtitles', 'off')
        delete = []
        if mode != 'off':
            self.emit('processing', status='subtitles', progress=0)
            delete, info = FFmpegSubtitlesConvertorPP(self._downloader, format='srt').run(info)
        tracks = info.get('requested_subtitles') or {}
        valid = {}
        cues = {}
        for language, track in tracks.items():
            filename = track.get('filepath')
            if filename and track.get('ext') == 'srt' and os.path.isfile(filename):
                parsed = read_cues(filename, bool(self.request.get('subtitleNormalizeOverlaps')))
                if parsed:
                    write_srt(filename, parsed)
                    valid[language] = track
                    cues[language] = parsed
        info['requested_subtitles'] = valid
        language_mode = self.request.get('subtitleLanguage')
        zh = next((key for key in valid if key == 'zh' or key.startswith('zh-')), None)
        en = next((key for key in valid if key == 'en' or key.startswith('en-')), None)
        missing = language_mode == 'bilingual' and not (zh and en) or language_mode == 'zh' and not zh or language_mode == 'en' and not en
        if mode != 'off' and not valid:
            self.warning('没有可用字幕，已保留无字幕视频。', 'No usable subtitles; the video has been saved without subtitles.')
        elif mode != 'off' and missing:
            self.warning('缺少部分所选语言字幕，已使用现有语言字幕。', 'Some selected subtitle languages are unavailable; available captions were used.')
        combined = None
        if language_mode == 'bilingual' and zh and en:
            combined = os.path.splitext(info['filepath'])[0] + '.zh-en.srt'
            cues['zh-en'] = compose_bilingual(cues[zh], cues[en])
            write_srt(combined, cues['zh-en'])
            valid['zh-en'] = {'ext': 'srt', 'filepath': combined, 'name': '中文 + English'}
            info['__files_to_move'][combined] = combined
        editing = self.request.get('workMode') == 'edit'
        if mode == 'file' and not editing:
            return delete, info

        original = info['filepath']
        target = self.request.get('outputFormat', 'original') if editing else 'mp4'
        extension = info.get('ext') or os.path.splitext(original)[1][1:]
        target = extension if target == 'original' else target
        output = os.path.splitext(original)[0] + '.' + target
        temporary = os.path.splitext(original)[0] + '.processing.' + target
        burn_track = 'zh-en' if combined else zh or en or next(iter(valid), None)
        ass = None
        options = ['-map', '0:v:0', '-map', '0:a?', '-map_metadata', '-1', '-map_chapters', '-1']
        inputs = [original]
        codec = (info.get('vcodec') or '').lower()
        resolution = self.request.get('outputResolution', 'original') if editing else 'original'
        filters = []
        resize = resolution != 'original'
        if resize:
            limit = int(resolution)
            width, height = info.get('width'), info.get('height')
            # The shorter edge defines p for both landscape and portrait video. FFmpeg's
            # expression clamps the scale to one even when an extractor omitted dimensions.
            resize = not (width and height) or min(width, height) > limit
            if resize:
                factor = f'min(1,{limit}/min(iw,ih))'
                filters.append(f"scale=w='max(2,trunc(iw*{factor}/2)*2)':h='max(2,trunc(ih*{factor}/2)*2)'")
        copy_video = not resize and (mode != 'burn' or not burn_track)
        if target in ('mp4', 'mov', 'm4v'):
            copy_video = copy_video and (not codec or codec.startswith(('avc', 'h264', 'hev', 'hvc', 'hevc', 'av01', 'av1', 'vp9', 'vp09')))
        encode_video = ['-c:v', 'libvpx-vp9', '-crf', '30', '-b:v', '0', '-pix_fmt', 'yuv420p'] if target == 'webm' else ['-c:v', 'libx264', '-crf', '20', '-preset', 'medium', '-pix_fmt', 'yuv420p']
        options += ['-c:v', 'copy'] if copy_video else encode_video
        audio = (info.get('acodec') or '').lower()
        if target == 'webm':
            options += ['-c:a', 'copy'] if not audio or audio.startswith(('opus', 'vorbis')) else ['-c:a', 'libopus', '-b:a', '192k']
        else:
            options += ['-c:a', 'copy'] if not audio or target not in ('mp4', 'mov', 'm4v') or audio.startswith(('aac', 'mp4a')) else ['-c:a', 'aac', '-b:a', '192k']
        container_options = ['-movflags', '+faststart'] if target in ('mp4', 'mov', 'm4v') else []
        if mode == 'burn' and burn_track:
            ass = os.path.splitext(original)[0] + '.burn.ass'
            burn_tracks = {}
            if zh:
                burn_tracks['zh'] = cues[zh]
            if en:
                burn_tracks['en'] = cues[en]
            write_ass(ass, burn_tracks or {'other': cues[burn_track]}, info)
            fonts = Path(sys.executable).parent / 'fonts' if getattr(sys, 'frozen', False) else Path(__file__).parent / 'fonts'
            # Use a fixed, relative filter path: Windows drive colons and names
            # containing apostrophes must not enter FFmpeg's filter language.
            with tempfile.TemporaryDirectory(prefix='galaxy-subtitles-') as work:
                from shutil import copyfile
                copyfile(ass, Path(work) / 'captions.ass')
                if not (fonts / 'NotoSansCJKsc-Bold.otf').is_file():
                    raise PostProcessingError('Subtitle font is missing; reinstall the client')
                os.mkdir(Path(work) / 'fonts')
                copyfile(fonts / 'NotoSansCJKsc-Bold.otf', Path(work) / 'fonts' / 'caption.otf')
                # Burn on the source canvas, then scale the complete frame and its captions.
                options += ['-vf', ','.join(['ass=filename=captions.ass:fontsdir=fonts', *filters])]
                self.ffmpeg(info, inputs, options + container_options, temporary, 'burn', workdir=work)
        else:
            if mode == 'embed':
                for index, (language, track) in enumerate(valid.items()):
                    inputs.append(track['filepath'])
                    label = '中文 + English' if language == 'zh-en' else '中文' if language.startswith('zh') else 'English' if language.startswith('en') else language
                    code = 'zho' if language.startswith('zh') else 'eng' if language.startswith('en') else 'und'
                    options += ['-map', f'{index + 1}:0', f'-metadata:s:s:{index}', f'language={code}', f'-metadata:s:s:{index}', f'handler_name={label}']
                    options += [f'-disposition:s:{index}', 'default' if (language == 'zh-en' if combined else index == 0) else '0']
                options += ['-c:s', 'mov_text' if target in ('mp4', 'mov', 'm4v') else 'webvtt' if target == 'webm' else 'srt']
            if filters:
                options += ['-vf', ','.join(filters)]
            stage = 'embed' if valid and mode == 'embed' else 'convert'
            try:
                self.ffmpeg(info, inputs, options + container_options, temporary, stage)
            except PostProcessingError:
                if not copy_video:
                    raise
                # Generic extractors sometimes omit the codec. Try lossless muxing
                # first, then encode if MP4 cannot carry that source codec.
                position = options.index('-c:v')
                options[position:position + 2] = encode_video
                self.ffmpeg(info, inputs, options + container_options, temporary, stage)
        # The original media and subtitle files survive errors or cancellation.
        # Publish only after FFmpeg has closed a complete output successfully.
        os.replace(temporary, output)
        info['filepath'], info['ext'] = output, target
        info['__files_to_move'].pop(original, None)
        if original != output:
            delete.append(original)
        if mode != 'file':
            delete += [track['filepath'] for track in valid.values()]
        if ass:
            delete.append(ass)
        return delete, info
