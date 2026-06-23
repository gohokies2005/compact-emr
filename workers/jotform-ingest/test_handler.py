"""
Local-invoke test for the jotform-ingest worker — the Travis Spring intake-loss class.

There was no test harness for this Python worker before (the dir held only handler.py). This is a
minimal, dependency-light harness: it monkeypatches the three external boundaries the handler touches
  - _jotform_get        (the HIPAA submission/form fetch)
  - urllib.request.urlopen (the per-file DOWNLOAD inside _stream_to_s3)
  - the module-level boto3 s3 client (upload_fileobj)
  - _patch_intake       (the API callback — captured, not sent)
so the per-file isolation + streaming + cap logic runs for real against a synthetic multi-file payload.

THE CORE TEST (test_one_oversized_file_does_not_sink_the_submission) is the RED->GREEN proof:
  BEFORE the fix: one >cap file raises out of the loop -> the whole submission PATCHes status=failed
                  (the small files never ingest -> the intake vanishes silently).
  AFTER  the fix: the oversized file is SKIPPED + flagged, the loop CONTINUES, the small file ingests,
                  and the intake reaches status=ready.

Run:  python -m pytest workers/jotform-ingest/test_handler.py -v
"""

import io
import json
import os

import pytest

# Env the handler reads at call time (it reads lazily inside helpers, so set before import is enough).
os.environ.setdefault("COMPACT_EMR_API_URL", "https://api.test.local")
os.environ.setdefault("INTERNAL_WORKER_TOKEN", "test-token")
os.environ.setdefault("RECORDS_BUCKET", "test-phi-bucket")
os.environ.setdefault("JOTFORM_API_KEY", "test-jotform-key")

import handler  # noqa: E402  (env must be set first)


# A small cap so we don't have to allocate hundreds of MB to trip it in a unit test.
TEST_CAP = 1 * 1024 * 1024  # 1 MB

SMALL_FILE_URL = "https://hipaa-files.jotform.test/abc/Spring_DD214.pdf"
BIG_FILE_URL = "https://hipaa-files.jotform.test/abc/Spring_VAClaim_Acne_Attachment1.pdf"

SMALL_BYTES = b"%PDF-1.4 small file" + b"x" * 1024          # ~1 KB
BIG_BYTES = b"%PDF-1.4 big file" + b"y" * (2 * 1024 * 1024)  # ~2 MB > TEST_CAP


class _FakeHttpResponse(io.BytesIO):
    """Stand-in for the urllib response: a context manager whose .read(amt) streams bytes."""

    def __enter__(self):  # noqa: D401
        return self

    def __exit__(self, *_a):
        self.close()
        return False


def _make_urlopen(file_bytes_by_url):
    def _fake_urlopen(req, timeout=None):  # noqa: ARG001
        url = req.full_url if hasattr(req, "full_url") else req
        # The handler url-encodes the path; match on the basename so encoding doesn't break the lookup.
        for key, data in file_bytes_by_url.items():
            if key.rsplit("/", 1)[-1] in url:
                return _FakeHttpResponse(data)
        raise AssertionError(f"unexpected download URL: {url}")
    return _fake_urlopen


class _FakeS3:
    """Captures upload_fileobj calls; honours the cap by actually draining the fileobj (so the
    _CappedReader's mid-stream cap check fires exactly as it would against real S3)."""

    def __init__(self):
        self.objects = {}

    def upload_fileobj(self, fileobj, bucket, key, ExtraArgs=None, Config=None):  # noqa: N803
        # Drain the reader in chunks like s3transfer would — this is what trips the cap mid-stream.
        buf = bytearray()
        while True:
            chunk = fileobj.read(64 * 1024)
            if not chunk:
                break
            buf += chunk
        self.objects[(bucket, key)] = bytes(buf)


@pytest.fixture
def wired(monkeypatch):
    """Wire the handler's external boundaries to in-memory fakes + a small test cap."""
    fake_s3 = _FakeS3()
    monkeypatch.setattr(handler, "s3", fake_s3)
    monkeypatch.setattr(handler, "MAX_FILE_BYTES", TEST_CAP)

    captured = {"patches": []}

    def _fake_patch(intake_id, body):
        captured["patches"].append({"intakeId": intake_id, "body": body})

    monkeypatch.setattr(handler, "_patch_intake", _fake_patch)

    # _jotform_get returns the submission (with file-upload answers) then the form (title).
    def _fake_jotform_get(path):
        if path.startswith("submission/"):
            return {
                "content": {
                    "form_id": "261206355633049",
                    "created_at": "2026-06-20 14:03:11",
                    "answers": {
                        "1": {"type": "control_fullname", "answer": {"first": "Travis", "last": "Spring"}},
                        "2": {"type": "control_email", "answer": "travis@example.test"},
                        "3": {"type": "control_fileupload", "answer": [SMALL_FILE_URL, BIG_FILE_URL]},
                    },
                }
            }
        if path.startswith("form/"):
            return {"content": {"title": "VA Claim — Skin / Acne (Stage 2)"}}
        raise AssertionError(f"unexpected jotform path: {path}")

    monkeypatch.setattr(handler, "_jotform_get", _fake_jotform_get)
    monkeypatch.setattr(
        handler.urllib.request, "urlopen",
        _make_urlopen({SMALL_FILE_URL: SMALL_BYTES, BIG_FILE_URL: BIG_BYTES}),
    )
    return fake_s3, captured


def _run_one(intake_id="e57da667-test", submission_id="6577952507252126079"):
    event = {"Records": [{"body": json.dumps({"intakeId": intake_id, "submissionId": submission_id})}]}
    return handler.handler(event)


def test_one_oversized_file_does_not_sink_the_submission(wired):
    """RED->GREEN core: one >cap file is skipped-not-fatal; the small file ingests; intake -> ready."""
    fake_s3, captured = wired
    _run_one()

    assert len(captured["patches"]) == 1, "exactly one intake PATCH expected"
    body = captured["patches"][0]["body"]

    # GREEN assertion #1 — the submission is USABLE, not failed.
    assert body["status"] == "ready", f"expected ready, got {body['status']!r} (one bad file sank it?)"

    manifest = body["fileManifest"]
    ingested = [m for m in manifest if m.get("s3Key")]
    skipped = [m for m in manifest if m.get("skipped")]

    # GREEN #2 — the small file actually landed in S3.
    assert len(ingested) == 1, f"small file should have ingested; manifest={manifest}"
    assert ("test-phi-bucket", ingested[0]["s3Key"]) in fake_s3.objects
    assert fake_s3.objects[("test-phi-bucket", ingested[0]["s3Key"])] == SMALL_BYTES

    # GREEN #3 — the oversized file is FLAGGED (visible to the RN), with NO s3Key (inert in assign).
    assert len(skipped) == 1, f"oversized file should be flagged-skipped; manifest={manifest}"
    assert "s3Key" not in skipped[0]
    assert "MB cap" in skipped[0]["skipReason"]
    assert "Acne_Attachment1" in skipped[0]["name"]


def test_all_files_good_still_works(wired):
    """Regression guard: a clean multi-file submission still ingests every file as ready."""
    fake_s3, captured = wired
    # Re-wire both files small.
    import handler as h
    h.urllib.request.urlopen = _make_urlopen({SMALL_FILE_URL: SMALL_BYTES, BIG_FILE_URL: SMALL_BYTES})
    _run_one()
    body = captured["patches"][0]["body"]
    assert body["status"] == "ready"
    ingested = [m for m in body["fileManifest"] if m.get("s3Key")]
    assert len(ingested) == 2
    assert all(not m.get("skipped") for m in body["fileManifest"])


def test_streaming_does_not_buffer_whole_file_in_ram(wired):
    """The cap is enforced MID-stream (CappedReader), proving we stream rather than read() into RAM."""
    fake_s3, _ = wired
    reader = handler._CappedReader(io.BytesIO(b"z" * (TEST_CAP + 10)), TEST_CAP)
    with pytest.raises(handler._FileTooLargeError):
        # First big read exceeds the cap -> raises before the whole body is accepted.
        reader.read(TEST_CAP + 10)
