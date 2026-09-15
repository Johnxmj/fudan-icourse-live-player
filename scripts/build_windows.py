"""Build/audit entry point for the standalone Windows live-player artifact."""
from pathlib import Path
import argparse
import os
import platform
import shutil
import subprocess
import sys
import tempfile
import zipfile

ROOT = Path(__file__).resolve().parents[1]
DENIED_PARTS = {
    ".env", "data", "_run_logs", "cookie", "cookies", "credential", "credentials", ".git",
    "transcript", "transcripts", "models--", "huggingface", "whisper-cache", "audio",
}
# PyInstaller's dependency tree contains a few package-owned directories named
# ``audio`` or ``data``.  Keep those exact runtime prefixes while rejecting
# same-named user files everywhere else in the generated archive.
ARCHIVE_RUNTIME_PREFIXES = (
    ("_internal", "av", "audio"),
    ("_internal", "cv2", "data"),
    ("_internal", "sacremoses", "data"),
    ("_internal", "torch", "distributed", "elastic", "utils", "data"),
    ("_internal", "torch", "testing", "_internal", "data"),
    ("_internal", "torch", "utils", "data"),
    ("_internal", "transformers", "data"),
)
ALLOWED_ROOTS = {"live_player", "src", "frontend/live"}

def is_allowed_artifact_input(path: Path) -> bool:
    parts = [part.lower() for part in path.parts]
    return not any(part in DENIED_PARTS or part.startswith("models--") or part.endswith(".bin") for part in parts)

def audit_inputs() -> list[Path]:
    bad = []
    for path in ROOT.rglob("*"):
        if path.is_file() and not ({"dist", ".git"} & set(path.parts)) and not is_allowed_artifact_input(path.relative_to(ROOT)):
            bad.append(path.relative_to(ROOT))
    return bad


def build_pyinstaller_command(output: Path, workpath: Path, specpath: Path) -> list[str]:
    """Return the native build command without adding model or cache data."""
    return [
        sys.executable, "-m", "PyInstaller", "--noconfirm", "--clean",
        "--onedir", "--console", "--name", "Fudan-iCourse-Live",
        "--distpath", str(output), "--workpath", str(workpath), "--specpath", str(specpath),
        "--paths", str(ROOT),
        "--collect-all", "faster_whisper",
        "--collect-all", "ctranslate2",
        "--collect-all", "av",
        "--collect-all", "imageio_ffmpeg",
        "--add-data", f"{ROOT / 'live_player/web'}{os.pathsep}live_player/web",
        str(ROOT / "live_player/__main__.py"),
    ]


def audit_archive(archive: Path) -> list[str]:
    """Return unsafe paths from a generated ZIP without matching runtime library names."""
    denied = []
    with zipfile.ZipFile(archive) as package:
        for name in package.namelist():
            parts = [part.lower() for part in Path(name).parts]
            filename = parts[-1] if parts else ""
            if (
                any(
                    part in DENIED_PARTS - {"audio", "data"} or
                    (part in {"audio", "data"} and not _is_runtime_component(parts, index)) or
                    part.startswith("models--")
                    for index, part in enumerate(parts)
                )
                or filename.endswith((".bin", ".wav", ".mp3", ".pcm", ".m4a", ".aac", ".flac", ".ogg"))
                or "cookie" in filename
                or "credential" in filename
            ):
                denied.append(name)
    return denied


def audit_archives_in(directory: Path) -> list[str]:
    """Audit every generated native ZIP in a release directory."""
    archives = sorted(directory.glob("fudan-icourse-live-*.zip"))
    if not archives:
        return ["No native player archive found"]
    return [f"{archive.name}:{name}" for archive in archives for name in audit_archive(archive)]


def _is_runtime_component(parts: list[str], index: int) -> bool:
    """Allow only the component named by an explicit packaged-runtime prefix."""
    return any(
        start == 1 and index == start + len(prefix) - 1 and tuple(parts[start:start + len(prefix)]) == prefix
        for prefix in ARCHIVE_RUNTIME_PREFIXES
        for start in range(len(parts) - len(prefix) + 1)
    )

def build(output: Path) -> Path:
    """Build on the target OS and archive only PyInstaller's generated directory."""
    output = output.resolve()
    output.mkdir(parents=True, exist_ok=True)
    name = "Fudan-iCourse-Live"
    with tempfile.TemporaryDirectory(prefix="fudan-live-build-") as temporary:
        subprocess.run(
            build_pyinstaller_command(output, Path(temporary) / "work", Path(temporary)),
            cwd=ROOT,
            check=True,
            env={**os.environ, "PYINSTALLER_CONFIG_DIR": str(Path(temporary) / "cache")},
        )
    app = output / name
    if not app.is_dir():
        raise RuntimeError("Packager did not produce the player directory")
    if sys.platform == "darwin":
        launcher = app / "启动本地直播.command"
        launcher.write_text('#!/bin/zsh\ncd -- "$(dirname -- "$0")"\n./Fudan-iCourse-Live --interactive\n', encoding="utf-8")
        launcher.chmod(0o755)
    archive = output / f"fudan-icourse-live-{platform.system().lower()}-{platform.machine().lower()}"
    archive_path = Path(shutil.make_archive(str(archive), "zip", root_dir=output, base_dir=name))
    bad = audit_archive(archive_path)
    if bad:
        raise RuntimeError("Denied artifact archive paths: " + ", ".join(bad))
    return archive_path


def main(argv=None) -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("--audit-only", action="store_true")
    parser.add_argument("--audit-archives-in", type=Path)
    parser.add_argument("--output", type=Path, default=ROOT / "dist")
    args = parser.parse_args(argv)
    bad = audit_inputs()
    if bad:
        print("Denied artifact inputs:", ", ".join(map(str, bad)))
        return 1
    if args.audit_archives_in is not None:
        denied = audit_archives_in(args.audit_archives_in)
        if denied:
            print("Denied artifact archive paths:", ", ".join(denied))
            return 1
        print("Native artifact archive audit passed.")
        return 0
    if args.audit_only:
        print("Windows artifact audit passed.")
        return 0
    print(f"Built {build(args.output)}")
    return 0

if __name__ == "__main__":
    raise SystemExit(main())
