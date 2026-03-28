#!/bin/sh
set -eu

OUTPUT_DIR=/work/rescue-output
WITHDRAWAL_PATH="$OUTPUT_DIR/withdrawal.json"

if [ "$#" -eq 0 ]; then
  exec node cli.js withdraw --help
fi

case "$1" in
  withdraw|build-tree|resume-status)
    exec node cli.js "$@"
    ;;
  send)
    shift
    exec node cli.js broadcast --withdrawal "$WITHDRAWAL_PATH" "$@"
    ;;
  broadcast)
    shift
    exec node cli.js broadcast --withdrawal "$WITHDRAWAL_PATH" "$@"
    ;;
  --help|-h|help)
    exec node cli.js --help
    ;;
  *)
    if [ "$#" -lt 2 ]; then
      echo "Usage: docker run ... <note> <recipient> [withdraw options]" >&2
      echo "   or: docker run ... broadcast [broadcast options]" >&2
      echo "   or: docker run ... <cli subcommand> [options]" >&2
      exit 1
    fi

    note="$1"
    recipient="$2"
    shift 2

    exec node cli.js withdraw \
      --note "$note" \
      --recipient "$recipient" \
      --out-dir "$OUTPUT_DIR" \
      --progress \
      "$@"
    ;;
esac
