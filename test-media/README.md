# Test media

`obs-layout-test.mkv` — 20 s synthetic stand-in for an OBS recording made with the
Review App profile: 1280x720 30fps H.264, **Track 1 = game** (stereo 330 Hz tone),
**Track 2 = mic** (mono, flite TTS reading `mic-script.txt` — real speech, so
Deepgram returns a transcript). Generated with system ffmpeg on the build box —
a test fixture only; the app itself never uses FFmpeg.

Still needed from Cade (before U1 can be signed off on Windows): one real
1–5 min recording from the bundled OBS profile, plus one long (1 h+, multi-GB)
recording to prove drag-drop of a big file yields a path without loading it.

Regenerate:

    ffmpeg -f lavfi -i "testsrc=size=1280x720:rate=30:duration=20" \
      -f lavfi -i "sine=frequency=330:duration=20,aformat=channel_layouts=stereo" \
      -f lavfi -i "flite=textfile=mic-script.txt:voice=slt,apad=whole_dur=20,aresample=48000" \
      -map 0:v -map 1:a -map 2:a -c:v libx264 -crf 20 -preset veryfast -pix_fmt yuv420p \
      -c:a aac -b:a 128k -ac:a:1 1 -t 20 obs-layout-test.mkv
