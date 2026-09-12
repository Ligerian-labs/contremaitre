#!/bin/sh
# Keep execution inside a function so a truncated curl response cannot start an install.
main() (
  set -eu
  die() { printf 'contremaitre install: %s\n' "$*" >&2; exit 1; }
  download() {
    curl --fail --silent --show-error --location --proto '=https' --proto-redir '=https' \
      --connect-timeout 15 --max-time 300 --retry 2 "$@"
  }

  [ "$#" -eq 0 ] || die 'Set CONTREMAITRE_VERSION or CONTREMAITRE_INSTALL_DIR to customize installation.'
  [ "$(uname -s)" = Darwin ] && [ "$(uname -m)" = arm64 ] || die 'Requires macOS on Apple silicon.'
  major=$(sw_vers -productVersion); major=${major%%.*}
  case "$major" in ''|*[!0-9]*) die 'Cannot determine macOS version.' ;; esac
  [ "$major" -ge 26 ] || die 'Requires macOS 26 or newer.'
  [ "$(id -u)" -ne 0 ] || die 'Run as your normal user, without sudo.'
  : "${HOME:?HOME must be set}"
  install_dir=${CONTREMAITRE_INSTALL_DIR:-"$HOME/.local/bin"}
  case "$install_dir" in /*) ;; *) die 'CONTREMAITRE_INSTALL_DIR must be an absolute path.' ;; esac
  command -v curl >/dev/null || die 'curl is required.'
  command -v shasum >/dev/null || die 'shasum is required.'

  repository=https://github.com/Ligerian-labs/contremaitre
  version=${CONTREMAITRE_VERSION:-}
  if [ -z "$version" ]; then
    latest=$(download -o /dev/null -w '%{url_effective}' "$repository/releases/latest") || die 'Cannot find the latest release.'
    case "$latest" in "$repository/releases/tag/"*) version=${latest##*/} ;; *) die 'No published release found.' ;; esac
  fi
  printf '%s\n' "$version" | grep -Eq '^v[0-9]+\.[0-9]+\.[0-9]+$' || die 'Expected a stable release tag such as v0.2.0.'

  temporary=$(mktemp -d "${TMPDIR:-/tmp}/contremaitre-install.XXXXXXXX")
  trap 'rm -rf "$temporary"' 0
  trap 'exit 130' INT
  trap 'exit 143' TERM HUP
  artifact=contremaitre-darwin-arm64
  base=$repository/releases/download/$version
  printf 'Installing Contremaitre %s...\n' "$version"
  download -o "$temporary/checksum" "$base/$artifact.sha256" || die 'Cannot download the release checksum.'
  expected=$(cat "$temporary/checksum")
  expected=${expected%  contremaitre-darwin-arm64}
  [ "${#expected}" -eq 64 ] || die 'Invalid release checksum.'
  case "$expected" in *[!0-9a-f]*) die 'Invalid release checksum.' ;; esac
  download -o "$temporary/$artifact" "$base/$artifact" || die 'Cannot download the release binary.'
  actual=$(shasum -a 256 "$temporary/$artifact"); actual=${actual%% *}
  [ "$actual" = "$expected" ] || die 'Download checksum mismatch; the installed CLI was not changed.'
  chmod 700 "$temporary/$artifact"
  "$temporary/$artifact" self-install "$install_dir"

  case ":$PATH:" in
    *":$install_dir:"*) ;;
    *) printf '\nAdd this directory to PATH in your shell profile: %s\n' "$install_dir" ;;
  esac
  missing=''
  for dependency in container traefik mkcert; do
    command -v "$dependency" >/dev/null || missing="$missing $dependency"
  done
  if [ -n "$missing" ]; then
    printf '\nInstall runtime prerequisites with Homebrew:\n  brew install%s\n' "$missing"
  fi
  printf '\nFor first-time HTTPS setup, run:\n  mkcert -install\n  contremaitre https-service install\n  contremaitre start\n'
)

main "$@"
