"""Build/audit entry point for the standalone Windows live-player artifact."""
from pathlib import Path
import argparse

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

def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("--audit-only", action="store_true")
    args = parser.parse_args()
    bad = audit_inputs()
    if bad:
        print("Denied artifact inputs:", ", ".join(map(str, bad)))
        return 1
    if args.audit_only:
        print("Windows artifact audit passed.")
        return 0
    print("Install requirements-live-build.txt and run PyInstaller on live_player/cli.py in CI.")
    return 0

if __name__ == "__main__":
    raise SystemExit(main())
