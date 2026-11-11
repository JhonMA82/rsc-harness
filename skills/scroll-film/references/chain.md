# Building the chain — prompts, probe, batch loops

Everything the body of `scroll-film` points at for sections 1 to 4. Fill the slots; keep the
clauses marked **verbatim** exactly as written, because they are what the seams depend on.

## The brief to write down before anything renders

```yaml
subject: "a bubble-tea brand, from the tea field to the last sip"   # the user's words
brand: { name: "Pearl & Leaf", tone: "warm, playful" }
palette: { bg: "#F3EDE4", accent: "#6D55B8", others: ["#8FB98A", "#C88A5A", "#3A2E48"] }
look: clay-diorama            # becomes the style preamble below
camera: dive-and-hop          # walkthrough | fixed-angle | dive-and-hop  → shape A, A, B
phones: true                  # true = a second, 9:16 chain
scenes:                       # 4–7, in camera order; the last carries the CTA
  - { id: field,   subject: "terraced tea field, pickers with baskets, a small drying shed", focus: "the drying racks" }
  - { id: kitchen, subject: "a kitchen with copper pots of simmering tapioca pearls",      focus: "the pearl pots" }
  - { id: shop,    subject: "the corner shop with a striped awning and a queue",          focus: "the counter" }
model: { endpoint: "<from the probe>", seconds_leg: 8, seconds_hop: 5, price_per_second: "<read today>" }
estimate_usd: "<clips × seconds × price + 20%>"
approved: false               # nothing renders until this is true
```

## Style preamble — one block, pasted unchanged into every still prompt

Write it once from the look the user picked. The background colour is the page background.

```text
Isometric miniature diorama on a plain solid #F3EDE4 background, a soft shadow beneath it.
Matte clay materials, rounded toy-like shapes, warm low studio light, tilt-shift depth of field.
Palette limited to #6D55B8, #8FB98A, #C88A5A, #3A2E48. Subject centred. No text, letters,
numbers or logos anywhere.
```

Other looks change the first two sentences only and keep the palette and no-text lines:

- **Paper cut:** "Layered paper-craft diorama, matte card, clean die-cut edges, thin shadows between layers."
- **Vinyl toy:** "Glossy vinyl-toy diorama, smooth plastic shading, soft rim light."
- **Night miniature:** "Miniature town at night, warm lit windows, neon signs, wet reflective streets."
- **Photoreal:** "Architectural photograph of one continuous space, wide lens, late-afternoon light, natural
  materials, no people." Photoreal scenes are full-bleed (no floating island), the camera moves
  through doorways and glass instead of opening a roof, and it suits shape A. Do not pass one
  approved still as a style reference here: it clones the same room into every scene.

## Still prompt

```text
<STYLE PREAMBLE>
Subject: <scene.subject>. Framed for a 16:9 picture with the focal point, <scene.focus>, in the centre.
```

- Render every still from **one** source and model. Two image models drift in warmth and line,
  and the chain inherits the drift.
- Prepare each still at the clip's aspect before it becomes a start image: 16:9 for desktop, and a
  1080×1920 canvas in the background colour for the phone chain. Handed an off-aspect image, many
  endpoints choose their own framing and frame 0 stops matching.
- Review the set before any video: same angle, same light, same palette. Re-roll the odd one out.

## Leg prompt — shape A

Start frame: the previous leg's real last frame (leg 0: the first still). **No end frame.**

```text
One continuous camera move, no cuts. Continue the same slow, steady forward drift.
<MID-LEG MOVE, optional>. The camera travels into <scene.subject> toward <scene.focus>.
In the final second, settle into a slow, steady forward drift toward <where the next scene lies>.
<last two sentences of the style preamble>. Smooth, unhurried motion. No text.
```

The first and the last sentence of that block are **verbatim**: they are the handoff contract
that keeps velocity continuous across the seam.

### Mid-leg moves by concept

A reversal inside one leg is safe, since one render has no seam. Pick from the scene's own logic:

| Concept | Mid-leg move |
| --- | --- |
| Product, luxury | "circling the <hero object> in a slow half orbit, keeping it centred, then moving past it" |
| Real estate, hotels | "gliding through the doorway at eye height, rising gently as the room opens up" |
| Production, logistics | "tracking low and level alongside the <line>, foreground objects sliding past" |
| Travel, campus, outdoors | "climbing over the <terrain>, then swooping down toward the <next focus>" |
| Food, craft | "pushing in until the <craft moment> nearly fills the frame, then easing back" |
| The scene itself is the show | omit the slot: a plain forward drift is the safest leg |

Expressive moves raise the re-roll rate: the model can end mid-orbit instead of in a clean forward
drift. Budget one extra render for each expressive leg, and check its last frame before chaining.

### Fixed-angle clause

When the user picked "one fixed angle", put this in the mid-leg slot of **every** leg, **verbatim**:

```text
The camera holds the same high isometric angle the whole time, with no rotation, orbit or tilt.
It only travels straight and level while the world slides past beneath it.
```

Long legs drift the angle slightly. When checking each last frame, also check the view has not
turned; re-roll a leg that has.

## Dive and hop prompts — shape B

Dive. Start frame: the scene's still (the solid-background version, so the frame is full).

```text
One continuous camera move, no cuts. Start high and far, looking down at the whole <scene.subject>
like a small model. The camera glides forward and descends toward <scene.focus>; as it closes in,
the roof lifts gently away to reveal the interior. <style tail>. Smooth, unhurried motion. No text.
```

For an open scene with no roof (a field, a square), swap the last clause for "the camera skims low
across <the scene> toward <scene.focus>".

Hop. Start frame: dive k's real last frame. End frame: dive k+1's real first frame.

```text
One continuous camera move, no cuts. The camera rises up and out of <scene k>, climbs into the sky,
crosses the connected miniature world and arrives above <scene k+1>, starting to descend toward it.
<style tail>. Smooth, unhurried motion. No text.
```

For the hop into a hero-product finale, end it on "…and the world falls away toward a single giant
<product> floating in open <bg colour> space."

## Phone chain clause

Prepend to every leg, dive and hop of the 9:16 chain:

```text
Vertical composition: the scene centred with open <bg colour> space above and below it.
```

The phone chain hands off frames from its own renders only.

## The probe — one cheap clip before the batch

```bash
ssim() { ffmpeg -i "$1" -i "$2" -lavfi "[0]scale=960:540,setsar=1[a];[1]scale=960:540,setsar=1[b];[a][b]ssim" \
  -f null - 2>&1 | grep -oE 'All:[0-9.]+'; }
ffmpeg -v error -y -i probe.mp4 -frames:v 2 -fps_mode passthrough probe_%d.png
ssim probe_1.png still_01.png   # frame 0 against the still it was given
ssim probe_1.png probe_2.png    # the clip's own frame-to-frame step, the yardstick
# Hop duty: the last frame against the end frame it was given.
ffmpeg -v error -y -sseof -1 -i probe_hop.mp4 -update 1 probe_last.png
ssim probe_last.png still_02.png
```

- Frame 0 against the still should score about as high as the clip's own frame step. Judge it
  against that yardstick, never a fixed number: how alike two frames look depends on the picture.
  On a soft landscape photo, a fresh render of the same scene still scored 0.89. Clearly below the
  step means the input steered a new render instead of starting the clip: the endpoint cannot
  hold a seam.
- The hop's last frame only has to land on the same composition. Look at it; a near miss is normal.
- Compare the bill for the probe with the advertised price before multiplying it by the chain.
- Re-run the probe whenever the endpoint's input schema changes. Catalogues gain and lose
  start-frame support without notice.

## Batch loops

`make_clip` is the one function you write against the chosen endpoint (the call itself →
`../../fal/SKILL.md` or `../../replicate/SKILL.md`). Its contract: `make_clip out.mp4 prompt.txt
start.png [end.png]` renders one clip, downloads it at once (result URLs expire within hours) and
appends the billed cost to `costs.log`. Run the loops as a background job and poll; a clip takes
minutes. Keep them in a `bash` script: zsh arrays start at 1, and an inline loop in a zsh shell
pairs each hop with the wrong scene.

Shape A, one leg at a time:

```bash
#!/bin/bash
set -e
SCENES="field kitchen shop"
start="stills/field.png"
for s in $SCENES; do
  make_clip "legs/$s.mp4" "prompts/leg_$s.txt" "$start"
  ffmpeg -v error -y -sseof -1 -i "legs/$s.mp4" -update 1 -q:v 2 "frames/${s}_last.png"
  start="frames/${s}_last.png"      # look at it before the next leg spends money
done
```

Shape B, dives in parallel, then hops:

```bash
#!/bin/bash
set -e
SCENES="field kitchen shop"
for s in $SCENES; do make_clip "dives/$s.mp4" "prompts/dive_$s.txt" "stills/$s.png" & done
wait
for s in $SCENES; do
  ffmpeg -v error -y -i "dives/$s.mp4" -frames:v 1 -q:v 2 "frames/${s}_first.png"
  ffmpeg -v error -y -sseof -1 -i "dives/$s.mp4" -update 1 -q:v 2 "frames/${s}_last.png"
done
prev=""; k=0
for s in $SCENES; do
  if [ -n "$prev" ]; then
    k=$((k + 1))
    make_clip "hops/hop_$k.mp4" "prompts/hop_$k.txt" "frames/${prev}_last.png" "frames/${s}_first.png" &
  fi
  prev="$s"
done
wait
```

Five or six renders at once is usually fine. Many more invites transient rate and credit errors:
re-roll the one that failed, never the batch.

## When a content filter blocks a harmless clip

Video filters flag ordinary interiors, mostly bedrooms, pools, spas and bars, from the prompt words
and from the frames themselves. In order:

1. Re-roll. The verdict is often not deterministic.
2. Take out the trigger words and add "empty, unoccupied, architectural".
3. Render that one clip on another model that also passed the probe, with the same start and end
   frames. Its render character differs slightly, which a short hop behind the seam dissolve
   usually hides.
4. Drop that hop. List the two dives next to each other in the engine config and it dissolves
   between them directly. The film completes; that seam reads as a dissolve, not a flight.
