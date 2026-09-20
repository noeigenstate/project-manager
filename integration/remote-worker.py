"""Project Grid's session-scoped Linux worker, transported over one SSH connection."""
import base64
import concurrent.futures
import glob
import hashlib
import json
import os
import re
import shutil
import signal
import socket
import stat
import struct
import subprocess
import sys
import tempfile
import threading
import time
from datetime import datetime

PAGE_BYTES = 256 * 1024
MAX_READ = 256 * 1024
MAX_MESSAGE = 2 * 1024 * 1024
PREFIX = "PGW1 "
IMAGE_TYPES = {".png": "image/png", ".apng": "image/png", ".jpg": "image/jpeg", ".jpeg": "image/jpeg", ".jpe": "image/jpeg", ".jfif": "image/jpeg", ".gif": "image/gif", ".webp": "image/webp", ".bmp": "image/bmp", ".avif": "image/avif", ".svg": "image/svg+xml", ".ico": "image/x-icon"}
VIDEO_TYPES = {".mp4": "video/mp4", ".m4v": "video/mp4", ".webm": "video/webm", ".ogv": "video/ogg", ".ogg": "video/ogg", ".mov": "video/quicktime", ".mkv": "video/x-matroska", ".avi": "video/x-msvideo"}

NOTIFY_SOURCE = r'''import hashlib,json,os,socket,sys,time
try:
    mode=sys.argv[1]
    event={"type":mode,"token":os.environ["PROJECT_GRID_TOKEN"],"cwd":os.getcwd(),"codexHome":os.environ.get("CODEX_HOME",os.path.expanduser("~/.codex")),"sentAt":int(time.time()*1000)}
    if mode=="notify":
        payload=json.loads(sys.argv[2])
        if payload.get("type")!="agent-turn-complete": sys.exit(0)
        identity=str(payload.get("thread-id",""))+":"+str(payload.get("turn-id",""))
        if identity==":": sys.exit(0)
        event.update(type="turn-complete",eventId=hashlib.sha256(identity.encode()).hexdigest(),threadId=payload.get("thread-id"),turnId=payload.get("turn-id"))
    elif mode=="shell-prompt": event["codexAvailable"]=len(sys.argv)>2 and sys.argv[2]=="1"
    elif mode=="codex-exited": event["exitCode"]=int(sys.argv[2])
    with socket.socket(socket.AF_UNIX,socket.SOCK_STREAM) as client:
        client.settimeout(2)
        client.connect(os.environ["PROJECT_GRID_SOCKET"])
        client.sendall((json.dumps(event)+"\n").encode())
except Exception: pass
'''

BASH_SOURCE = r'''if [ -r "$HOME/.bashrc" ]; then . "$HOME/.bashrc"; fi
cd -- "$PROJECT_GRID_ROOT" || exit 1
unalias codex 2>/dev/null || true
__pg_emit() { "$PROJECT_GRID_PYTHON" "$PROJECT_GRID_NOTIFY_FILE" "$@" >/dev/null 2>&1; }
function codex {
    local executable result
    executable=$(type -P codex)
    if [ -z "$executable" ]; then printf 'Codex CLI was not found on this SSH host.\n'; return 127; fi
    __pg_emit codex-started
    "$executable" -c "notify=$PROJECT_GRID_NOTIFY_COMMAND" -c 'tui.terminal_title=["session-id"]' "$@"
    result=$?
    __pg_emit codex-exited "$result"
    return "$result"
}
__pg_prompt() {
    local result=$? available=0
    if type -P codex >/dev/null; then available=1; fi
    __pg_emit shell-prompt "$available"
    return "$result"
}
if declare -p PROMPT_COMMAND 2>/dev/null | grep -q 'declare -a'; then
    PROMPT_COMMAND=(__pg_prompt "${PROMPT_COMMAND[@]}")
else
    PROMPT_COMMAND="__pg_prompt${PROMPT_COMMAND:+; $PROMPT_COMMAND}"
fi
# Keep Shift+Enter as an inserted newline at the Bash prompt as well as in
# TUIs such as Codex. These bindings are private to this generated shell rc.
bind -m emacs-standard '"\e[13;2u":"\C-v\C-j"' 2>/dev/null || true
bind -m vi-insertion '"\e[13;2u":"\C-v\C-j"' 2>/dev/null || true
printf '\033[36m  PROJECT GRID / SSH\033[0m\n  Type codex to start, or codex resume to continue.\n\n'
'''

def image_type(data):
    if data.startswith(b"\x89PNG\r\n\x1a\n"): return "image/png"
    if data.startswith(b"\xff\xd8\xff"): return "image/jpeg"
    if data[:6] in (b"GIF87a", b"GIF89a"): return "image/gif"
    if data[:4] == b"RIFF" and data[8:12] == b"WEBP": return "image/webp"
    if data.startswith(b"BM"): return "image/bmp"
    if data.startswith(b"\0\0\1\0"): return "image/x-icon"
    if data[4:8] == b"ftyp" and (b"avif" in data[8:] or b"avis" in data[8:]): return "image/avif"
    return None

def json_records(filename):
    """Skip oversized transcript messages; lifecycle events remain small."""
    with open(filename, "rb") as source:
        while True:
            line = source.readline(1024 * 1024 + 1)
            if not line: break
            if len(line) > 1024 * 1024:
                while line and not line.endswith(b"\n"): line = source.readline(1024 * 1024 + 1)
                continue
            try: yield json.loads(line)
            except (ValueError, UnicodeError): continue

def recent_session(root, codex_home, thread_id=None):
    directory = os.path.join(codex_home, "sessions")
    candidates = []
    for current, dirs, files in os.walk(directory):
        dirs[:] = [name for name in dirs if not os.path.islink(os.path.join(current, name))]
        for name in files:
            if name.startswith("rollout-") and name.endswith(".jsonl"):
                filename = os.path.join(current, name)
                try: candidates.append((os.stat(filename).st_mtime, filename))
                except OSError: pass
    for modified, filename in sorted(candidates, reverse=True):
        try:
            records = json_records(filename)
            meta = next(records, {})
            payload = meta.get("payload", {})
            source = payload.get("source", "cli")
            if meta.get("type") != "session_meta" or source not in ("cli", "vscode") or os.path.realpath(payload.get("cwd", "")) != root: continue
            identity = payload.get("id", "")
            if not re.fullmatch(r"[a-fA-F0-9-]{36}", identity): continue
            if thread_id and identity != thread_id: continue
            state = "unknown"
            for record in records:
                item = record.get("payload", {})
                if record.get("type") == "event_msg":
                    event = item.get("type")
                    if event in ("task_started", "turn_started", "user_message"): state = "interrupted"
                    elif event in ("task_complete", "turn_completed"): state = "complete"
                    elif event in ("turn_aborted", "turn_interrupted"): state = "interrupted"
                elif record.get("type") == "response_item" and item.get("type") == "message":
                    if item.get("role") == "user": state = "interrupted"
                    elif item.get("role") == "assistant" and item.get("phase") == "final": state = "complete"
            return {"id": identity, "state": state, "modifiedAt": int(modified * 1000)}
        except (OSError, ValueError, TypeError): continue
    return None

class CodexActivityReader:
    """Incrementally read only the interactive parent's lifecycle records."""
    def __init__(self, root, home, since, thread_id=None):
        self.root, self.home, self.since = root, home, since
        self.thread_id = thread_id
        self.filename, self.snapshot = None, None
        self.offset, self.buffer, self.skipping, self.next_discovery = 0, b"", False, 0

    def discover(self):
        if time.monotonic() < self.next_discovery: return
        self.next_discovery = time.monotonic() + 2
        candidates = []
        for current, dirs, files in os.walk(os.path.join(self.home, "sessions")):
            dirs[:] = [name for name in dirs if not os.path.islink(os.path.join(current, name))]
            for name in files:
                if not (name.startswith("rollout-") and name.endswith(".jsonl")): continue
                if self.thread_id and self.thread_id not in name: continue
                filename = os.path.join(current, name)
                try:
                    modified = os.stat(filename).st_mtime * 1000
                    if self.thread_id or modified >= self.since - 2000: candidates.append((modified, filename))
                except OSError: pass
        for _, filename in sorted(candidates, reverse=True):
            if filename == self.filename: return
            try:
                rows = json_records(filename)
                try: record = next(rows, {})
                finally: rows.close()
                meta = record.get("payload", {})
                if record.get("type") != "session_meta" or meta.get("source", "cli") not in ("cli", "vscode"): continue
                if os.path.realpath(meta.get("cwd", "")) != os.path.realpath(self.root) or not re.fullmatch(r"[a-fA-F0-9-]{36}", meta.get("id", "")): continue
                if self.thread_id and meta.get("id") != self.thread_id: continue
                self.filename = filename
                self.offset, self.buffer, self.skipping = 0, b"", False
                self.snapshot = {"threadId": meta["id"], "turnId": None, "state": "unknown", "updatedAt": 0}
                return
            except (OSError, ValueError, TypeError): pass

    def record(self, record):
        if record.get("type") != "event_msg": return
        item = record.get("payload", {})
        kind, turn = item.get("type"), item.get("turn_id")
        try: updated = int(datetime.fromisoformat(record.get("timestamp", "").replace("Z", "+00:00")).timestamp() * 1000)
        except (ValueError, TypeError): updated = 0
        if kind in ("task_started", "turn_started") and isinstance(turn, str) and turn:
            self.snapshot.update(turnId=turn, state="working", updatedAt=updated)
        elif kind in ("task_complete", "turn_completed", "turn_aborted", "turn_interrupted"):
            if not self.snapshot["turnId"] or turn and turn != self.snapshot["turnId"]: return
            self.snapshot.update(state="complete" if kind in ("task_complete", "turn_completed") else "interrupted", updatedAt=updated)

    def read(self):
        if not self.filename or self.snapshot["state"] != "working": self.discover()
        if not self.filename: return None
        with open(self.filename, "rb") as source:
            size = os.fstat(source.fileno()).st_size
            if size < self.offset:
                self.offset, self.buffer, self.skipping = 0, b"", False
                self.snapshot.update(turnId=None, state="unknown", updatedAt=0)
            source.seek(self.offset)
            end = min(size, self.offset + 4 * 1024 * 1024)
            while self.offset < end:
                chunk = source.read(min(65536, end - self.offset))
                if not chunk: break
                self.offset += len(chunk)
                self.buffer += chunk
                while b"\n" in self.buffer:
                    line, self.buffer = self.buffer.split(b"\n", 1)
                    if not self.skipping and len(line) <= 1024 * 1024:
                        try: self.record(json.loads(line))
                        except (ValueError, UnicodeError, TypeError): pass
                    self.skipping = False
                if len(self.buffer) > 1024 * 1024: self.buffer, self.skipping = b"", True
            return dict(self.snapshot) if self.offset >= size else None

class Worker:
    def __init__(self, emit):
        self.emit = emit
        self.root = None
        self.temp = None
        self.master = None
        self.child = None
        self.stopping = False
        self.sequence = 0
        self.sequence_lock = threading.Lock()
        self.codex_home = os.environ.get("CODEX_HOME", os.path.expanduser("~/.codex"))
        self.uploads = {}
        self.activity_reader = None
        self.activity_lock = threading.Lock()

    def codex_status(self, since, thread_id=None):
        if not isinstance(since, (int, float)) or since <= 0: raise ValueError("无效的会话时间。")
        with self.activity_lock:
            if thread_id is not None and not re.fullmatch(r"[a-fA-F0-9-]{36}", thread_id): raise ValueError("无效的会话标识。")
            if self.activity_reader is None or self.activity_reader.since != since or self.activity_reader.thread_id != thread_id:
                self.activity_reader = CodexActivityReader(self.coding_root, self.codex_home, since, thread_id)
            return self.activity_reader.read()

    def initialize(self, config):
        self.root = os.path.realpath(os.path.expanduser(config["path"]))
        if not os.path.isdir(self.root): raise ValueError("远程项目目录不存在或不是文件夹。")
        self.coding_root = os.path.realpath(os.path.expanduser(config.get("codingPath") or self.root))
        if not os.path.isdir(self.coding_root): raise ValueError("上次工作的远程目录已不存在。")
        self.token = config["token"]
        self.project_id = config["projectId"]
        branch = ""
        try:
            result = subprocess.run(["git", "-C", self.root, "branch", "--show-current"], stdout=subprocess.PIPE, stderr=subprocess.PIPE, universal_newlines=True, timeout=3)
            if result.returncode == 0: branch = result.stdout.strip()[:120]
        except (OSError, subprocess.TimeoutExpired): pass
        return {"root": self.root, "branch": branch, "platform": sys.platform}

    def resolve(self, relative=""):
        if not isinstance(relative, str) or len(relative) > 4096 or "\0" in relative or "\\" in relative or os.path.isabs(relative) or ".." in relative.split("/"): raise ValueError("无效的远程文件路径。")
        filename = os.path.realpath(os.path.join(self.root, relative))
        if os.path.commonpath([self.root, filename]) != self.root: raise ValueError("该链接指向远程项目目录之外。")
        return filename

    def metadata(self, relative):
        filename = self.resolve(relative)
        info = os.stat(filename)
        return {"path": relative, "name": os.path.basename(filename), "size": info.st_size, "modifiedAt": int(info.st_mtime * 1000), "realPath": os.path.relpath(filename, self.root).replace(os.sep, "/"), "directory": stat.S_ISDIR(info.st_mode), "file": stat.S_ISREG(info.st_mode), "link": os.path.islink(os.path.join(self.root, relative))}

    def entry_path(self, relative):
        if not relative or relative == ".": raise ValueError("不能删除或重命名项目根目录。")
        self.resolve(os.path.dirname(relative))
        if not isinstance(relative, str) or "\0" in relative or "\\" in relative or os.path.isabs(relative) or ".." in relative.split("/"): raise ValueError("无效的文件路径。")
        parent = self.resolve(os.path.dirname(relative))
        return os.path.join(parent, os.path.basename(relative))

    def name(self, value):
        if not isinstance(value, str) or not value or len(value) > 255 or value in (".", "..") or any(ord(char) < 32 for char in value) or "/" in value or "\\" in value: raise ValueError("无效的文件名。")
        return value

    def unique_name(self, directory, name):
        stem, extension = os.path.splitext(name)
        for number in range(10000):
            candidate = name if number == 0 else "%s - 副本%s%s" % (stem, " (%s)" % number if number > 1 else "", extension)
            if not os.path.lexists(os.path.join(directory, candidate)): return candidate
        raise ValueError("同名文件过多。")

    def create(self, relative, name, kind, unique=False):
        parent = self.resolve(relative)
        if not os.path.isdir(parent): raise ValueError("请选择文件夹。")
        name = self.name(name)
        if unique: name = self.unique_name(parent, name)
        target = os.path.join(parent, name)
        if kind == "directory": os.mkdir(target)
        elif kind == "file":
            with open(target, "xb"): pass
        else: raise ValueError("无效的文件类型。")
        return {"path": "/".join(filter(None, [relative, name])), "kind": kind}

    def rename(self, relative, name):
        source = self.entry_path(relative)
        target = os.path.join(os.path.dirname(source), self.name(name))
        if source != target:
            if os.path.lexists(target): raise ValueError("已存在同名文件。")
            if os.path.islink(source) or not os.path.isdir(source):
                os.link(source, target, follow_symlinks=False)
                os.unlink(source)
            else: os.rename(source, target)
        return {"path": os.path.relpath(target, self.root).replace(os.sep, "/")}

    def remove(self, relative):
        filename = self.entry_path(relative)
        if os.path.islink(filename) or not os.path.isdir(filename): os.unlink(filename)
        else: shutil.rmtree(filename)
        return True

    def start_upload(self, relative, name, size):
        if type(size) is not int or size < 0 or size > 9007199254740991: raise ValueError("无效的文件大小。")
        parent = self.resolve(relative)
        name = self.unique_name(parent, self.name(name))
        descriptor, temporary = tempfile.mkstemp(prefix=".project-grid-upload-", dir=parent)
        identity = os.urandom(16).hex()
        self.uploads[identity] = {"file": os.fdopen(descriptor, "wb"), "temporary": temporary, "target": os.path.join(parent, name), "size": size, "written": 0}
        return {"id": identity}

    def upload_chunk(self, identity, offset, data):
        upload = self.uploads[identity]
        chunk = base64.b64decode(data, validate=True)
        if offset != upload["written"] or len(chunk) > MAX_READ or upload["written"] + len(chunk) > upload["size"]: raise ValueError("上传数据位置不正确。")
        upload["file"].write(chunk); upload["written"] += len(chunk)
        return True

    def finish_upload(self, identity):
        upload = self.uploads[identity]
        if upload["written"] != upload["size"]: raise ValueError("文件尚未完整上传。")
        upload["file"].flush(); os.fsync(upload["file"].fileno()); upload["file"].close()
        # A hard link installs a completed file atomically without overwriting
        # anything created by another process during the transfer.
        os.link(upload["temporary"], upload["target"])
        os.unlink(upload["temporary"]); del self.uploads[identity]
        return {"path": os.path.relpath(upload["target"], self.root).replace(os.sep, "/")}

    def cancel_upload(self, identity):
        upload = self.uploads.pop(identity, None)
        if upload:
            upload["file"].close()
            try: os.unlink(upload["temporary"])
            except OSError: pass
        return True

    def directory(self, relative, offset):
        if type(offset) is not int or offset < 0: raise ValueError("无效的目录页码。")
        with os.scandir(self.resolve(relative)) as iterator:
            entries = [{"name": entry.name, "path": "/".join(filter(None, [relative, entry.name])), "kind": "link" if entry.is_symlink() else "directory" if entry.is_dir() else "file"} for entry in iterator]
        entries.sort(key=lambda entry: (entry["kind"] != "directory", entry["name"].casefold()))
        return {"path": relative, "entries": entries[offset:offset + 200], "total": len(entries), "nextOffset": offset + 200 if offset + 200 < len(entries) else None}

    def read(self, relative, offset, length):
        if type(offset) is not int or offset < 0 or type(length) is not int or not 0 <= length <= MAX_READ: raise ValueError("无效的文件读取范围。")
        filename = self.resolve(relative)
        with open(filename, "rb") as source:
            if not stat.S_ISREG(os.fstat(source.fileno()).st_mode): raise ValueError("只能预览普通文件。")
            source.seek(offset)
            return base64.b64encode(source.read(length)).decode("ascii")

    def preview(self, relative, page_index):
        if type(page_index) is not int or page_index < 0: raise ValueError("无效的文件页码。")
        meta = self.metadata(relative)
        if not meta["file"]: raise ValueError("只能预览普通文件。")
        base = {key: meta[key] for key in ("path", "name", "size", "modifiedAt")}
        base["revision"] = self.file_revision(os.stat(self.resolve(relative)))
        extension = os.path.splitext(relative)[1].lower()
        with open(self.resolve(relative), "rb") as source:
            prefix = source.read(64)
            mime = image_type(prefix) or IMAGE_TYPES.get(extension)
            if mime: return dict(base, kind="image", mimeType=mime)
            if extension in VIDEO_TYPES: return dict(base, kind="video", mimeType=VIDEO_TYPES[extension])
            encoding, bom = "utf-8", 0
            if prefix.startswith(b"\xff\xfe"): encoding, bom = "utf-16le", 2
            elif prefix.startswith(b"\xfe\xff"): encoding, bom = "utf-16be", 2
            elif prefix.startswith(b"\xef\xbb\xbf"): bom = 3
            count = max(1, (meta["size"] - bom + PAGE_BYTES - 1) // PAGE_BYTES)
            index = min(page_index, count - 1)
            start = bom + index * PAGE_BYTES
            end = min(meta["size"], start + PAGE_BYTES)
            read_start = max(bom, start - 2)
            source.seek(read_start)
            data = source.read(max(0, min(meta["size"], end + 4) - read_start))
            def boundary(position):
                offset = max(0, min(len(data), position - read_start))
                if encoding == "utf-8":
                    while offset < len(data) and data[offset] & 0xc0 == 0x80: offset += 1
                elif offset >= 2 and offset + 1 < len(data):
                    order = "little" if encoding == "utf-16le" else "big"
                    unit = int.from_bytes(data[offset:offset + 2], order)
                    previous = int.from_bytes(data[offset - 2:offset], order)
                    if 0xdc00 <= unit <= 0xdfff and 0xd800 <= previous <= 0xdbff: offset += 2
                return offset
            byte_start, byte_end = boundary(start), boundary(end)
            page = data[byte_start:byte_end]
            if encoding == "utf-8" and b"\0" in page: return dict(base, kind="unsupported", reason="二进制文件不支持文本预览。")
            try: content = page.decode(encoding)
            except UnicodeError: return dict(base, kind="unsupported", reason="此文件的编码不支持预览。")
            return dict(base, kind="html" if extension in (".html", ".htm") else "markdown" if extension in (".md", ".markdown", ".mdown", ".mkd") else "text", content=content, page={"index": index, "count": count, "byteStart": read_start + byte_start, "byteEnd": read_start + byte_end, "encoding": encoding})

    @staticmethod
    def file_revision(info):
        return "%s:%s:%s:%s:%s" % (info.st_dev, info.st_ino, info.st_size, info.st_mtime_ns, info.st_ctime_ns)

    def save_file(self, relative, page_index, revision, data):
        content_bytes = base64.b64decode(data, validate=True)
        if len(content_bytes) > 1024 * 1024: raise ValueError("本次编辑内容超过 1 MB，请分段保存。")
        content = content_bytes.decode("utf-8")
        preview = self.preview(relative, page_index)
        if preview["kind"] not in ("text", "html", "markdown"): raise ValueError("此文件不支持文本编辑。")
        if preview["revision"] != revision: raise ValueError("文件已被其他程序修改，请刷新后重新编辑，避免覆盖新内容。")
        filename = self.resolve(relative)
        temporary = None
        with open(filename, "r+b") as source:
            info, opened = os.stat(filename), os.fstat(source.fileno())
            if (info.st_dev, info.st_ino) != (opened.st_dev, opened.st_ino) or self.file_revision(info) != revision: raise ValueError("文件已变化，请刷新后重新编辑。")
            if "\r\n" in preview["content"]: content = re.sub(r"\r?\n", "\r\n", content)
            descriptor, temporary = tempfile.mkstemp(prefix=".project-grid-edit-", dir=os.path.dirname(filename))
            try:
                with os.fdopen(descriptor, "wb") as destination:
                    os.chmod(temporary, stat.S_IMODE(info.st_mode))
                    def copy_range(start, end):
                        source.seek(start)
                        remaining = end - start
                        while remaining:
                            chunk = source.read(min(65536, remaining))
                            if not chunk: raise ValueError("保存时文件发生变化，请刷新后重试。")
                            destination.write(chunk)
                            remaining -= len(chunk)
                    copy_range(0, preview["page"]["byteStart"])
                    destination.write(content.encode(preview["page"]["encoding"]))
                    copy_range(preview["page"]["byteEnd"], info.st_size)
                    destination.flush(); os.fsync(destination.fileno())
                source.close()
                if self.file_revision(os.stat(filename)) != revision: raise ValueError("文件已被其他程序修改，本次保存已取消。")
                os.replace(temporary, filename)
                temporary = None
            finally:
                if temporary and os.path.exists(temporary): os.unlink(temporary)
        return self.preview(relative, page_index)

    def start_terminal(self, cols, rows):
        if os.name != "posix": raise ValueError("SSH 远端目前需要 Linux、Python 3 和 Bash。")
        import pty
        bash = shutil.which("bash")
        if not bash: raise ValueError("远端没有找到 Bash。")
        self.temp = tempfile.mkdtemp(prefix="project-grid-")
        notify_file = os.path.join(self.temp, "notify.py")
        rc_file = os.path.join(self.temp, "bashrc")
        for filename, content in ((notify_file, NOTIFY_SOURCE), (rc_file, BASH_SOURCE)):
            with open(filename, "w", encoding="utf-8") as target: target.write(content)
            os.chmod(filename, 0o600)
        self.listener = socket.socket(socket.AF_UNIX, socket.SOCK_STREAM)
        self.socket_path = os.path.join(self.temp, "events.sock")
        self.listener.bind(self.socket_path)
        os.chmod(self.socket_path, 0o600)
        self.listener.listen(8)
        self.listener.settimeout(0.5)
        env = dict(os.environ, TERM="xterm-256color", COLORTERM="truecolor", PROJECT_GRID_ROOT=self.coding_root, PROJECT_GRID_PYTHON=sys.executable, PROJECT_GRID_NOTIFY_FILE=notify_file, PROJECT_GRID_SOCKET=self.socket_path, PROJECT_GRID_TOKEN=self.token, PROJECT_GRID_NOTIFY_COMMAND=json.dumps([sys.executable, notify_file, "notify"]))
        for key in ("NO_COLOR", "NODE_DISABLE_COLORS"): env.pop(key, None)
        if env.get("FORCE_COLOR") == "0": env.pop("FORCE_COLOR", None)
        child, master = pty.fork()
        if child == 0:
            os.chdir(self.coding_root)
            os.execve(bash, [bash, "--noprofile", "--rcfile", rc_file, "-i"], env)
        self.child, self.master = child, master
        self.resize(cols, rows)
        threading.Thread(target=self.events_loop, daemon=True).start()
        threading.Thread(target=self.terminal_loop, daemon=True).start()

    def events_loop(self):
        while not self.stopping:
            try: client, _ = self.listener.accept()
            except socket.timeout: continue
            except OSError: break
            with client:
                client.settimeout(2)
                data = b""
                try:
                    while len(data) <= 65536 and b"\n" not in data:
                        chunk = client.recv(4096)
                        if not chunk: break
                        data += chunk
                    event = json.loads(data)
                    if event.pop("token", None) != self.token: continue
                    codex_home = event.pop("codexHome", None)
                    if event.get("type") in ("shell-prompt", "codex-started"):
                        if isinstance(codex_home, str) and os.path.isabs(codex_home): self.codex_home = codex_home
                        if isinstance(event.get("cwd"), str) and os.path.isabs(event["cwd"]): self.coding_root = event["cwd"]
                    with self.sequence_lock:
                        self.sequence += 1
                        event.update(projectId=self.project_id, sessionKey=self.token, sequence=self.sequence)
                        self.emit({"type": "event", "event": event})
                except (OSError, ValueError): pass

    def terminal_loop(self):
        import select
        try:
            while not self.stopping:
                readable, _, _ = select.select([self.master], [], [], 0.5)
                if not readable: continue
                data = os.read(self.master, 32768)
                if not data: break
                self.emit({"type": "data", "data": base64.b64encode(data).decode("ascii")})
        except (OSError, ValueError): pass
        if not self.stopping:
            _, status = os.waitpid(self.child, 0)
            code = os.WEXITSTATUS(status) if os.WIFEXITED(status) else 128 + os.WTERMSIG(status)
            self.emit({"type": "exit", "code": code})

    def resize(self, cols, rows):
        if type(cols) is not int or type(rows) is not int or not 2 <= cols <= 500 or not 1 <= rows <= 250: raise ValueError("无效的终端尺寸。")
        if self.master is not None:
            import fcntl
            import termios
            fcntl.ioctl(self.master, termios.TIOCSWINSZ, struct.pack("HHHH", rows, cols, 0, 0))

    def input(self, encoded):
        data = base64.b64decode(encoded, validate=True)
        if len(data) > 1024 * 1024: raise ValueError("终端输入过大。")
        if self.master is not None:
            while data and not self.stopping:
                written = os.write(self.master, data)
                data = data[written:]

    def stop(self):
        if self.stopping: return
        self.stopping = True
        for identity in list(self.uploads): self.cancel_upload(identity)
        if self.master is not None:
            try: os.close(self.master)
            except OSError: pass
        if self.child:
            try: os.killpg(self.child, signal.SIGHUP)
            except OSError: pass
        if hasattr(self, "listener"): self.listener.close()
        if self.temp and os.path.dirname(os.path.realpath(self.temp)) == os.path.realpath(tempfile.gettempdir()) and os.path.basename(self.temp).startswith("project-grid-"):
            shutil.rmtree(self.temp, ignore_errors=True)

def main():
    output_lock = threading.Lock()
    def emit(message):
        with output_lock:
            sys.stdout.write(PREFIX + json.dumps(message, ensure_ascii=True, separators=(",", ":")) + "\n")
            sys.stdout.flush()
    worker = Worker(emit)
    pool = concurrent.futures.ThreadPoolExecutor(max_workers=4)
    input_pool = concurrent.futures.ThreadPoolExecutor(max_workers=1)
    def dispatch(message):
        identity = message.get("id")
        try:
            op = message["op"]
            if op == "directory": value = worker.directory(message.get("path", ""), message.get("offset", 0))
            elif op == "stat": value = worker.metadata(message["path"])
            elif op == "read": value = worker.read(message["path"], message["offset"], message["length"])
            elif op == "preview": value = worker.preview(message["path"], message.get("page", 0))
            elif op == "save-file": value = worker.save_file(message["path"], message.get("page", 0), message.get("revision"), message["data"])
            elif op == "resume-info": value = recent_session(worker.coding_root, worker.codex_home, message.get("threadId"))
            elif op == "codex-status": value = worker.codex_status(message.get("since"), message.get("threadId"))
            elif op == "create": value = worker.create(message.get("path", ""), message["name"], message["kind"], message.get("unique", False))
            elif op == "rename": value = worker.rename(message["path"], message["name"])
            elif op == "remove": value = worker.remove(message["path"])
            elif op == "upload-start": value = worker.start_upload(message.get("path", ""), message["name"], message["size"])
            elif op == "upload-chunk": value = worker.upload_chunk(message["transfer"], message["offset"], message["data"])
            elif op == "upload-finish": value = worker.finish_upload(message["transfer"])
            elif op == "upload-cancel": value = worker.cancel_upload(message["transfer"])
            else: raise ValueError("不支持的远程请求。")
            emit({"type": "response", "id": identity, "ok": True, "value": value})
        except Exception as error: emit({"type": "response", "id": identity, "ok": False, "error": str(error)[:1000]})
    def shutdown(*_):
        worker.stop()
        os._exit(0)
    for event in (signal.SIGTERM, signal.SIGHUP): signal.signal(event, shutdown)
    try:
        config = json.loads(sys.stdin.buffer.readline(MAX_MESSAGE + 1))
        info = worker.initialize(config)
        emit({"type": "ready", "info": info})
        worker.start_terminal(config.get("cols", 90), config.get("rows", 24))
        while not worker.stopping:
            line = sys.stdin.buffer.readline(MAX_MESSAGE + 1)
            if not line: break
            if len(line) > MAX_MESSAGE: raise ValueError("远程请求过大。")
            message = json.loads(line)
            op = message.get("op")
            if op == "shutdown": break
            if op == "resize": worker.resize(message["cols"], message["rows"])
            elif op == "input": input_pool.submit(worker.input, message["data"])
            else: pool.submit(dispatch, message)
    except Exception as error:
        emit({"type": "error", "error": str(error)[:1000]})
    finally:
        worker.stop()
        pool.shutdown(wait=False)
        input_pool.shutdown(wait=False)

if __name__ == "__main__": main()
