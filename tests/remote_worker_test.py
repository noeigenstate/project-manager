import base64
import importlib.util
import json
import os
import subprocess
from pathlib import Path
import tempfile
import unittest
import uuid
import time
from datetime import datetime, timezone

MODULE_PATH = Path(__file__).resolve().parents[1] / "integration" / "remote-worker.py"
spec = importlib.util.spec_from_file_location("remote_worker", MODULE_PATH)
remote = importlib.util.module_from_spec(spec)
spec.loader.exec_module(remote)


class RemoteFilesTest(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory(prefix="project-grid-worker-test-")
        self.root = Path(self.temp.name) / "project"
        self.root.mkdir()
        self.worker = remote.Worker(lambda _: None)
        self.worker.initialize({"path": str(self.root), "token": "test", "projectId": "test"})

    def tearDown(self):
        self.worker.stop()
        self.temp.cleanup()

    def test_git_reads_status_history_and_commit_paths_without_mutation(self):
        def git(*args):
            return subprocess.run(["git", "-C", str(self.root), *args], check=True, stdout=subprocess.PIPE, stderr=subprocess.PIPE).stdout
        self.assertFalse(self.worker.git("status")["repository"])
        git("init", "-b", "main")
        git("config", "user.name", "测试 User")
        git("config", "user.email", "test@example.invalid")
        git("config", "core.autocrlf", "false")
        self.assertEqual(self.worker.git("history", 0)["output"], "")
        (self.root / "sub").mkdir()
        (self.root / "sub/中文 文件.txt").write_text("base", encoding="utf-8")
        (self.root / "outside.txt").write_text("outside", encoding="utf-8")
        git("add", "."); git("commit", "-m", "第一次提交")
        commit = git("rev-parse", "HEAD").decode().strip()
        (self.root / "sub/中文 文件.txt").write_text("changed", encoding="utf-8")
        (self.root / "新建.txt").write_text("new", encoding="utf-8")
        before = (self.root / ".git/index").read_bytes()
        status = self.worker.git("status")
        self.assertIn("sub/中文 文件.txt\0", status["output"])
        self.assertIn("? 新建.txt\0", status["output"])
        self.assertEqual((self.root / ".git/index").read_bytes(), before)
        self.assertIn(commit + "\0", self.worker.git("history", 0)["output"])
        self.assertIn("第一次提交", self.worker.git("history", 0)["output"])
        self.assertIn("sub/中文 文件.txt\0", self.worker.git("files", commit)["output"])
        self.worker.root = str(self.root / "sub")
        git("config", "diff.relative", "true")
        self.assertEqual(self.worker.git("status")["prefix"], "sub/")
        self.assertNotIn("outside.txt", self.worker.git("files", commit)["output"])
        with self.assertRaises(ValueError): self.worker.git("files", "--output=outside")
        with self.assertRaises(ValueError): self.worker.git("history", -1)

    def test_signed_history_ignores_user_signature_display_setting(self):
        def git(*args):
            return subprocess.run(["git", "-C", str(self.root), *args], check=True, stdout=subprocess.PIPE, stderr=subprocess.PIPE).stdout.decode().strip()
        git("init", "-b", "main")
        (self.root / "signed.txt").write_text("signed change", encoding="utf-8")
        git("add", ".")
        tree = git("write-tree")
        raw = f"tree {tree}\nauthor Test <test@example.invalid> 1700000000 +0000\ncommitter Test <test@example.invalid> 1700000000 +0000\ngpgsig -----BEGIN PGP SIGNATURE-----\n invalid-test-signature\n -----END PGP SIGNATURE-----\n\nsigned fixture\n"
        obj = Path(self.temp.name) / "signed-commit"
        obj.write_bytes(raw.encode())
        commit = git("hash-object", "-t", "commit", "-w", str(obj))
        git("update-ref", "refs/heads/main", commit)
        git("config", "log.showSignature", "true")
        fields = self.worker.git("history", 0)["output"].split("\0")
        self.assertEqual(fields[0], commit)
        self.assertEqual(fields[5], "signed fixture")
        self.assertEqual(self.worker.git("files", commit)["output"], "A\0signed.txt\0")

    def test_directory_and_media_reads(self):
        (self.root / "src").mkdir()
        (self.root / "中文.txt").write_text("中文文件", encoding="utf-8")
        png = b"\x89PNG\r\n\x1a\n" + b"\0" * 64
        (self.root / "image-without-extension").write_bytes(png)
        (self.root / "page.html").write_text("<h1>Remote page</h1>", encoding="utf-8")
        (self.root / "README.md").write_text("# 远程 Markdown\n\n**正文**", encoding="utf-8")
        (self.root / "clip.mp4").write_bytes(b"video fixture")
        listing = self.worker.directory("", 0)
        self.assertEqual(listing["entries"][0]["name"], "src")
        self.assertEqual(self.worker.preview("中文.txt", 0)["content"], "中文文件")
        self.assertEqual(self.worker.preview("image-without-extension", 0)["kind"], "image")
        self.assertEqual(self.worker.preview("page.html", 0)["kind"], "html")
        self.assertEqual(self.worker.preview("README.md", 0)["kind"], "markdown")
        self.assertEqual(self.worker.preview("clip.mp4", 0)["kind"], "video")
        self.assertEqual(base64.b64decode(self.worker.read("中文.txt", 0, 6)), "中文".encode())

    def test_parent_activity_ignores_child_and_stale_completion(self):
        home = Path(self.temp.name) / "codex"
        sessions = home / "sessions"
        sessions.mkdir(parents=True)
        parent, child = str(uuid.uuid4()), str(uuid.uuid4())
        def event(kind, turn):
            return json.dumps({"type": "event_msg", "timestamp": datetime.now(timezone.utc).isoformat(), "payload": {"type": kind, "turn_id": turn}}) + "\n"
        filename = sessions / ("rollout-" + parent + ".jsonl")
        filename.write_text(json.dumps({"type": "session_meta", "payload": {"id": parent, "cwd": str(self.root), "source": "cli"}}) + "\n" + event("task_started", "parent"), encoding="utf-8")
        (sessions / ("rollout-" + child + ".jsonl")).write_text(json.dumps({"type": "session_meta", "payload": {"id": child, "cwd": str(self.root), "source": {"subagent": "parent"}}}) + "\n" + event("task_complete", "child"), encoding="utf-8")
        reader = remote.CodexActivityReader(str(self.root), str(home), time.time() * 1000)
        self.assertEqual(reader.read()["state"], "working")
        with filename.open("a", encoding="utf-8") as output: output.write(event("task_complete", "old"))
        self.assertEqual(reader.read()["state"], "working")
        completion = event("task_complete", "parent")
        with filename.open("a", encoding="utf-8") as output: output.write(completion[:-1])
        self.assertEqual(reader.read()["state"], "working")
        with filename.open("a", encoding="utf-8") as output: output.write("\n")
        self.assertEqual(reader.read()["state"], "complete")

    def test_large_unicode_pages_are_lossless(self):
        content = "A" * (remote.PAGE_BYTES - 1) + "中文🙂\ufeff内容\n" * 40000
        for encoding, bom in (("utf-8", b""), ("utf-16le", b"\xff\xfe"), ("utf-16be", b"\xfe\xff")):
            (self.root / "large.txt").write_bytes(bom + content.encode(encoding))
            first = self.worker.preview("large.txt", 0)
            pages = [self.worker.preview("large.txt", index) for index in range(first["page"]["count"])]
            self.assertEqual("".join(page["content"] for page in pages), content)
            for left, right in zip(pages, pages[1:]): self.assertEqual(left["page"]["byteEnd"], right["page"]["byteStart"])

    def test_page_edits_preserve_unicode_encoding_and_reject_conflicts(self):
        for encoding, bom in (("utf-8", b"\xef\xbb\xbf"), ("utf-16le", b"\xff\xfe"), ("utf-16be", b"\xfe\xff")):
            original = bom + ("中文🙂 line\r\n" * 70000).encode(encoding)
            filename = self.root / "editable.txt"
            filename.write_bytes(original)
            preview = self.worker.preview("editable.txt", 1)
            replacement = "edited\n第二行🙂"
            payload = base64.b64encode(replacement.encode("utf-8")).decode("ascii")
            self.worker.save_file("editable.txt", 1, preview["revision"], payload)
            expected = original[:preview["page"]["byteStart"]] + replacement.replace("\n", "\r\n").encode(encoding) + original[preview["page"]["byteEnd"]:]
            self.assertEqual(filename.read_bytes(), expected)
            current = self.worker.preview("editable.txt", 0)
            filename.write_text("external content", encoding="utf-8")
            with self.assertRaisesRegex(ValueError, "其他程序修改"):
                self.worker.save_file("editable.txt", 0, current["revision"], payload)
            self.assertEqual(filename.read_text(encoding="utf-8"), "external content")

    def test_traversal_and_non_files_are_rejected(self):
        for filename in ("../outside", "/etc/passwd", "bad\0path", "a\\b"):
            with self.assertRaises(ValueError): self.worker.resolve(filename)
        with self.assertRaises(ValueError): self.worker.preview("", 0)
        with self.assertRaises(ValueError): self.worker.read("file", 0, remote.MAX_READ + 1)
        if os.name == "posix":
            outside = Path(self.temp.name) / "outside"
            outside.write_text("private", encoding="utf-8")
            (self.root / "escape").symlink_to(outside)
            with self.assertRaises(ValueError): self.worker.preview("escape", 0)

    def test_recovery_only_reads_the_matching_interactive_session(self):
        home = Path(self.temp.name) / "codex"
        sessions = home / "sessions"
        sessions.mkdir(parents=True)
        identity = str(uuid.uuid4())
        records = [
            {"type": "session_meta", "payload": {"id": identity, "cwd": str(self.root), "source": "cli"}},
            {"type": "event_msg", "payload": {"type": "task_started"}},
            {"type": "event_msg", "payload": {"type": "turn_aborted"}},
        ]
        filename = sessions / "rollout-test.jsonl"
        filename.write_text("\n".join(json.dumps(record) for record in records), encoding="utf-8")
        result = remote.recent_session(os.path.realpath(self.root), str(home))
        self.assertEqual(result["id"], identity)
        self.assertEqual(result["state"], "interrupted")
        with filename.open("a", encoding="utf-8") as output: output.write('\n{"type":"event_msg","payload":{"type":"task_complete"}}\n')
        self.assertEqual(remote.recent_session(os.path.realpath(self.root), str(home))["state"], "complete")

    def test_file_mutations_and_upload_do_not_overwrite_existing_data(self):
        self.worker.create("", "新目录", "directory")
        self.worker.create("新目录", "first.txt", "file")
        original = self.root / "新目录" / "first.txt"
        original.write_text("keep", encoding="utf-8")
        with self.assertRaises(FileExistsError): self.worker.create("新目录", "first.txt", "file")
        self.worker.rename("新目录/first.txt", "renamed.txt")
        self.worker.create("新目录", "exists.txt", "file")
        with self.assertRaises(ValueError): self.worker.rename("新目录/renamed.txt", "exists.txt")
        data = b"upload fixture" * 50000
        transfer = self.worker.start_upload("新目录", "renamed.txt", len(data))["id"]
        for offset in range(0, len(data), remote.MAX_READ): self.worker.upload_chunk(transfer, offset, base64.b64encode(data[offset:offset + remote.MAX_READ]).decode())
        result = self.worker.finish_upload(transfer)
        self.assertEqual((self.root / result["path"]).read_bytes(), data)
        self.assertEqual((self.root / "新目录/renamed.txt").read_text(), "keep")
        canceled = self.worker.start_upload("新目录", "cancel.txt", 9)["id"]
        with self.assertRaises(ValueError): self.worker.finish_upload(canceled)
        self.worker.cancel_upload(canceled)
        self.assertFalse((self.root / "新目录/cancel.txt").exists())
        self.assertFalse(list((self.root / "新目录").glob(".project-grid-upload-*")))
        self.worker.remove(result["path"])
        self.assertFalse((self.root / result["path"]).exists())
        for relative in ("", "../outside", "/outside"):
            with self.assertRaises(ValueError): self.worker.remove(relative)

    def test_deleting_remote_link_preserves_external_target(self):
        if os.name != "posix": self.skipTest("POSIX symlink behavior")
        outside = Path(self.temp.name) / "outside"
        outside.mkdir(); (outside / "keep.txt").write_text("keep")
        (self.root / "link").symlink_to(outside, target_is_directory=True)
        with self.assertRaises(ValueError): self.worker.create("link", "escape.txt", "file")
        self.worker.remove("link")
        self.assertEqual((outside / "keep.txt").read_text(), "keep")


if __name__ == "__main__": unittest.main()
