import base64
import importlib.util
import json
import os
from pathlib import Path
import tempfile
import unittest
import uuid

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

    def test_directory_and_media_reads(self):
        (self.root / "src").mkdir()
        (self.root / "中文.txt").write_text("中文文件", encoding="utf-8")
        png = b"\x89PNG\r\n\x1a\n" + b"\0" * 64
        (self.root / "image-without-extension").write_bytes(png)
        (self.root / "page.html").write_text("<h1>Remote page</h1>", encoding="utf-8")
        (self.root / "clip.mp4").write_bytes(b"video fixture")
        listing = self.worker.directory("", 0)
        self.assertEqual(listing["entries"][0]["name"], "src")
        self.assertEqual(self.worker.preview("中文.txt", 0)["content"], "中文文件")
        self.assertEqual(self.worker.preview("image-without-extension", 0)["kind"], "image")
        self.assertEqual(self.worker.preview("page.html", 0)["kind"], "html")
        self.assertEqual(self.worker.preview("clip.mp4", 0)["kind"], "video")
        self.assertEqual(base64.b64decode(self.worker.read("中文.txt", 0, 6)), "中文".encode())

    def test_large_unicode_pages_are_lossless(self):
        content = "A" * (remote.PAGE_BYTES - 1) + "中文🙂\ufeff内容\n" * 40000
        for encoding, bom in (("utf-8", b""), ("utf-16le", b"\xff\xfe"), ("utf-16be", b"\xfe\xff")):
            (self.root / "large.txt").write_bytes(bom + content.encode(encoding))
            first = self.worker.preview("large.txt", 0)
            pages = [self.worker.preview("large.txt", index) for index in range(first["page"]["count"])]
            self.assertEqual("".join(page["content"] for page in pages), content)
            for left, right in zip(pages, pages[1:]): self.assertEqual(left["page"]["byteEnd"], right["page"]["byteStart"])

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
