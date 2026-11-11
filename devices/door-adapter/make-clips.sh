#!/usr/bin/env bash
# Make the spoken answers the station plays: clips/<lang>/{coming,wait,leave}.wav.
# The words are the phone page's (webapp/static/panel/panel.js), so the visitor hears what the phone said.
# Uses piper if a voice model is given (PIPER_MODEL_<LANG>=…onnx), else espeak-ng. Or record your own
# 16-bit WAVs with the same names: they are used as they are.
set -euo pipefail
cd "$(dirname "$0")"
declare -A T=(
  [en,coming]="Someone is coming."      [en,wait]="One moment, please."           [en,leave]="Please leave it at the door."
  [de,coming]="Es kommt jemand."        [de,wait]="Einen Moment, bitte."          [de,leave]="Bitte vor der Tür abstellen."
  [fr,coming]="Quelqu'un arrive."       [fr,wait]="Un instant, s'il vous plaît."  [fr,leave]="Merci de le déposer devant la porte."
)
for lang in en de fr; do
  mkdir -p "clips/$lang"
  for a in coming wait leave; do
    out="clips/$lang/$a.wav"; text="${T[$lang,$a]}"
    [ -s "$out" ] && { echo "keep  $out"; continue; }
    model_var="PIPER_MODEL_${lang^^}"
    if command -v piper >/dev/null && [ -n "${!model_var:-}" ]; then
      echo "$text" | piper --model "${!model_var}" --output_file "$out" >/dev/null
    elif command -v espeak-ng >/dev/null; then
      espeak-ng -v "$lang" -s 150 -w "$out" "$text"
    else
      echo "neither piper nor espeak-ng: install one, or record $out yourself" >&2; exit 1
    fi
    echo "made  $out"
  done
done
