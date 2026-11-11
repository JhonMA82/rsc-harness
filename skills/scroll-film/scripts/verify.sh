#!/usr/bin/env bash
# verify.sh — check a scroll-film clip chain before it ships. Read-only.
#
#   bash verify.sh [--strict] [--gop N] [--min-ssim X] [--portrait] [--frames DIR] clip1.mp4 clip2.mp4 ...
#
# Pass the clips in chain order (the order the engine plays them). Per clip it checks the
# encode a scrubbed video needs: H.264 yuv420p, no audio track, the index (moov) ahead of the
# media so the first frame paints early, and a keyframe at least every N frames (default 8; use
# --gop 4 for phone encodes). Across the chain it checks every clip shares one size and frame
# rate, and scores each seam: the true last frame of clip i against the first frame of clip i+1.
#
# A seam is judged against the clips around it, not against a fixed number: how alike two
# frames look depends on the picture, so a soft landscape scores high even across a cut. The
# seam's SSIM must stay within --margin (default 0.03) of the ordinary frame-to-frame SSIM at
# the end of clip i and the start of clip i+1. A frame-locked seam looks like one more frame; a
# fresh render of the same scene drops below. --frames DIR writes each pair side by side.
#
# Warns by default and exits 0. --strict exits 1 on any warning. Exits 2 on bad usage.
# bash 3.2-safe: no associative arrays, no mapfile.

set -u

STRICT=0
GOP=8
MARGIN=0.03
PORTRAIT=0
FRAMES_DIR=""
CLIPS=()

while [ $# -gt 0 ]; do
  case "$1" in
    --strict) STRICT=1 ;;
    --gop) shift; GOP="${1:-}" ;;
    --margin) shift; MARGIN="${1:-}" ;;
    --portrait) PORTRAIT=1 ;;
    --frames) shift; FRAMES_DIR="${1:-}" ;;
    -h|--help) sed -n '2,19p' "$0"; exit 0 ;;
    -*) echo "verify.sh: unknown option $1" >&2; exit 2 ;;
    *) CLIPS+=("$1") ;;
  esac
  shift
done

for tool in ffmpeg ffprobe awk; do
  command -v "$tool" >/dev/null 2>&1 || { echo "verify.sh: $tool not found on PATH" >&2; exit 2; }
done
if [ "${#CLIPS[@]}" -eq 0 ]; then
  echo "verify.sh: pass the clips in chain order (see --help)" >&2
  exit 2
fi

WARNINGS=0
ok()   { echo "ok    $*"; }
warn() { echo "WARN  $*"; WARNINGS=$((WARNINGS + 1)); }

TMP=$(mktemp -d "${TMPDIR:-/tmp}/scroll-film-verify.XXXXXX")
trap 'rm -rf "$TMP"' EXIT
[ -n "$FRAMES_DIR" ] && mkdir -p "$FRAMES_DIR"

# Every decoded frame of the last second, one file each: the final file is the real last frame.
# (A plain -sseof seek with -frames:v 1 stops a few frames short and judges the wrong frame.)
# The two last and the two first frames give the clips' own frame-to-frame step at the seam.
edge_frames() { # clip index
  mkdir -p "$TMP/tail_$2" "$TMP/head_$2"
  ffmpeg -v error -y -sseof -1 -i "$1" -fps_mode passthrough "$TMP/tail_$2/%04d.png"
  ffmpeg -v error -y -i "$1" -frames:v 2 -fps_mode passthrough "$TMP/head_$2/%04d.png"
  ls "$TMP/tail_$2" | tail -2 > "$TMP/tail_$2.list"
}
ssim() { ffmpeg -v info -i "$1" -i "$2" -lavfi "[0][1]ssim" -f null - 2>&1 | grep -oE 'All:[0-9.]+' | tail -1 | cut -d: -f2; }

FIRST_SHAPE=""
i=0
for clip in "${CLIPS[@]}"; do
  i=$((i + 1))
  name=$(basename "$clip")
  if [ ! -f "$clip" ]; then warn "$name: file not found"; continue; fi

  video=$(ffprobe -v error -select_streams v:0 -show_entries stream=codec_name,pix_fmt,width,height,r_frame_rate -of csv=p=0 "$clip")
  if [ -z "$video" ]; then warn "$name: no video stream"; continue; fi
  codec=$(echo "$video" | cut -d, -f1)
  width=$(echo "$video" | cut -d, -f2)
  height=$(echo "$video" | cut -d, -f3)
  pixfmt=$(echo "$video" | cut -d, -f4)
  rate=$(echo "$video" | cut -d, -f5)

  [ "$codec" = "h264" ] && ok "$name: h264" || warn "$name: codec $codec (h264 decodes and seeks everywhere)"
  [ "$pixfmt" = "yuv420p" ] && ok "$name: yuv420p" || warn "$name: pixel format $pixfmt (Safari wants yuv420p)"

  audio=$(ffprobe -v error -select_streams a -show_entries stream=index -of csv=p=0 "$clip")
  [ -z "$audio" ] && ok "$name: no audio track" || warn "$name: has an audio track (dead weight on a muted scrub; encode with -an)"

  first_atom=$(ffprobe -v trace "$clip" 2>&1 | grep -oE "type:'(moov|mdat)'" | head -1)
  [ "$first_atom" = "type:'moov'" ] && ok "$name: moov before mdat (faststart)" \
    || warn "$name: index after the media (encode with -movflags +faststart)"

  max_gap=$(ffprobe -v error -select_streams v:0 -show_entries packet=flags -of csv=p=0 "$clip" \
    | awk '{ n++; if (substr($0,1,1) == "K") { if (last && n - last > gap) gap = n - last; last = n } }
           END { if (n - last + 1 > gap) gap = n - last + 1; print gap + 0 }')
  if [ "$max_gap" -le "$GOP" ]; then ok "$name: keyframe every <= $max_gap frames"
  else warn "$name: $max_gap frames between keyframes (> $GOP); every scrub seek decodes that many"; fi

  if [ "$PORTRAIT" -eq 1 ]; then
    [ "$height" -gt "$width" ] && ok "$name: portrait ${width}x${height}" \
      || warn "$name: ${width}x${height} is not portrait (the phone chain is rendered at 9:16, not cropped)"
  fi

  shape="${width}x${height}@${rate}"
  if [ -z "$FIRST_SHAPE" ]; then FIRST_SHAPE="$shape"
  elif [ "$shape" != "$FIRST_SHAPE" ]; then
    warn "$name: $shape differs from the first clip's $FIRST_SHAPE (one model and one encode for the whole chain)"
  fi

  edge_frames "$clip" "$i"
done

n=${#CLIPS[@]}
s=1
while [ "$s" -lt "$n" ]; do
  next=$((s + 1))
  label="seam $s→$next ($(basename "${CLIPS[$((s - 1))]}") → $(basename "${CLIPS[$s]}"))"
  a_prev=""; a=""; b="$TMP/head_$next/0001.png"; b_next="$TMP/head_$next/0002.png"
  if [ -s "$TMP/tail_$s.list" ]; then
    a="$TMP/tail_$s/$(tail -1 "$TMP/tail_$s.list")"
    [ "$(wc -l < "$TMP/tail_$s.list")" -ge 2 ] && a_prev="$TMP/tail_$s/$(head -1 "$TMP/tail_$s.list")"
  fi
  if [ -z "$a" ] || [ ! -f "$a" ] || [ ! -f "$b" ]; then
    warn "$label: could not extract both frames"
  else
    score=$(ssim "$a" "$b")
    step_out=""; step_in=""
    [ -n "$a_prev" ] && step_out=$(ssim "$a_prev" "$a")
    [ -f "$b_next" ] && step_in=$(ssim "$b" "$b_next")
    step=$(echo "$step_out $step_in" | awk '{ m = ""; for (k = 1; k <= NF; k++) if (m == "" || $k < m) m = $k; print m }')
    if [ -z "$score" ]; then
      warn "$label: frames could not be compared (different sizes?)"
    elif [ -z "$step" ]; then
      warn "$label: SSIM $score, but the clips are too short to measure their own frame step; judge it by eye"
    elif awk -v s="$score" -v t="$step" -v m="$MARGIN" 'BEGIN { exit !(s >= t - m) }'; then
      ok "$label: SSIM $score (frame to frame inside the clips: $step)"
    else
      warn "$label: SSIM $score against $step frame to frame inside the clips; look at it. A different picture means the handoff used the wrong frame"
    fi
    if [ -n "$FRAMES_DIR" ]; then
      ffmpeg -v error -y -i "$a" -i "$b" -filter_complex hstack "$FRAMES_DIR/seam_$(printf '%02d' "$s").png" \
        && echo "      side by side: $FRAMES_DIR/seam_$(printf '%02d' "$s").png"
    fi
  fi
  s=$next
done

echo
if [ "$WARNINGS" -eq 0 ]; then
  echo "RESULT: PASS ($n clip(s), $((n - 1)) seam(s))"
  exit 0
fi
echo "RESULT: $WARNINGS warning(s)"
[ "$STRICT" -eq 1 ] && exit 1
exit 0
