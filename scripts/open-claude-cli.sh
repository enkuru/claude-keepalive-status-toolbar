#!/bin/sh

cwd="$1"
shift

if [ -n "$cwd" ] && [ -d "$cwd" ]; then
  cd "$cwd" || exit 1
fi

if [ "$#" -gt 0 ]; then
  exec "$@"
fi

exec /bin/sh
