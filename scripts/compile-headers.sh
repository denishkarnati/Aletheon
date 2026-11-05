#!/usr/bin/env bash
# Compile every generated register header with a real C compiler (gcc or clang if present, else clang via `python -m ziglang cc`).
#   HDR_OUT=$PWD/hdrs npm run test:headers && bash scripts/compile-headers.sh hdrs
set -euo pipefail
dir="${1:?usage: compile-headers.sh <dir produced by test:headers with HDR_OUT>}"
if command -v gcc >/dev/null 2>&1; then CC=(gcc); elif command -v clang >/dev/null 2>&1; then CC=(clang); else CC=(python -m ziglang cc); fi
obj="$(mktemp -u).o"
fail=0; n=0
cd "$dir"
for d in */; do
  d="${d%/}"
  : > "$d.all.c"
  for f in "$d"/*.h; do echo "#include \"$f\"" >> "$d.all.c"; done
  for mode in "-x c -std=c11" "-x c++ -std=c++17"; do
    # shellcheck disable=SC2086
    if ! "${CC[@]}" -c -o "$obj" -Wno-unused-command-line-argument $mode -Wall -Werror "$d.all.c"; then echo "FAIL $d ($mode, combined)"; fail=$((fail+1)); fi
  done
  for f in "$d"/*.h; do
    n=$((n+1))
    if ! "${CC[@]}" -c -o "$obj" -Wno-unused-command-line-argument -x c -std=c11 -Wall -Werror "$f" 2>/dev/null; then echo "FAIL $f"; fail=$((fail+1)); fi
  done
done
# The ARM devices' combined headers, built for their real CPU (clang/zig only: gcc would need a separate arm-none-eabi toolchain).
cross=0
if [ "${CC[0]}" != gcc ]; then
  for spec in rp2040:thumbv6m:cortex-m0plus stm32f401:thumbv7em:cortex-m4 nrf52840:thumbv7em:cortex-m4; do
    IFS=: read -r d triple cpu <<< "$spec"
    [ -f "$d.all.c" ] || continue
    # zig spells targets and CPUs its own way (thumb-freestanding-eabi, cortex_m4); plain clang takes the LLVM triple.
    if [ "${CC[0]}" = python ]; then tflags=(-target thumb-freestanding-eabi "-mcpu=${cpu//-/_}"); else tflags=("--target=$triple-none-eabi" "-mcpu=$cpu"); fi
    if "${CC[@]}" "${tflags[@]}" -c -o "$obj" -Wno-unused-command-line-argument -x c -std=c11 -Wall -Werror "$d.all.c"; then
      cross=$((cross+1)); echo "thumb $d ($cpu): ok"
    else echo "FAIL thumb $d ($cpu)"; fail=$((fail+1)); fi
  done
fi
echo "compiled $n headers standalone plus combined TUs; $cross ARM devices cross-compiled for thumb; failures: $fail"
exit $((fail > 0))
