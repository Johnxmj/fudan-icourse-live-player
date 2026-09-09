"""Launcher for the local live-player UI."""

from __future__ import annotations

import argparse
import getpass
import json
from dataclasses import dataclass
import os
from pathlib import Path
import re
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


def build_application(env=None, *, session_manager=None, course_selections=None) -> LauncherConfig:
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
    session_manager = session_manager or SessionManager(lambda: _create_client(student_id, password))
    application = LiveApplication(
        session_manager, course_ids=course_ids, course_selections=course_selections or (),
    )
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
    return values


def _course_data_path(name):
    if not getattr(sys, "frozen", False):
        return Path(__file__).resolve().parents[1] / name
    directory = Path(sys.executable).resolve().parent
    own = directory / name
    if own.is_file():
        return own
    if any((directory.parent / filename).is_file() for filename in ("course-selection.json", "课程目录.json")):
        return directory.parent / name
    return own


def course_selection_path():
    return _course_data_path("course-selection.json")


def _validated_course_ids(values):
    if not isinstance(values, list) or len(values) > 200:
        raise ValueError("invalid saved course selection")
    result = []
    for value in values:
        if type(value) not in (str, int) or not re.fullmatch(r"[A-Za-z0-9]{1,64}", str(value)):
            raise ValueError("invalid saved course identifier")
        if str(value) not in result:
            result.append(str(value))
    return result


def load_course_selection(path=None, *, detailed=False):
    path = course_selection_path() if path is None else Path(path)
    try:
        payload = json.loads(path.read_text(encoding="utf-8"))
    except FileNotFoundError:
        return []
    if not isinstance(payload, dict):
        raise ValueError("invalid saved course selection")
    course_ids = _validated_course_ids(payload.get("courseIds"))
    if not detailed:
        return course_ids
    courses = []
    for row in payload.get("courses") or []:
        if not isinstance(row, dict):
            continue
        try:
            course_id = _validated_course_ids([row.get("course_id")])[0]
        except (TypeError, ValueError):
            continue
        if course_id in course_ids and course_id not in {item["course_id"] for item in courses}:
            courses.append({"course_id": course_id, **{
                key: str(row.get(key) or "") for key in ("title", "teacher", "dept", "course_code")
            }})
    return {
        "course_ids": course_ids,
        "term": str(payload.get("term") or ""),
        "term_name": str(payload.get("termName") or payload.get("term_name") or ""),
        "courses": courses,
    }


def save_course_selection(course_ids, path=None, *, term="", term_name="", courses=None):
    path = course_selection_path() if path is None else Path(path)
    ids = _validated_course_ids(course_ids)
    payload = {"courseIds": ids}
    if term:
        payload["term"] = str(term)
    if term_name:
        payload["termName"] = str(term_name)
    if courses is not None:
        by_id = {str(row.get("course_id")): row for row in courses if isinstance(row, dict)}
        payload["courses"] = [{"course_id": course_id, **{
            key: str(by_id.get(course_id, {}).get(key) or "")
            for key in ("title", "teacher", "dept", "course_code")
        }} for course_id in ids]
    path.write_text(json.dumps(payload, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")


def load_course_catalog(path=None):
    path = _course_data_path("课程目录.json") if path is None else Path(path)
    try:
        payload = json.loads(path.read_text(encoding="utf-8"))
    except FileNotFoundError:
        return None
    if not isinstance(payload, dict) or payload.get("complete") is not True:
        raise ValueError("saved course directory is incomplete")
    rows = payload.get("courses")
    if not isinstance(rows, list) or payload.get("missing_pages") or payload.get("incomplete_pages"):
        raise ValueError("saved course directory is incomplete")
    courses = []
    seen = set()
    for row in rows:
        if not isinstance(row, dict):
            raise ValueError("invalid saved course")
        course_id = _validated_course_ids([row.get("course_id")])[0]
        if course_id in seen:
            raise ValueError("saved course directory contains duplicate identifiers")
        seen.add(course_id)
        courses.append({"course_id": course_id, **{
            key: str(row.get(key) or "") for key in ("title", "teacher", "dept", "course_code")
        }})
    if payload.get("imported_count") != len(courses) or type(payload.get("total")) is not int or payload["total"] < len(courses):
        raise ValueError("saved course directory count is inconsistent")
    return {"term": str(payload.get("term") or ""), "term_name": str(payload.get("term_name") or "已保存学期"), "courses": courses}


def choose_term(terms, *, input_fn=input, output_fn=print):
    """Let the user choose one discovered semester by its displayed number."""
    if not isinstance(terms, list) or not terms:
        raise RuntimeError("official course directory has no recent semester")
    normalized = [term for term in terms if isinstance(term, dict) and str(term.get("code") or "").strip()]
    if not normalized:
        raise RuntimeError("official course directory has no valid semester")
    if len(normalized) == 1:
        return normalized[0]
    output_fn("可用学期：")
    for index, term in enumerate(normalized, 1):
        output_fn(f"{index}. {term.get('name') or term.get('code')}")
    while True:
        choice = input_fn("选择学期编号：").strip()
        if choice.isascii() and choice.isdecimal() and 1 <= int(choice) <= len(normalized):
            return normalized[int(choice) - 1]
        output_fn("编号无效，请选择列表中的学期编号。")


def select_courses(client=None, *, catalog=None, input_fn=input, output_fn=print, return_metadata=False):
    """Search public catalog metadata and return only the user's selected IDs."""
    if catalog is None:
        output_fn("正在读取官方课程目录，请稍候…")
        terms = client.discover_terms()
        term = choose_term(terms, input_fn=input_fn, output_fn=output_fn)
        courses = client.list_semester_courses(term["code"])
        term_name = term["name"]
    else:
        output_fn("正在使用已保存的官方课程目录。需要换学期时，请在课程选择页面更新目录。")
        courses = catalog["courses"]
        term = {"code": catalog.get("term", ""), "name": catalog["term_name"]}
        term_name = catalog["term_name"]
    if not courses:
        raise RuntimeError("official course directory is empty")
    output_fn(f"已读取 {term_name} 的 {len(courses)} 门可见课程。可按课程名、教师或学院搜索。")
    selected = []
    while True:
        query = input_fn("课程名或教师（多个关键词用空格分隔；回车完成选择）：").strip()
        if not query:
            if selected:
                if return_metadata:
                    selected_set = set(selected)
                    return {
                        "course_ids": selected,
                        "term": str(term.get("code") or ""),
                        "term_name": str(term.get("name") or ""),
                        "courses": [course for course in courses if str(course.get("course_id")) in selected_set],
                    }
                return selected
            output_fn("请先搜索并选择至少一门课程。")
            continue
        words = query.casefold().split()
        matches = [course for course in courses if all(word in " ".join(
            str(course.get(key) or "") for key in ("title", "teacher", "dept", "course_id", "course_code")
        ).casefold() for word in words)]
        if not matches:
            output_fn("没有找到匹配课程，请换一个课程名或教师关键词。")
            continue
        if len(matches) > 50:
            output_fn(f"找到 {len(matches)} 门课程，请补充教师或更具体的课程名。")
            continue
        for index, course in enumerate(matches, 1):
            output_fn(f"{index}. {course.get('title') or '未命名课程'}｜{course.get('teacher') or '教师未公布'}｜{course.get('dept') or ''}")
        choices = input_fn("选择编号（多个用逗号分隔；回车重新搜索）：").strip()
        if not choices:
            continue
        parts = [part for part in re.split(r"[\s,，;；]+", choices) if part]
        if not parts or any(not part.isascii() or not part.isdecimal() or not 1 <= int(part) <= len(matches) for part in parts):
            output_fn("编号无效，请重新搜索并选择列表中的编号。")
            continue
        additions = [str(matches[int(part) - 1]["course_id"]) for part in parts]
        selected = list(dict.fromkeys(selected + additions))
        if len(selected) > 200:
            raise ValueError("too many selected courses")
        output_fn(f"已选 {len(selected)} 门。可继续搜索添加，或直接回车启动播放器。")


def _configure_console_encoding():
    """Keep localized launcher messages printable on Windows CI and consoles."""
    for stream in (sys.stdout, sys.stderr):
        reconfigure = getattr(stream, "reconfigure", None)
        if reconfigure is not None:
            try:
                reconfigure(encoding="utf-8", errors="replace")
            except (OSError, ValueError):
                pass


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
    parser.add_argument("--select-courses", action="store_true", help="重新按课程名或教师搜索，替换已保存的课程选择")
    args = parser.parse_args(argv)
    _configure_console_encoding()
    values = dict(os.environ if env is None else env)
    session_manager = None
    saved_metadata = ()
    try:
        if not args.select_courses and not _env_value(values, "COURSE_IDS"):
            try:
                saved = load_course_selection(detailed=True)
                saved_ids = saved.get("course_ids", []) if isinstance(saved, dict) else saved
                if saved_ids:
                    saved_metadata = saved.get("courses", ()) if isinstance(saved, dict) else ()
                    values["COURSE_IDS"] = ",".join(saved_ids)
                    print(f"已读取保存的 {len(saved_ids)} 门课程。需要调整时使用 --select-courses。")
            except (OSError, ValueError):
                print("已保存的课程选择无法读取，本次将重新选择课程。", file=sys.stderr)
        if args.interactive or args.select_courses:
            values = prompt_environment(values)
            if args.select_courses or not _env_value(values, "COURSE_IDS"):
                student_id, password = _env_value(values, "StuId"), _env_value(values, "UISPsw")
                if not student_id or not password:
                    raise ValueError("missing credentials")
                try:
                    cached_catalog = load_course_catalog()
                except (OSError, ValueError):
                    cached_catalog = None
                    print("已保存的课程目录不完整，本次将重新读取官方目录。", file=sys.stderr)
                if cached_catalog is not None:
                    selection = select_courses(catalog=cached_catalog, return_metadata=True)
                else:
                    session_manager = SessionManager(lambda: _create_client(student_id, password))
                    selection = session_manager.call(lambda client: select_courses(client, return_metadata=True))
                if isinstance(selection, dict):
                    ids = selection["course_ids"]
                    saved_metadata = selection.get("courses") or ()
                else:  # compatibility with callers that wrap the legacy list API
                    ids = _validated_course_ids(selection)
                    selection = {"course_ids": ids, "term": "", "term_name": "", "courses": None}
                values["COURSE_IDS"] = ",".join(ids)
                try:
                    save_course_selection(ids, term=selection.get("term"), term_name=selection.get("term_name"), courses=selection.get("courses"))
                except OSError:
                    print("课程已选好，但当前目录无法保存选择；下次启动需要重新选择。", file=sys.stderr)
        # Create the one-use bootstrap only after the interactive selection ends.
        config = build_application(values, session_manager=session_manager, course_selections=saved_metadata)
    except (ValueError, EOFError):
        print("尚未配置登录信息。请使用 --interactive 按提示启动，或设置 StuId / UISPsw。", file=sys.stderr)
        return 2
    except KeyboardInterrupt:
        return 130
    except RuntimeError:
        print("官方课程目录暂时无法读取。请检查账号、校园网或 WebVPN 后重试。", file=sys.stderr)
        return 1
    print("播放器将在浏览器中打开。关闭此窗口或按 Ctrl+C 可停止本地助手。")
    launch_player(config, pages=args.pages)
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
