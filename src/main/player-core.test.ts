import assert from 'node:assert/strict'
import test from 'node:test'
import {
  choosePlayback,
  ffmpegArgs,
  h264Encoder,
  isVideoFile,
  parseByteRange,
  parseFfmpegProgress,
  parseProbe,
  srtToVtt,
  subtitleCandidates,
  vttAboveControls,
  thumbnailSeek,
  type EncoderSupport,
  type MediaProbe
} from './player-core.ts'

const encoders: EncoderSupport = { h264: true, aac: true, vp9: true, opus: true }

const probe = (over: Partial<MediaProbe> = {}): MediaProbe => ({
  format: 'mov,mp4,m4a,3gp,3g2,mj2',
  duration: 60,
  size: 1000,
  video: {
    index: 0,
    type: 'video',
    codec: 'h264',
    width: 1920,
    height: 1080,
    channels: 0,
    language: '',
    title: ''
  },
  audio: {
    index: 1,
    type: 'audio',
    codec: 'aac',
    width: 0,
    height: 0,
    channels: 2,
    language: '',
    title: ''
  },
  subtitles: [],
  chapters: [],
  ...over
})

test('video extensions are recognized cross-platform', () => {
  assert.equal(isVideoFile('/tmp/Clip.MKV'), true)
  assert.equal(isVideoFile('C:\\media\\movie.avi'), true)
  assert.equal(isVideoFile('/tmp/photo.png'), false)
  assert.equal(isVideoFile('/tmp/README'), false)
})

test('byte ranges cover start-end, open-ended and suffix forms', () => {
  assert.deepEqual(parseByteRange('bytes=0-99', 1000), { start: 0, end: 99 })
  assert.deepEqual(parseByteRange('bytes=500-', 1000), { start: 500, end: 999 })
  assert.deepEqual(parseByteRange('bytes=-100', 1000), { start: 900, end: 999 })
  assert.deepEqual(parseByteRange('bytes=0-9999', 1000), { start: 0, end: 999 })
  assert.equal(parseByteRange(null, 1000), null)
  assert.equal(parseByteRange('bytes=1000-', 1000), null)
  assert.equal(parseByteRange('bytes=50-10', 1000), null)
  assert.equal(parseByteRange('bytes=0-10', 0), null)
})

test('ffprobe JSON becomes the small media shape', () => {
  const parsed = parseProbe({
    streams: [
      { index: 0, codec_type: 'video', codec_name: 'h264', width: 1280, height: 720 },
      { index: 1, codec_type: 'audio', codec_name: 'aac', channels: 2, tags: { language: 'fa' } },
      { index: 2, codec_type: 'subtitle', codec_name: 'subrip', tags: { title: 'Persian' } },
      { index: 3, codec_type: 'data', codec_name: 'bin_data' }
    ],
    format: { format_name: 'matroska,webm', duration: '12.5', size: '3456' },
    chapters: [{ start_time: '0', end_time: '5.5', tags: { title: 'Intro' } }]
  })
  assert.equal(parsed?.video?.codec, 'h264')
  assert.equal(parsed?.video?.width, 1280)
  assert.equal(parsed?.audio?.language, 'fa')
  assert.equal(parsed?.subtitles[0].title, 'Persian')
  assert.equal(parsed?.duration, 12.5)
  assert.deepEqual(parsed?.chapters, [{ start: 0, end: 5.5, title: 'Intro' }])
  assert.equal(parseProbe({}), null)
  assert.equal(parseProbe(null), null)
})

test('native MP4/WebM streams play directly, with seeking left to HTTP ranges', () => {
  assert.deepEqual(choosePlayback(probe(), { ext: 'mp4', encoders }), {
    mode: 'direct',
    reason: 'native'
  })
  const webm = probe({
    video: { ...probe().video!, codec: 'vp9' },
    audio: { ...probe().audio!, codec: 'opus' }
  })
  assert.equal(choosePlayback(webm, { ext: 'webm', encoders }).mode, 'direct')
})

test('an MKV with supported codecs is remuxed without touching the video bitstream', () => {
  assert.deepEqual(choosePlayback(probe(), { ext: 'mkv', encoders }), {
    mode: 'remux',
    container: 'mp4',
    video: 'copy',
    audio: 'copy',
    maxWidth: 0,
    reason: 'container'
  })
  const vp9 = probe({
    video: { ...probe().video!, codec: 'vp9' },
    audio: { ...probe().audio!, codec: 'opus' }
  })
  const plan = choosePlayback(vp9, { ext: 'mkv', encoders })
  assert.equal(plan.mode, 'remux')
  assert.equal(plan.mode, 'remux')
  if (plan.mode === 'remux') assert.equal(plan.container, 'webm')
})

test('a codec in the wrong container is remuxed, not played or re-encoded', () => {
  const vp9InMp4 = probe({
    video: { ...probe().video!, codec: 'vp9' },
    audio: { ...probe().audio!, codec: 'aac' }
  })
  const plan = choosePlayback(vp9InMp4, { ext: 'mp4', encoders })
  assert.equal(plan.mode, 'remux')
  if (plan.mode === 'remux') {
    assert.equal(plan.container, 'webm')
    assert.equal(plan.video, 'copy')
    assert.equal(plan.audio, 'opus')
  }
})

test('AC-3 or FLAC audio in an H.264 MP4 is remuxed with an AAC audio track', () => {
  for (const codec of ['ac3', 'flac', 'vorbis']) {
    const plan = choosePlayback(
      probe({ audio: { ...probe().audio!, codec } }),
      { ext: 'mp4', encoders }
    )
    assert.equal(plan.mode, 'remux')
    if (plan.mode === 'remux') assert.equal(plan.audio, 'aac')
  }
})

test('old codecs are transcoded, preferring H.264/AAC when FFmpeg can encode it', () => {
  const avi = probe({
    video: { ...probe().video!, codec: 'mpeg4', width: 3840, height: 2160 },
    audio: { ...probe().audio!, codec: 'mp3' }
  })
  const plan = choosePlayback(avi, { ext: 'avi', encoders })
  assert.equal(plan.mode, 'transcode')
  if (plan.mode === 'transcode') {
    assert.equal(plan.container, 'mp4')
    assert.equal(plan.video, 'h264')
    assert.equal(plan.audio, 'aac')
    assert.equal(plan.maxWidth, 1920)
  }
})

test('without libx264 the player falls back to VP9/Opus, and reports when nothing can encode', () => {
  const hevc = probe({ video: { ...probe().video!, codec: 'hevc' } })
  const no264 = { ...encoders, h264: false }
  const plan = choosePlayback(hevc, { ext: 'mkv', encoders: no264 })
  assert.equal(plan.mode, 'transcode')
  if (plan.mode === 'transcode') assert.equal(plan.container, 'webm')

  const none = { h264: false, aac: false, vp9: false, opus: false }
  assert.deepEqual(choosePlayback(hevc, { ext: 'mkv', encoders: none }), {
    mode: 'unsupported',
    reason: 'no-encoder'
  })
  assert.deepEqual(
    choosePlayback(probe({ video: null }), { ext: 'mp4', encoders }),
    { mode: 'unsupported', reason: 'no-video' }
  )
})

test('ffmpeg arguments differ correctly between remux and transcode', () => {
  const remux = choosePlayback(probe(), { ext: 'mkv', encoders })
  assert.notEqual(remux.mode, 'direct')
  if (remux.mode !== 'remux' && remux.mode !== 'transcode') throw new Error('expected convert plan')
  const copyArgs = ffmpegArgs(remux, 'in.mkv', 'out.mp4')
  assert.deepEqual(copyArgs.slice(0, 8), [
    '-hide_banner',
    '-nostdin',
    '-y',
    '-progress',
    'pipe:1',
    '-nostats',
    '-i',
    'in.mkv'
  ])
  assert.ok(copyArgs.includes('copy'))
  assert.ok(copyArgs.includes('+faststart'))

  const avi = probe({ video: { ...probe().video!, codec: 'mpeg4', width: 3840, height: 2160 } })
  const transcode = choosePlayback(avi, { ext: 'avi', encoders })
  if (transcode.mode !== 'transcode') throw new Error('expected transcode')
  const args = ffmpegArgs(transcode, 'in.avi', 'out.mp4')
  assert.ok(args.includes('libx264'))
  assert.ok(args.some((a) => a.includes("scale='min(1920,iw)':-2")))
})

test('a hardware encoder replaces libx264, with its device and download-free upload chain', () => {
  const hevc = probe({ video: { ...probe().video!, codec: 'hevc', width: 3840, height: 2160 } })

  // software only, as the tests above assume
  assert.deepEqual(h264Encoder(undefined, 0).video.slice(0, 2), ['-c:v', 'libx264'])
  assert.deepEqual(h264Encoder(undefined, 0).filters, [])

  // VAAPI: the render node is an input option, and the scale happens before one upload
  const vaapi = choosePlayback(hevc, {
    ext: 'mkv',
    encoders: { ...encoders, h264: false, hw: { name: 'vaapi', device: '/dev/dri/renderD128' } }
  })
  assert.equal(vaapi.mode, 'transcode')
  if (vaapi.mode !== 'transcode') throw new Error('expected transcode')
  const hwArgs = ffmpegArgs(vaapi, 'in.mkv', 'out.mp4', { name: 'vaapi', device: '/dev/dri/renderD128' })
  assert.deepEqual(hwArgs.slice(6, 9), ['-vaapi_device', '/dev/dri/renderD128', '-i'])
  assert.equal(hwArgs.includes('libx264'), false)
  assert.ok(hwArgs.includes('h264_vaapi'))
  assert.equal(hwArgs[hwArgs.indexOf('-vf') + 1], "scale='min(1920,iw)':-2,format=nv12,hwupload")

  // a VAAPI encoder with no render node is not usable: fall back instead of emitting a broken run
  assert.ok(ffmpegArgs(vaapi, 'in.mkv', 'out.mp4', { name: 'vaapi' }).includes('libx264'))
})

test('progress lines report microseconds and clamp to 100%', () => {
  assert.equal(parseFfmpegProgress('out_time_us=5000000\nprogress=continue\n', 10), 50)
  assert.equal(parseFfmpegProgress('out_time_ms=2000000\n', 10), 20)
  assert.equal(parseFfmpegProgress('out_time_us=99000000\n', 10), 100)
  assert.equal(parseFfmpegProgress('progress=continue\n', 10), null)
  assert.equal(parseFfmpegProgress('out_time_us=5000000\n', 0), null)
})

test('thumbnail seek time is inside the file even for very short clips', () => {
  assert.equal(thumbnailSeek(0), 1)
  assert.equal(thumbnailSeek(2), 0.5)
  assert.equal(thumbnailSeek(100), 10)
  assert.equal(thumbnailSeek(999), 30)
})

test('sibling SRT/VTT files become subtitle candidates, other files are ignored', () => {
  const got = subtitleCandidates('/videos/movie.mkv', [
    'movie.srt',
    'movie.fa.srt',
    'movie.en.vtt',
    'other.srt',
    'movie.txt'
  ])
  assert.deepEqual(
    got.map((x) => ({ label: x.label, lang: x.lang })),
    [
      { label: 'CC', lang: '' },
      { label: 'EN', lang: 'en' },
      { label: 'FA', lang: 'fa' }
    ]
  )
  assert.equal(got[1].file.endsWith('movie.en.vtt'), true)
})

test('external cues are lifted above the controls unless the file says otherwise', () => {
  const vtt = vttAboveControls('WEBVTT\n\n00:00.000 --> 00:01.000\nhello\n\n00:02.000 --> 00:03.000 line:10%\nthere\n')
  assert.match(vtt, /00:00\.000 --> 00:01\.000 line:-3/)
  assert.match(vtt, /00:02\.000 --> 00:03\.000 line:10%/)
})

test('SRT conversion adds WEBVTT, fixes commas and keeps cue text', () => {
  const vtt = srtToVtt('1\r\n00:00:01,000 --> 00:00:03,500\r\nسلام <b>دنیا</b>\r\n\r\n2\r\n00:00:04,000 --> 00:00:05,000\r\nline two\r\n')
  assert.match(vtt, /^WEBVTT\n\n/)
  assert.match(vtt, /00:00:01\.000 --> 00:00:03\.500/)
  assert.match(vtt, /سلام <b>دنیا<\/b>/)
  assert.equal(vtt.includes('\r'), false)
  assert.equal(srtToVtt('WEBVTT\n\n00:00.000 --> 00:01.000\nx\n'), 'WEBVTT\n\n00:00.000 --> 00:01.000\nx\n')
})
