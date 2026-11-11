# NABA — concept film storyboard

A 46-second 3D concept film about a fictional floating desalination city, rendered entirely in code (Three.js in headless Chromium, encoded with ffmpeg). It is the free storyboard cut: it fixes the story, shots, camera moves and captions before any paid AI video generation.

- `output/naba_storyboard.mp4` — the film, 1920×1080, 30 fps, with an ambient music bed.
- `output/frames/shot1.png` … `shot6.png` — one clean frame per shot, no text, to use as start images for image-to-video.

## Re-render

```
npm install
node render.mjs video output/naba_silent.mp4 1920 30
CLEAN=1 node render.mjs stills output/frames 3,11,18.5,26,36,44 1920
```

Playwright with Chromium must be available globally. Software rendering takes about 20 minutes at 1080p.

## Shot list and Seedance prompts

To make the cinematic version, generate each shot with Seedance 2.5 using the matching frame as the start image and the prompt below. Keep the captions and title out of the generation and add them afterwards in the editor.

Shared style line, appended to every prompt:

> Photoreal cinematic concept film, clean white futuristic architecture with glowing cyan accents, soft volumetric light, shallow haze, smooth stabilised camera, no text, no people in close-up.

| # | Time | Length | Start frame | Prompt | Caption |
|---|---|---|---|---|---|
| 1 | 0–7 s | 7 s | `shot1.png` | Dawn over a calm open sea. Low camera glides just above the water toward a distant white floating city with a tall central tower, the sun rising directly behind it, long golden reflection on the waves. | What if the sea could end water scarcity? |
| 2 | 7–15 s | 8 s | `shot2.png` | Bright midday aerial orbit descending around a circular floating city: three concentric white ring platforms, glass garden domes, hexagonal floating solar panels, a slender white tower at the centre, a pipeline running to a desert coast on the horizon. | NABA — a floating desalination city, 40 km offshore. |
| 3 | 15–22 s | 7 s | `shot3.png` | Low tracking shot beside a huge transparent intake pipe arching from the sea over the city toward the tower. Glowing blue water streams through the pipe, sunlight sparkling on it, white buildings passing in the foreground. | Six intake arms draw seawater into the core, around the clock. |
| 4 | 22–30 s | 8 s | `shot4.png` | Slow dolly forward down the centre aisle of a vast spotless white hall lined with rows of tall glass columns full of glowing blue water and rising bubbles, polished reflective floor, long ceiling light strips, a glowing ring emblem on the far wall. | Inside, 12,000 membrane columns turn it into fresh water — powered entirely by the sun. |
| 5 | 30–39 s | 9 s | `shot5.png` | Fast flight along a white pipeline on pylons across blue sea toward a desert coast, then the camera rises over the shore as glowing water channels spread across the sand and circular green farms and lakes bloom one after another. | One pipeline carries 2 million m³ ashore every day. / Enough for 8 million people. And the desert begins to bloom. |
| 6 | 39–46 s | 7 s | `shot6.png` | Sunset wide shot slowly pulling back from the floating city, warm orange sky, the sun low behind the tower, city lights glowing amber, calm reflective sea, empty sky above for a title. | NABA — The Floating Spring |

Credit estimate at the rates checked on Higgsfield (Seedance 2.5: 3 credits/s at 480p, 7 at 720p, 16 at 1080p): 46 seconds is about 140 credits as a 480p draft, 320 at 720p and 740 at 1080p, before retakes. CapCut prices its own credits differently, so check the cost shown there before generating.

All numbers in the captions are invented for the concept.
