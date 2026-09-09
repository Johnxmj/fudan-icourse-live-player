"""Module and packaged executable entry point."""
import sys

from live_player.cli import main

if __name__ == "__main__":
    # Packaged desktop launchers should work without preconfigured environment.
    arguments = sys.argv[1:]
    if getattr(sys, "frozen", False) and not arguments:
        arguments = ["--interactive"]
    raise SystemExit(main(arguments))
