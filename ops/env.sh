# source me: puts cargo/npm on PATH and points pkg-config + the linker at the
# user-space webkit2gtk sysroot built by setup-toolchain.sh.
_RA_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
_RA_SYS="$_RA_ROOT/.toolchain/sysroot"
_RA_LIB="$_RA_SYS/usr/lib/x86_64-linux-gnu"
# Rust lives under the repo (.toolchain/, under /home/hatch) so it survives VM swaps.
export RUSTUP_HOME="$_RA_ROOT/.toolchain/rustup"
export CARGO_HOME="$_RA_ROOT/.toolchain/cargo"
export PATH="$CARGO_HOME/bin:/opt/hatch-image/bin:$_RA_ROOT/node_modules/.bin:$PATH"
export PKG_CONFIG_PATH="$_RA_LIB/pkgconfig:$_RA_SYS/usr/share/pkgconfig${PKG_CONFIG_PATH:+:$PKG_CONFIG_PATH}"
export LD_LIBRARY_PATH="$_RA_LIB${LD_LIBRARY_PATH:+:$LD_LIBRARY_PATH}"
export RUSTFLAGS="-C link-arg=-Wl,-rpath-link,$_RA_LIB -L $_RA_LIB"
export CARGO_TARGET_DIR="$_RA_ROOT/src-tauri/target"
# crates.io is slow/flaky from this box: be patient instead of failing at 30s.
export CARGO_HTTP_TIMEOUT=120 CARGO_NET_RETRY=10 CARGO_HTTP_LOW_SPEED_LIMIT=1
