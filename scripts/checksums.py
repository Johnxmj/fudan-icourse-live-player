"""Write portable SHA-256 release checksums for the built archives."""
from hashlib import sha256
from pathlib import Path
import platform

root = Path(__file__).resolve().parents[1] / "dist"
lines = [f"{sha256(path.read_bytes()).hexdigest()}  {path.name}" for path in sorted(root.glob("*.zip"))]
(root / f"SHA256SUMS-{platform.system().lower()}.txt").write_text("\n".join(lines) + "\n", encoding="utf-8")
