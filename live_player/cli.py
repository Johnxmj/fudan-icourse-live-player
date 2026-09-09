"""Launcher for the local live-player UI."""

from __future__ import annotations

import argparse
import getpass
from dataclasses import dataclass
import os
from pathlib import Path
import subprocess
import sys
import webbrowser

from live_player.core.session import SessionManager
from live_player.server.app import LiveApplication
from live_player.server.handler import serve
from src.api.icourse import ICourseClient
from src.api.webvpn import WebVPNSession


@dataclass(frozen=True)
class LauncherConfig:
    application: LiveApplication
    host: str
    port: int
    bootstrap_token: str
    course_ids: tuple[str, ...]


def _env_value(env, name: str) -> str:
    value = env.get(name, "")
    return value.strip() if isinstance(value, str) else str(value).strip()


def _create_client(student_id: str, password: str) -> ICourseClient:
    vpn = WebVPNSession()
    vpn.login(student_id, password)
    vpn.authenticate_icourse(student_id, password)
    return ICourseClient(vpn)


def build_application(env=None) -> LauncherConfig:
    env = os.environ if env is None else env
    student_id = _env_value(env, "StuId")
    password = _env_value(env, "UISPsw")
    if not student_id or not password:
        raise ValueError("StuId and UISPsw must be set")

    course_ids = tuple(
        item.strip()
        for item in _env_value(env, "COURSE_IDS").split(",")
        if item.strip()
    )
    session_manager = SessionManager(lambda: _create_client(student_id, password))
    application = LiveApplication(session_manager, course_ids=course_ids)
    bootstrap_token = application.issue_bootstrap_token(ttl_seconds=60)
    return LauncherConfig(
        application=application,
        host="127.0.0.1",
        port=0,
        bootstrap_token=bootstrap_token,
        course_ids=course_ids,
    )


def open_edge(url):
    if sys.platform == "darwin":
        for browser in ("Google Chrome", "Microsoft Edge"):
            if (Path("/Applications") / f"{browser}.app").is_dir():
                subprocess.Popen(["open", "-a", browser, url])
                return
    candidates = [
        Path(os.environ.get("ProgramFiles(x86)", "")) / "Microsoft/Edge/Application/msedge.exe",
        Path(os.environ.get("ProgramFiles", "")) / "Microsoft/Edge/Application/msedge.exe",
    ]
    edge = next((path for path in candidates if path.is_file()), None)
    if edge:
        subprocess.Popen([str(edge), url])
    else:
        webbrowser.open(url)


def launch_player(config: LauncherConfig, *, pages=False):
    server = serve(config.application, host=config.host, port=config.port)
    host, port = server.server_address[0], server.server_address[1]
    if pages:
        from urllib.parse import quote
        bridge = quote(f"http://{host}:{port}", safe="")
        url = f"https://johnxmj.github.io/fudan-icourse-live-player/live/#bridge={bridge}&bootstrap={quote(config.bootstrap_token, safe='')}"
    else:
        url = f"http://{host}:{port}/#bootstrap={config.bootstrap_token}"
    started = False
    try:
        open_edge(url)
        started = True
        server.serve_forever()
    except KeyboardInterrupt:
        pass
    finally:
        try:
            if started:
                server.shutdown()
        finally:
            try:
                config.application.shutdown()
            finally:
                server.server_close()


def prompt_environment(env, *, input_fn=input, password_fn=getpass.getpass):
    """Collect missing local settings without saving credentials to disk."""
    values = dict(env)
    if not _env_value(values, "StuId"):
        values["StuId"] = input_fn("复旦学号：").strip()
    if not _env_value(values, "UISPsw"):
        values["UISPsw"] = password_fn("统一身份认证密码（输入不显示，仅本次使用）：")
    if not _env_value(values, "COURSE_IDS"):
        values["COURSE_IDS"] = input_fn("课程 ID（多个用逗号分隔；留空查询最新学期，可能较慢）：").strip()
    return values


def main(argv=None, env=None) -> int:
    parser = argparse.ArgumentParser(
        prog="live_player",
        description=(
            "Launch the local iCourse live player on 127.0.0.1, issue a one-use "
            "bootstrap token, and open the browser."
        ),
    )
    parser.add_argument("--pages", action="store_true", help="open the GitHub Pages live shell with a fragment pairing")
    parser.add_argument("--interactive", action="store_true", help="按提示输入学号、密码和课程，无需配置环境变量")
    args = parser.parse_args(argv)
    values = os.environ if env is None else env
    try:
        if args.interactive:
            values = prompt_environment(values)
        config = build_application(values)
    except (ValueError, EOFError):
        print("尚未配置登录信息。请使用 --interactive 按提示启动，或设置 StuId / UISPsw。", file=sys.stderr)
        return 2
    except KeyboardInterrupt:
        return 130
    print("播放器将在浏览器中打开。关闭此窗口或按 Ctrl+C 可停止本地助手。")
    launch_player(config, pages=args.pages)
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
