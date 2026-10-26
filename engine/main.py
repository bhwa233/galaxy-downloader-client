"""Local NDJSON engine. Credentials travel through pipes, never files or logs."""
import json
import os
import sys
import errno
from shutil import copyfile
from http.cookiejar import Cookie
from urllib.parse import urlsplit
from hashlib import sha256

# Pipes use the Windows ANSI codepage by default. This protocol is UTF-8 even
# in a frozen executable, where interpreter environment flags may be ignored.
for stream in (sys.stdin, sys.stdout, sys.stderr):
    stream.reconfigure(encoding='utf-8', errors='strict' if stream is sys.stdin else 'backslashreplace')


def emit(kind, **data):
    print(json.dumps({'kind': kind, **data}, ensure_ascii=False), flush=True)

class Logger:
    def debug(self, message):
        if not message.startswith('[debug]'):
            emit('log', message=message)

    def info(self, message):
        emit('log', message=message)

    def warning(self, message):
        emit('log', message=message)

    def error(self, message):
        emit('log', message=message)


def main():
    try:
        request = json.load(sys.stdin)
        if not isinstance(request, dict) or not isinstance(request.get('operation'), str):
            raise ValueError('Expected an engine request object with an operation')
    except (UnicodeError, ValueError) as error:
        emit('error', code='protocol', message=f'Invalid local engine request: {error}')
        sys.exit(1)
    # A wheel is authorized and verified by main. Prefer it over the frozen
    # yt_dlp, and fix its version for the lifetime of this engine process.
    if request.get('kernelWheel'):
        import importlib.abc
        import importlib.machinery

        class KernelFinder(importlib.abc.MetaPathFinder):
            def find_spec(self, fullname, path=None, target=None):
                if fullname == 'yt_dlp' or fullname.startswith('yt_dlp.'):
                    return importlib.machinery.PathFinder.find_spec(fullname, path or [request['kernelWheel']])
                return None

        sys.meta_path.insert(0, KernelFinder())

    from yt_dlp.version import __version__
    from yt_dlp.utils import DownloadError
    from subtitles import SubtitleDownloader, SubtitleProcessor

    operation = request['operation']
    if operation in ('version', 'kernel-check'):
        if operation == 'kernel-check':
            # Construct our bridge, including the postprocessors we use, before activation.
            from yt_dlp.postprocessor.ffmpeg import FFmpegMetadataPP
            with SubtitleDownloader({'quiet': True, 'cachedir': False}, language=['en']) as probe:
                FFmpegMetadataPP(probe, add_metadata=True, add_chapters=True, add_infojson=False)
        emit('result', result={'version': __version__})
        return
    if operation in ('unpack', 'inspect', 'audio', 'embedded-captions', 'render'):
        from media_processing import run
        run(request, emit)
        return
    # Mode is enforced in the engine as well as at enqueue time. Legacy requests without a
    # mode keep their saved processing configuration when an older task is resumed.
    embed_cover = bool(request.get('embedThumbnail')) and request.get('workMode') == 'edit'
    if request.get('workMode') == 'download' or request.get('deferProcessing'):
        request.update(subtitles='file' if request.get('includeSubtitles') else 'off', audioFormat='best', embedThumbnail=False,
                       thumbnailFormat='original', outputFormat='original', outputResolution='original')
        request['embedThumbnail'] = embed_cover
    editing = request.get('workMode') == 'edit' and (not request.get('deferProcessing') or request.get('embedMetadata') or request.get('embedChapters') or embed_cover)
    profile = request.get('profile')
    logger = Logger()
    options = {
        'logger': logger, 'quiet': True, 'no_warnings': False,
        'socket_timeout': request.get('timeout', 30), 'retries': request.get('retries', 3), 'fragment_retries': request.get('retries', 3),
        # Keep file failures distinguishable from network retries in the client.
        'file_access_retries': 0,
        'ratelimit': request.get('speedLimit') or None,
        'noplaylist': False, 'playlistend': 100, 'cachedir': False,
        'ffmpeg_location': request.get('ffmpeg'),
        'js_runtimes': {'node': {'path': request['node']}} if request.get('node') else {},
    }
    # Without this YouTube hands back its English machine translation of the title, not the original.
    youtube_language = {'zh': 'zh-CN', 'zh-tw': 'zh-TW', 'ja': 'ja', 'en': 'en'}.get(request.get('locale', ''))
    if youtube_language:
        options['extractor_args'] = {'youtube': {'lang': [youtube_language]}}
    if operation == 'extract' and request.get('flat', True):
        # Listing a playlist otherwise costs one full extraction per entry - 68s for a 73 video
        # channel against 1.7s here. Formats are resolved when that entry is actually downloaded.
        # The caller asks again without this when an extractor returns entries with no metadata.
        options['extract_flat'] = 'in_playlist'
    if request.get('headers'):
        options['http_headers'] = request['headers']
    if profile:
        options['cookiesfrombrowser'] = (profile['browser'], profile['path'], None, None)
    def postprocessor_progress(event):
        stage = {'ExtractAudio': 'convert', 'EmbedThumbnail': 'embed', 'ThumbnailsConvertor': 'convert'}.get(event.get('postprocessor'))
        if stage and request.get('workMode') != 'download':
            emit('processing', status=stage, progress=1 if event.get('status') == 'finished' else 0)

    if operation == 'captions':
        # YoutubeDL normalizes outtmpl during construction; never replace it afterwards.
        options.update(galaxy_strict_captions=True, skip_download=True, writesubtitles=True,
                       writeautomaticsub=bool(request.get('subtitleAutoGenerated', True)),
                       subtitleslangs=request.get('captionLanguages') or ['en'],
                       subtitlesformat='srt/vtt/best', outtmpl=request['output'])
    if operation in ('download', 'process'):
        options.update({
            'outtmpl': request['output'], 'continuedl': True, 'overwrites': False,
            # One long-lived connection for a whole file is what gets cut: a 334 MiB download was
            # measured dying at 90% when a CDN edge tired of it, and the read timeout that follows
            # costs the whole attempt. Asking for it in ranges means a cut loses one range, not the
            # transfer, and the next one opens a fresh connection.
            'http_chunk_size': 10 * 1024 * 1024,
            'windowsfilenames': True, 'restrictfilenames': False,
            'format': request.get('format', 'bv*+ba/b'), 'merge_output_format': 'mp4/mkv',
            'postprocessor_hooks': [postprocessor_progress],
            'progress_hooks': [lambda d: emit('progress', status=d['status'],
                downloaded=d.get('downloaded_bytes', 0), total=d.get('total_bytes') or d.get('total_bytes_estimate'),
                speed=d.get('speed'), eta=d.get('eta'))],
        })
        subtitles = request.get('subtitles', 'off')
        if request.get('audioOnly'):
            audio_format_id = request.get('audioFormatId')
            options['format'] = f'{audio_format_id}/bestaudio/best' if audio_format_id and audio_format_id != 'best' else 'bestaudio/best'
            audio_language = request.get('audioLanguage')
            if audio_language:
                import re
                if not re.fullmatch(r'[A-Za-z0-9-]{1,35}', audio_language):
                    raise ValueError('Invalid audio language')
                # Per-video IDs (251-20, etc.) can name different languages in a
                # playlist. Constrain both the chosen ID and its quality fallback
                # to the requested language; never silently switch dubbed audio.
                selected = f'{audio_format_id}[language={audio_language}]/' if audio_format_id and audio_format_id != 'best' else ''
                options['format'] = selected + f'bestaudio[language={audio_language}]/best[language={audio_language}]'
            options['postprocessors'] = [{'key': 'FFmpegExtractAudio', 'preferredcodec': request.get('audioFormat', 'mp3'), 'preferredquality': '192'}]
            # An audio file has nowhere to put a subtitle track and no picture to read it against.
            subtitles = 'off'
        if subtitles != 'off':
            languages = [lang.strip() for lang in request.get('subtitleLanguages', '').split(',') if lang.strip()]
            options.update({
                'writesubtitles': True,
                'writeautomaticsub': bool(request.get('subtitleAutoGenerated')),
                # live_chat is a chat replay, not a subtitle, and it is megabytes of JSON.
                'subtitleslangs': (languages or ['en']) + ['-live_chat'],
                'subtitlesformat': 'srt/vtt/best',
            })
            # yt-dlp keeps the manual track when a language has both a manual and an automatic one,
            # so enabling automatic subtitles cannot produce two tracks of the same language.
        # Covers. One flag writes the picture, one post-processor puts it inside the media file, and
        # they are independent: embedding without keeping asks yt-dlp to delete the picture afterwards,
        # which 'already_have_thumbnail' is how it is told not to.
        save_thumbnail = bool(request.get('saveThumbnail'))
        embed_thumbnail = bool(request.get('embedThumbnail'))
        if save_thumbnail or embed_thumbnail:
            options['writethumbnail'] = True
            options.setdefault('postprocessors', [])
            # Conversion has to happen before the picture is embedded, or the original travels inside
            # the media file while the converted one sits beside it.
            if request.get('thumbnailFormat') == 'jpg':
                options['postprocessors'].append({'key': 'FFmpegThumbnailsConvertor', 'format': 'jpg', 'when': 'before_dl'})
            if embed_thumbnail:
                # Appended last so it runs after FFmpegExtractAudio: an audio file that does not exist
                # yet has nowhere to put a cover.
                options['postprocessors'].append({'key': 'EmbedThumbnail', 'already_have_thumbnail': save_thumbnail})
        if request.get('entry'):
            options['playlist_items'] = str(request['entry'])
        elif request.get('playliststart') or request.get('playlistend'):
            options['playliststart'] = request.get('playliststart', 1)
            options['playlistend'] = request.get('playlistend', 100)
    files = []
    original_files = []
    processed_files = []
    def downloader(anonymous=False):
        configured = dict(options)
        if anonymous:
            configured.pop('cookiesfrombrowser', None)
            configured['http_headers'] = {key: value for key, value in (options.get('http_headers') or {}).items() if key.lower() != 'cookie'}
        ydl = SubtitleDownloader(configured, request.get('captionLanguages') or (request.get('subtitleLanguage') if operation in ('download', 'process') else None))
        # Credentials remain in this process; the fallback gets a fresh cookie jar
        # without changing the client's persist:media session or browser profile.
        for item in [] if anonymous else request.get('cookies', []):
            domain = item['domain']
            ydl.cookiejar.set_cookie(Cookie(0, item['name'], item['value'], None, False,
                domain, domain.startswith('.'), domain.startswith('.'), item.get('path', '/'), True,
                item.get('secure', False), int(item['expires']) if item.get('expires', -1) > 0 else None,
                False, None, None, {}, False))
        if operation in ('download', 'process'):
            from yt_dlp.postprocessor.common import PostProcessor

            keep_subtitle_files = request.get('subtitles') == 'file' and not request.get('audioOnly')

            class PreserveOriginal(PostProcessor):
                def run(self, info):
                    original = info['filepath']
                    if original not in original_files:
                        original_files.append(original)
                    emit('original', result={'file': original})
                    working = os.path.splitext(original)[0] + '.edited' + os.path.splitext(original)[1]
                    # Reuse the successful download on retry, but always start processing from
                    # a fresh copy so cancelled/failed transformations cannot become the input.
                    temporary = working + '.copying'
                    copyfile(original, temporary)
                    os.replace(temporary, working)
                    info['filepath'] = working
                    info['__files_to_move'].pop(original, None)
                    info['__files_to_move'][original] = original
                    return [], info

            class CaptureFile(PostProcessor):
                def run(self, info):
                    files.append(info['filepath'])
                    if editing:
                        processed_files.append(info['filepath'])
                        files.extend(file for file in original_files if file not in files)
                    # Sidecar subtitles are separate files the client has to know about. In embed mode
                    # they are deleted once muxed in, so their recorded paths no longer exist.
                    if keep_subtitle_files:
                        for track in (info.get('requested_subtitles') or {}).values():
                            saved = track.get('filepath')
                            if saved and saved not in files and os.path.exists(saved):
                                files.append(saved)
                    # Same for the cover picture: a file the client does not know about is one it will
                    # not clean up when the task is deleted and will not show in the file list. Embed
                    # without save deletes it, which is what the existence check is for.
                    if save_thumbnail:
                        for picture in (info.get('thumbnails') or []):
                            saved = picture.get('filepath')
                            if saved and saved not in files and os.path.exists(saved):
                                files.append(saved)
                    return [], info

            if subtitles != 'off' or editing and not request.get('audioOnly'):
                # Runs after merging the audio/video and before embedding a cover.
                ydl._pps['post_process'].insert(0, SubtitleProcessor(ydl, request, emit))
            if editing:
                ydl._pps['post_process'].insert(0, PreserveOriginal(ydl))
            if editing and (request.get('embedMetadata') or request.get('embedChapters')):
                from yt_dlp.postprocessor.ffmpeg import FFmpegMetadataPP
                ydl._pps['post_process'].append(FFmpegMetadataPP(ydl, add_metadata=bool(request.get('embedMetadata')), add_chapters=bool(request.get('embedChapters')), add_infojson=False))
            ydl.add_post_processor(CaptureFile(ydl), when='after_move')
        return ydl

    with downloader() as ydl:
        if operation == 'captions':
            info = ydl.process_ie_result(request['info'], download=True) if request.get('info') else ydl.extract_info(request['url'], download=True)
            tracks = [{'language': language, 'file': track.get('filepath')} for language, track in (info.get('requested_subtitles') or {}).items() if track.get('filepath') and os.path.isfile(track['filepath'])]
            emit('result', result={'tracks': tracks})
            return
        if operation == 'process':
            info = dict(request.get('info') or {})
            info.update(filepath=request['input'], ext=os.path.splitext(request['input'])[1][1:])
            # A direct media response has no platform subtitle catalogue. The processor still
            # converts/resizes it and reports unavailable captions through the normal warning.
            thumbnails = []
            if save_thumbnail or embed_thumbnail:
                for index, thumbnail in enumerate(info.get('thumbnails') or []):
                    thumbnail.setdefault('id', str(index))
                thumbnails = ydl._write_thumbnails('video', info, request['input']) or []
            ydl.post_process(request['input'], info, files_to_move=dict(thumbnails))
            emit('result', result={'files': files, 'originalFiles': original_files, 'processedFiles': processed_files})
            return
        try:
            # Browser fallback can supply an identified work's separate tracks. yt-dlp still owns
            # selection, authentication, retries, merging and every existing post-processor.
            if request.get('manifest'):
                # Reuse yt-dlp's HLS parser/downloader: it resolves relative variants, separate
                # audio, subtitles and fragments. No second playlist parser or downloader.
                from yt_dlp.extractor.generic import GenericIE
                video_id = sha256((request.get('pageUrl') or request['url']).encode()).hexdigest()[:16]
                extractor = GenericIE(ydl)
                formats, captions = extractor._extract_m3u8_formats_and_subtitles(
                    request['url'], video_id, ext='mp4', m3u8_id='hls',
                    headers=options.get('http_headers'))
                media_playlist = next((item['url'] for item in reversed(formats) if item.get('url') and item.get('vcodec') != 'none'), request['url'])
                duration = extractor._extract_m3u8_vod_duration(media_playlist, video_id, headers=options.get('http_headers'))
                info = ydl.process_ie_result({
                    'id': video_id, 'title': request.get('mediaTitle') or os.path.basename(urlsplit(request['url']).path) or 'HLS video',
                    'webpage_url': request['url'], 'formats': formats, 'subtitles': captions, 'duration': duration,
                    'extractor': 'generic', 'extractor_key': 'Generic',
                }, download=operation == 'download')
            else:
                info = (ydl.process_ie_result(request['info'], download=operation == 'download')
                        if request.get('info') else ydl.extract_info(request['url'], download=operation == 'download'))
        except DownloadError as error:
            host = urlsplit(request['url']).hostname or ''
            youtube = host == 'youtu.be' or host == 'youtube.com' or host.endswith('.youtube.com')
            auth_names = {'SID', 'SAPISID', 'APISID', 'HSID', 'SSID', '__Secure-1PSID', '__Secure-3PSID', '__Secure-1PAPISID', '__Secure-3PAPISID'}
            authenticated = any(cookie.name in auth_names and cookie.domain.lstrip('.') in {'youtube.com', 'google.com'} for cookie in ydl.cookiejar)
            authorization = any(key.lower() == 'authorization' for key in request.get('headers', {}))
            denied_media = 'unable to download video data' in str(error) and 'HTTP Error 403' in str(error)
            if operation != 'download' or not youtube or not denied_media or authenticated or authorization or not (request.get('cookies') or profile):
                raise
            emit('log', message='YouTube 媒体请求返回 403，使用匿名会话重新解析并重试。' if request.get('locale') == 'zh' else 'YouTube media returned 403; re-extracting and retrying with an anonymous session.')
            with downloader(anonymous=True) as fallback:
                info = fallback.extract_info(request['url'], download=True)
        emit('result', result=ydl.sanitize_info(info) if operation == 'extract' else {'files': files, 'originalFiles': original_files, 'processedFiles': processed_files})


if __name__ == '__main__':
    try:
        main()
    except Exception as error:
        # Do not emit tracebacks / request data: either can contain credentials.
        details, seen, cause = {}, set(), error
        while isinstance(cause, BaseException) and id(cause) not in seen:
            seen.add(id(cause))
            # Network/SSL exceptions can also inherit OSError; only file errors
            # carry a filename. yt-dlp preserves wrapped causes in exc_info.
            if isinstance(cause, OSError) and cause.filename is not None and cause.errno in errno.errorcode:
                details['code'] = errno.errorcode[cause.errno]
                break
            info = getattr(cause, 'exc_info', None)
            cause = (info[1] if isinstance(info, tuple) and len(info) > 1 else None) or cause.__cause__ or cause.__context__
        emit('error', message=str(error), **details)
        sys.exit(1)
