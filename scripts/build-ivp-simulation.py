#!/usr/bin/env python3
"""Build the WebAssembly IVP physics module from a pinned IVP SDK checkout.

Usage: python build-ivp-simulation.py <ivp-source> <output-directory>

The tool does not fetch sources, install toolchains, run the game or start a
server. It expects the Emscripten tools (emcmake, em++, emcc) and CMake on PATH,
normally provided by the Emscripten environment script.
"""

import argparse
import json
import os
import re
import subprocess
import sys
from pathlib import Path

PINNED_REVISION = "7579664996e68040dd0158081b04f612e6a2d515"
BRIDGE_SOURCE = Path(__file__).resolve().parent / "ivp-simulation-bridge.cpp"
POLYGON_HEADER = Path("ivp_physics") / "ivp_polygon.hxx"
LIBRARY_NAMES = [
    "ivp_compact_builder",
    "ivp_controller",
    "ivp_physics",
    "ivp_collision",
    "ivp_surface_manager",
    "ivp_utility",
]
EMSCRIPTEN_LINK_FLAGS = [
    "-sMODULARIZE=1",
    "-sEXPORT_ES6=1",
    "-sENVIRONMENT=web,node",
    "-sALLOW_MEMORY_GROWTH=1",
    '-sEXPORTED_FUNCTIONS=["_malloc","_free"]',
    '-sEXPORTED_RUNTIME_METHODS=["HEAPF64","HEAPU8"]',
    "-sASSERTIONS=1",
]
PRAGMA_BLOCK = "#ifndef WIN32\n#pragma interface\n#endif"
VIRTUAL_DESTRUCTOR_TAIL = re.compile(r"public:\s*\};")
VIRTUAL_DESTRUCTOR_TEXT = "public:\n    virtual ~IVP_Polygon() = default;\n};"

def is_linux_host():
    return sys.platform.startswith("linux")


def check_source(source):
    """Precondition checks; they run before anything is written."""
    head = subprocess.run(
        ["git", "rev-parse", "HEAD"], cwd=source, capture_output=True, text=True, check=True
    ).stdout.strip()
    if head != PINNED_REVISION:
        raise RuntimeError(f"Expected IVP {PINNED_REVISION}, got {head}")
    status = subprocess.run(
        ["git", "status", "--porcelain"], cwd=source, capture_output=True, text=True, check=True
    ).stdout
    if status:
        raise RuntimeError("Reference source must be unmodified")
    return head


def patch_polygon_header(path):
    """Apply the two GCC compatibility edits to an IVP_Polygon header.

    Returns the original bytes so that the caller can restore them.
    """
    original = path.read_bytes()
    text = original.decode("utf-8")
    patched = text.replace(PRAGMA_BLOCK, "", 1)
    if patched == text:
        raise RuntimeError(f"expected pragma block not found in {path}")
    match = VIRTUAL_DESTRUCTOR_TAIL.search(patched)
    if not match:
        raise RuntimeError(f"expected class tail not found in {path}")
    patched = patched[: match.start()] + VIRTUAL_DESTRUCTOR_TEXT + patched[match.end() :]
    path.write_text(patched, encoding="utf-8")
    return original


def run_step(step, command, log_path, env):
    """Run one build command without a shell; its output goes to a log file."""
    print(step, flush=True)
    with open(log_path, "w", encoding="utf-8") as log:
        try:
            subprocess.run(command, stdout=log, stderr=subprocess.STDOUT, env=env, check=True)
        except subprocess.CalledProcessError as error:
            raise RuntimeError(
                f"{step} failed with exit status {error.returncode}; see {log_path}"
            ) from error


def configure_command(source, build_dir):
    return [
        "emcmake",
        "cmake",
        "-S",
        str(source),
        "-B",
        str(build_dir),
        "-DCMAKE_BUILD_TYPE=Release",
        "-DIVP_INCLUDE_GEOMPACK=OFF",
        "-DIVP_INCLUDE_3DSIMPORT=OFF",
        "-DIVP_INCLUDE_QHULL=ON",
        "-DCMAKE_CXX_FLAGS=-DUNIX -ffp-contract=off",
    ]


def link_command(output, build_dir):
    libraries = [str(build_dir / f"lib{name}.a") for name in LIBRARY_NAMES]
    if is_linux_host():
        libraries = ["-Wl,--start-group", *libraries, "-Wl,--end-group"]
    return [
        "em++",
        "-std=c++17",
        "-O2",
        "-DUNIX",
        "-DIVP_VERSION_SDK",
        "-fno-strict-aliasing",
        "-ffp-contract=off",
        f"-I{build_dir / 'include' / 'ivp'}",
        str(BRIDGE_SOURCE),
        *libraries,
        *EMSCRIPTEN_LINK_FLAGS,
        "-o",
        str(output / "ivp-simulation.mjs"),
    ]


def build(source, output):
    head = check_source(source)
    output.mkdir(parents=True, exist_ok=True)
    if not BRIDGE_SOURCE.is_file():
        raise RuntimeError(f"bridge source not found: {BRIDGE_SOURCE}")

    env = dict(os.environ)
    env["EM_CACHE"] = str(output / "emscripten-cache")
    build_dir = output / "wasm-build"

    restored = []
    try:
        if is_linux_host():
            header = source / POLYGON_HEADER
            restored.append((header, patch_polygon_header(header)))
        run_step("wasm-configure", configure_command(source, build_dir), output / "wasm-configure.log", env)
        if is_linux_host():
            staged = build_dir / "include" / "ivp" / "ivp_polygon.hxx"
            if staged.is_file():
                patch_polygon_header(staged)
        run_step("wasm-compile", ["cmake", "--build", str(build_dir), "-j", "8"], output / "wasm-compile.log", env)
        run_step("wasm-link", link_command(output, build_dir), output / "wasm-link.log", env)
    finally:
        for path, original in reversed(restored):
            path.write_bytes(original)

    emcc_version = subprocess.run(
        ["emcc", "--version"], env=env, capture_output=True, text=True, check=True
    ).stdout
    record = {
        "revision": head,
        "source": str(source),
        "floatingPointContraction": False,
        "emscripten": emcc_version.splitlines()[0] if emcc_version else "",
    }
    (output / "build.json").write_text(json.dumps(record, indent=2) + "\n", encoding="utf-8")


def main(argv):
    parser = argparse.ArgumentParser(description="Build the WebAssembly IVP physics module.")
    parser.add_argument("source", help="path to the IVP SDK checkout at the pinned revision")
    parser.add_argument("output", help="output directory (created if missing)")
    args = parser.parse_args(argv)
    try:
        build(Path(args.source).resolve(), Path(args.output).resolve())
    except (RuntimeError, OSError, subprocess.CalledProcessError) as error:
        print(f"error: {error}", file=sys.stderr)
        return 1
    return 0


if __name__ == "__main__":
    sys.exit(main(sys.argv[1:]))
