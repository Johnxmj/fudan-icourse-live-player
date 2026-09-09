"""Build/audit entry point for the standalone Windows live-player artifact."""
from pathlib import Path
import argparse
import os
import platform
import shutil
import subprocess
import sys
import tempfile

ROOT = Path(__file__).resolve().parents[1]
DENIED_PARTS = {".env", "data", "_run_logs", "cookie", "cookies", "credential", "credentials", ".git"}
ALLOWED_ROOTS = {"live_player", "src", "frontend/live"}

def is_allowed_artifact_input(path: Path) -> bool:
    parts = {part.lower() for part in path.parts}
    return not (parts & DENIED_PARTS)

def audit_inputs() -> list[Path]:
    bad = []
    for path in ROOT.rglob("*"):
        if path.is_file() and not ({"dist", ".git"} & set(path.parts)) and not is_allowed_artifact_input(path.relative_to(ROOT)):
            bad.append(path.relative_to(ROOT))
    return bad

def build(output: Path) -> Path:
    """Build on the target OS and archive only PyInstaller's generated directory."""
    output = output.resolve()
    output.mkdir(parents=True, exist_ok=True)
    name = "Fudan-iCourse-Live"
    with tempfile.TemporaryDirectory(prefix="fudan-live-build-") as temporary:
        subprocess.run([
            sys.executable, "-m", "PyInstaller", "--noconfirm", "--clean",
            "--onedir", "--console", "--name", name,
            "--distpath", str(output), "--workpath", str(Path(temporary) / "work"),
            "--specpath", temporary, "--paths", str(ROOT),
            "--add-data", f"{ROOT / 'live_player/web'}{os.pathsep}live_player/web",
            str(ROOT / "live_player/__main__.py"),
        ], cwd=ROOT, check=True, env={**os.environ, "PYINSTALLER_CONFIG_DIR": str(Path(temporary) / "cache")})
    app = output / name
    if not app.is_dir():
        raise RuntimeError("Packager did not produce the player directory")
    if sys.platform == "darwin":
        launcher = app / "启动本地直播.command"
        launcher.write_text('#!/bin/zsh\ncd -- "$(dirname -- "$0")"\n./Fudan-iCourse-Live --interactive\n', encoding="utf-8")
        launcher.chmod(0o755)
    archive = output / f"fudan-icourse-live-{platform.system().lower()}-{platform.machine().lower()}"
    return Path(shutil.make_archive(str(archive), "zip", root_dir=output, base_dir=name))


def main(argv=None) -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("--audit-only", action="store_true")
    parser.add_argument("--output", type=Path, default=ROOT / "dist")
    args = parser.parse_args(argv)
    bad = audit_inputs()
    if bad:
        print("Denied artifact inputs:", ", ".join(map(str, bad)))
        return 1
    if args.audit_only:
        print("Windows artifact audit passed.")
        return 0
    print(f"Built {build(args.output)}")
    return 0

if __name__ == "__main__":
    raise SystemExit(main())
