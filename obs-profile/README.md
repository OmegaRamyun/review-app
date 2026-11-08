# Review App — OBS profile + scene collection

The recording half of the Review App workflow. The app itself doesn't record — OBS does, with this setup, and the app imports the MKV.

## Install

1. In OBS: **Profile → Import** → select the `Review App` folder (the one containing `basic.ini`).
2. In OBS: **Scene Collection → Import** → select `Review App.json`.
3. Switch to both: Profile menu → Review App, Scene Collection menu → Review App.

## What it sets

- **Video:** 1280×720, 30 fps. Low res on purpose — small files, and text/UI stays readable in screenshots.
- **Encoder:** AMD AMF H.264 (your RX580's hardware encoder), CQP 20, Quality preset, High profile, keyframe every 2 s, B-frames 0. GPU does the encoding, CPU stays free for the game. Files run a little bigger than x264 CRF 20 for the same look — fine, the recording is a working file for transcription and scrubbing, not the final product.
- **Format:** MKV. Crash-safe, and it's the container the app reads. If OBS offers to remux to MP4, decline — the app wants the MKV.
- **Audio:** 48 kHz stereo.
- **Tracks:** two, and only two.
  - **Track 1 — game/desktop audio** (stereo). What the game sounds like.
  - **Track 2 — mic** (the commentary track). Routed here and nowhere else.
- **Sources:** one scene, "Game", with a Game Capture source set to capture any fullscreen application, cursor included. Desktop Audio and Mic are global devices (always on, in every scene).

## Mic processing (for cleaner transcripts)

The mic source carries a four-filter voice chain, in this order:

1. **Noise Suppression (RNNoise)** — ML-based, kills fan, keyboard and room noise. The single biggest win for transcription accuracy.
2. **Noise Gate** — opens at −32 dB, closes at −38 dB, 25 ms attack. Cuts the room tone between sentences. Kept gentle on purpose: a harsh gate eats the start of words, and a lost word onset is worse for Deepgram than a little noise.
3. **Compressor** — 3:1, −18 dB threshold, 6 ms attack, 100 ms release. Evens out loud and quiet speech so quiet words stay audible.
4. **Limiter** — −3 dB ceiling. Safety net against clipping; clipped audio distorts and Deepgram hates distortion.

Set your mic level so normal speech peaks around −12 dB on the Mic/Aux meter — the chain expects a healthy signal, not a whisper. If words sound clipped, loosen the gate first (lower the thresholds) or disable it; the suppression and compressor do most of the work. If the mic clips before the limiter catches it, turn the mic volume down instead of leaning on the limiter.

## Check after import

- **Encoder check:** open Settings → Output → Recording and confirm the encoder reads **AMD HW H.264**, Rate Control **CQP**, CQ **20**, Preset **Quality**, Profile **High**, keyframe **2 s**. If the AMD encoder doesn't appear in the list, update your Adrenalin drivers — AMF ships in the driver. If any of those values look different from what's here, set them by hand in that tab (10 seconds) and tell me — it means one of the profile's AMF keys didn't take, and I'll fix the file.
- **Mono mic (optional but recommended):** in Edit → Advanced Audio Properties, tick **Mono** for Mic/Aux. That makes track 2 truly mono at record time. If it's unticked, nothing breaks — the app downmixes to mono when it extracts the track, so the clip Deepgram gets is mono either way. It just halves the audio bits.
- **Game capture:** launch a game fullscreen and confirm the preview shows it. Game Capture grabs any fullscreen app automatically.
- **A test recording:** hit Start Recording, play 30 seconds, stop. The file lands in your Videos folder as `YYYY-MM-DD HH-MM-SS.mkv`. Open it in the Review App and confirm track 2 is your voice.

## If you don't have an AMD GPU

The profile defaults to AMF because that's what this machine has (RX580). On a machine without AMD hardware, change the recording encoder in Settings → Output → Recording to NVENC (NVIDIA), QuickSync (Intel), or x264 (CPU fallback) — same CQP/CRF 20, same tracks. Nothing else changes.

## What the app does with the file

Import the MKV → the app extracts track 2 (mic) with Mediabunny, downmixes to mono, sends the clip to Deepgram → transcript comes back with word timestamps → scrubber workflow: click a line, video jumps there, pin points, screenshot, assemble, publish to Cloudflare Pages.

## Files

- `Review App/basic.ini` — the profile (video, output, encoder, tracks).
- `Review App.json` — the scene collection (one scene, game capture, global desktop audio + mic).
- This README.

Written from OBS's documented formats (profile `basic.ini`, scene-collection JSON). Not yet import-tested in a live OBS — the first import on your machine is the verification. If OBS complains about anything on import, tell me the exact message and I'll fix the file.
