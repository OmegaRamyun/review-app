#!/usr/bin/env bash
# setup-toolchain.sh — (re)build the Review App toolchain for builder.
# Idempotent. Re-run after any VM replacement: /home/builder is wiped, only
# /home/hatch persists. No root needed (builder has no sudo).
#
#   1. rustup (stable, minimal) -> .toolchain/{cargo,rustup} (under /home/hatch,
#      survives VM swaps; ~/.cargo in /home/builder would not)
#   2. node: /usr/bin/node is in the image; npm lives at /opt/hatch-image/bin
#   3. Linux webkit2gtk dev libs for `cargo tauri build` on this Linux box.
#      Without root we can't apt install, so we fetch the .debs with a
#      user-space apt state and dpkg -x them into .toolchain/sysroot
#      (under /home/hatch, so it survives VM swaps), then rewrite the .pc
#      prefixes. The real target is Windows (WebView2); this Linux build is the
#      compile/smoke gate for the loop.
#   4. npm install in the repo.
#
# Use the result:  source ops/env.sh
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
SYS="$ROOT/.toolchain/sysroot"
APT="/tmp/review-app-apt"
export RUSTUP_HOME="$ROOT/.toolchain/rustup" CARGO_HOME="$ROOT/.toolchain/cargo"
export PATH="$CARGO_HOME/bin:/opt/hatch-image/bin:$PATH"

# 1. rust
if ! command -v cargo >/dev/null; then
  curl --proto '=https' --tlsv1.2 -sSf https://sh.rustup.rs | sh -s -- -y --profile minimal --default-toolchain stable --no-modify-path
fi
cargo --version

# 2. node
node --version; npm --version

# 3. webkit sysroot
if [ ! -f "$SYS/.done" ]; then
  mkdir -p "$APT"/{state/lists/partial,cache/archives/partial,etc,debs} "$SYS"
  cat > "$APT/etc/sources.list" <<'SRC'
deb [trusted=yes] http://archive.ubuntu.com/ubuntu noble main universe
deb [trusted=yes] http://archive.ubuntu.com/ubuntu noble-updates main universe
deb [trusted=yes] http://security.ubuntu.com/ubuntu noble-security main universe
SRC
  # The image carries +hatchN rebuilds of some libs; strip the suffix so apt's
  # resolver treats them as the archive version instead of demanding upgrades.
  sed -E 's/\+hatch[0-9]+//g' /var/lib/dpkg/status > "$APT/status.fake"
  A=(-o Dir::State="$APT/state" -o Dir::Cache="$APT/cache" -o Debug::NoLocking=1
     -o Dir::Etc::sourcelist="$APT/etc/sources.list" -o Dir::Etc::sourceparts=/nonexistent
     -o Dir::State::status="$APT/status.fake" -o Acquire::Languages=none)
  apt-get "${A[@]}" update
  apt-get "${A[@]}" -s install --no-install-recommends libwebkit2gtk-4.1-dev \
    | awk '/^Inst/{print $2}' > "$APT/pkgs.txt"
  (cd "$APT/debs" && apt-get "${A[@]}" download $(cat "$APT/pkgs.txt"))
  for d in "$APT"/debs/*.deb; do dpkg -x "$d" "$SYS"; done
  find "$SYS" -name '*.pc' -exec sed -i -E "s#(^|[ =]|-I|-L)/usr/#\1$SYS/usr/#g" {} +
  find "$SYS" -name '*.pc' -exec sed -i -E "s#=/usr\$#=$SYS/usr#" {} +
  touch "$SYS/.done"
fi
# Dev .so symlinks whose runtime lib is already in the image (gtk3, atk,
# gdk-pixbuf) were not downloaded, so they dangle inside the sysroot and the
# link fails "unable to find library -lgtk-3". Re-point them at /usr/lib.
# Runs every time (cheap) so a repaired sysroot stays repaired.
L="$SYS/usr/lib/x86_64-linux-gnu"
for so in "$L"/*.so; do
  if [ -L "$so" ] && [ ! -e "$so" ]; then
    t="$(readlink "$so")"; [ -e "/usr/lib/x86_64-linux-gnu/$t" ] && ln -sf "/usr/lib/x86_64-linux-gnu/$t" "$so"
  fi
done

# 4. js deps
(cd "$ROOT" && npm install --no-fund --no-audit)
echo "toolchain OK — source $ROOT/ops/env.sh"
