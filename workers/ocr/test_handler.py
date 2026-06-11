"""Package 2 (keystone plan) tests: native text-readers in the OCR start handler.

Covers: .txt decode + the /pages post shape; .docx extraction (fixture built with the LOCAL
python-docx — see conftest.py); the legacy-.doc best-effort ladder including the OLE flag
note; extension-not-contentType keying; and the guards around the native branch (hasPages
skip, intake/ prefix untouched, oversize flag, pdf still rides Textract).

No network, no AWS: _resolve_document / _post_pages_to_api / _post_failed_read_attempt /
s3 / textract are all monkeypatched.
"""
import io

import pytest

import handler  # workers/ocr/handler.py — sys.path arranged by conftest.py


def _event(key: str, bucket: str = "phi-bucket") -> dict:
    """EventBridge ObjectCreated shape — note there is NO contentType anywhere in it: the
    native branch can only key on the s3-key extension (the intakes.ts effectiveContentType
    lesson; the declared upload contentType is application/octet-stream anyway)."""
    return {"detail": {"bucket": {"name": bucket}, "object": {"key": key}}}


class _S3Stub:
    def __init__(self, data: bytes):
        self.data = data
        self.calls: list[tuple[str, str]] = []

    def get_object(self, Bucket: str, Key: str) -> dict:  # noqa: N803 — boto3 casing
        self.calls.append((Bucket, Key))
        return {"Body": io.BytesIO(self.data)}


class _TextractBomb:
    """Any Textract call on a native-read path is a test failure."""

    def __getattr__(self, name: str):
        raise AssertionError(f"textract.{name} must not be called on the native-read path")


class _TextractStub:
    def __init__(self):
        self.calls: list[dict] = []

    def start_document_text_detection(self, **kwargs) -> dict:
        self.calls.append(kwargs)
        return {"JobId": "JOB-1"}


@pytest.fixture
def rig(monkeypatch):
    """start_handler wired for a resolvable cases/ document with no pages; records all posts."""
    state = {
        "pages": [],
        "failed": [],
        "doc": {"documentId": "DOC-1", "hasPages": False},
    }
    monkeypatch.setattr(handler, "_resolve_document", lambda key: state["doc"])
    monkeypatch.setattr(
        handler, "_post_pages_to_api",
        lambda doc_id, pages, count: state["pages"].append((doc_id, pages, count)),
    )
    monkeypatch.setattr(
        handler, "_post_failed_read_attempt",
        lambda doc_id, status, job_id, error_message=None: state["failed"].append((doc_id, status, job_id, error_message)),
    )
    monkeypatch.setattr(handler, "textract", _TextractBomb())

    def with_bytes(data: bytes) -> _S3Stub:
        stub = _S3Stub(data)
        monkeypatch.setattr(handler, "s3", stub)
        return stub

    state["with_bytes"] = with_bytes
    return state


def _docx_bytes() -> bytes:
    """Build the .docx fixture with the LOCAL python-docx (paragraph, table, paragraph)."""
    import docx as docx_pkg

    d = docx_pkg.Document()
    d.add_paragraph("Chief complaint: chronic lumbar pain.")
    table = d.add_table(rows=2, cols=2)
    table.rows[0].cells[0].text = "Medication"
    table.rows[0].cells[1].text = "Dose"
    table.rows[1].cells[0].text = "Meloxicam"
    table.rows[1].cells[1].text = "15 mg"
    d.add_paragraph("Assessment: degenerative disc disease.")
    buf = io.BytesIO()
    d.save(buf)
    return buf.getvalue()


# ===== .txt =====

def test_txt_posts_single_page_native_text(rig):
    content = "Sleep study: AHI 36.4 events/hour. Severe OSA.\nCPAP initiated."
    s3 = rig["with_bytes"](content.encode("utf-8"))
    result = handler.start_handler(_event("cases/C1/u1-records.txt"), None)

    assert result["native"] == "txt"
    assert result["method"] == "native_text"
    assert result["started"] == []
    assert rig["failed"] == []
    [(doc_id, pages, count)] = rig["pages"]
    assert doc_id == "DOC-1"
    assert count == 1
    assert pages == [{"pageNumber": 1, "text": content, "confidence": None}]
    assert s3.calls == [("phi-bucket", "cases/C1/u1-records.txt")]


def test_txt_extension_keying_is_case_insensitive(rig):
    rig["with_bytes"](b"VA rating decision narrative, service connection granted.")
    result = handler.start_handler(_event("cases/C1/u2-NOTES.TXT"), None)
    assert result["method"] == "native_text"
    assert len(rig["pages"]) == 1


def test_txt_utf8_bom_is_stripped(rig):
    rig["with_bytes"](b"\xef\xbb\xbf" + "Tinnitus reported constant and bilateral.".encode("utf-8"))
    handler.start_handler(_event("cases/C1/u3-note.txt"), None)
    [(_, pages, _)] = rig["pages"]
    assert pages[0]["text"].startswith("Tinnitus")  # no ﻿ residue


def test_txt_utf16_bom_decodes(rig):
    content = "PTSD screening résumé — Notepad saves UTF-16."
    rig["with_bytes"](content.encode("utf-16"))  # BOM-prefixed UTF-16 LE
    handler.start_handler(_event("cases/C1/u4-note.txt"), None)
    [(_, pages, _)] = rig["pages"]
    assert pages[0]["text"] == content


def test_txt_form_feed_splits_pages(rig):
    rig["with_bytes"]("Page one body.\fPage two body.".encode("utf-8"))
    result = handler.start_handler(_event("cases/C1/u5-multi.txt"), None)
    [(_, pages, count)] = rig["pages"]
    assert result["pages"] == 2
    assert count == 2
    assert [p["pageNumber"] for p in pages] == [1, 2]
    assert pages[0]["text"] == "Page one body."
    assert pages[1]["text"] == "Page two body."


def test_txt_empty_file_still_posts_a_page_for_the_classifier(rig):
    rig["with_bytes"](b"")
    handler.start_handler(_event("cases/C1/u6-empty.txt"), None)
    [(_, pages, _)] = rig["pages"]
    assert pages == [{"pageNumber": 1, "text": "", "confidence": None}]
    assert rig["failed"] == []  # word-count gating happens server-side in the SAME /pages path


# ===== .docx =====

def test_docx_extracts_paragraphs_and_tables_in_document_order(rig):
    rig["with_bytes"](_docx_bytes())
    result = handler.start_handler(_event("cases/C1/u7-chart.docx"), None)

    assert result["method"] == "native_docx"
    [(_, pages, _)] = rig["pages"]
    text = pages[0]["text"]
    i_para1 = text.index("Chief complaint: chronic lumbar pain.")
    i_table = text.index("Medication | Dose")
    i_row2 = text.index("Meloxicam | 15 mg")
    i_para2 = text.index("Assessment: degenerative disc disease.")
    assert i_para1 < i_table < i_row2 < i_para2


def test_docx_corrupt_bytes_flag_with_actionable_note(rig):
    rig["with_bytes"](b"this is not a zip archive at all")
    result = handler.start_handler(_event("cases/C1/u8-broken.docx"), None)

    assert result["flaggedForRn"] is True
    assert rig["pages"] == []
    [(doc_id, status, job_id, note)] = rig["failed"]
    assert (doc_id, status, job_id) == ("DOC-1", "NATIVE_UNREADABLE", "native-read")
    assert ".docx could not be parsed" in note
    assert "summarize manually" in note


# ===== legacy .doc ladder =====

def test_doc_mislabeled_docx_reads_via_python_docx(rig):
    rig["with_bytes"](_docx_bytes())  # a real .docx wearing a .doc name
    result = handler.start_handler(_event("cases/C1/u9-old.doc"), None)
    assert result["method"] == "native_docx"
    [(_, pages, _)] = rig["pages"]
    assert "Chief complaint: chronic lumbar pain." in pages[0]["text"]


def test_doc_rtf_header_strips_to_text(rig):
    rtf = (
        b"{\\rtf1\\ansi\\deff0{\\fonttbl{\\f0 Calibri;}}\\f0\\fs22 "
        b"Veteran reports knee pain since 2009.\\par Gait antalgic on exam.\\par}"
    )
    rig["with_bytes"](rtf)
    result = handler.start_handler(_event("cases/C1/u10-legacy.doc"), None)
    assert result["method"] == "native_text"
    [(_, pages, _)] = rig["pages"]
    assert "Veteran reports knee pain since 2009." in pages[0]["text"]
    assert "Gait antalgic on exam." in pages[0]["text"]
    assert "\\rtf" not in pages[0]["text"]


def test_doc_mostly_printable_bytes_read_as_plain_text(rig):
    body = b"Progress note: veteran ambulates without assistive device.\r\nGait steady.\r\n" * 3
    rig["with_bytes"](body)
    result = handler.start_handler(_event("cases/C1/u11-renamed.doc"), None)
    assert result["method"] == "native_text"
    [(_, pages, _)] = rig["pages"]
    assert "ambulates without assistive device" in pages[0]["text"]


def test_doc_genuine_ole_flags_with_actionable_legacy_note(rig):
    ole = handler._OLE_MAGIC + bytes([0, 1, 2, 3]) * 128
    rig["with_bytes"](ole)
    result = handler.start_handler(_event("cases/C1/u12-word97.doc"), None)

    assert result["flaggedForRn"] is True
    assert rig["pages"] == []
    [(doc_id, status, job_id, note)] = rig["failed"]
    assert status == "LEGACY_DOC"
    assert job_id == "native-read"
    assert "legacy .doc format" in note
    assert "PDF/docx" in note
    assert "summarize manually" in note


def test_doc_binary_garbage_flags_unreadable(rig):
    rig["with_bytes"](bytes(range(256)) * 8)
    result = handler.start_handler(_event("cases/C1/u13-mystery.doc"), None)
    assert result["flaggedForRn"] is True
    [(_, status, _, note)] = rig["failed"]
    assert status == "NATIVE_UNREADABLE"
    assert "unreadable .doc" in note


# ===== guards around the native branch =====

def test_pdf_still_goes_to_textract(rig, monkeypatch):
    stub = _TextractStub()
    monkeypatch.setattr(handler, "textract", stub)
    monkeypatch.setenv("COMPLETION_SNS_TOPIC_ARN", "arn:aws:sns:us-east-1:0:topic")
    monkeypatch.setenv("TEXTRACT_SNS_ROLE_ARN", "arn:aws:iam::0:role/textract")

    result = handler.start_handler(_event("cases/C1/u14-records.pdf"), None)

    assert result == {"started": [{"documentId": "DOC-1", "jobId": "JOB-1"}]}
    assert rig["pages"] == [] and rig["failed"] == []
    [call] = stub.calls
    assert call["DocumentLocation"] == {"S3Object": {"Bucket": "phi-bucket", "Name": "cases/C1/u14-records.pdf"}}
    assert call["JobTag"] == "DOC-1"


def test_has_pages_guard_runs_before_native_read(rig):
    rig["doc"]["hasPages"] = True
    s3 = rig["with_bytes"](b"already read")
    result = handler.start_handler(_event("cases/C1/u15-rerun.txt"), None)
    assert result["skipped"] == "already_has_pages"
    assert rig["pages"] == [] and rig["failed"] == []
    assert s3.calls == []


def test_intake_prefix_is_untouched_by_the_native_branch(rig, monkeypatch):
    sentinel = {"started": [{"intakeS3Key": "intake/abc.txt", "jobId": "J", "jobTag": "t"}]}
    called = []
    monkeypatch.setattr(handler, "_start_intake_ocr", lambda bucket, key: (called.append((bucket, key)), sentinel)[1])
    s3 = rig["with_bytes"](b"should never be fetched")

    result = handler.start_handler(_event("intake/abc.txt"), None)

    assert result is sentinel
    assert called == [("phi-bucket", "intake/abc.txt")]
    assert s3.calls == [] and rig["pages"] == []


def test_oversize_native_file_flags_for_rn(rig, monkeypatch):
    monkeypatch.setattr(handler, "MAX_OCR_BYTES", 16)
    rig["with_bytes"](b"x" * 64)
    result = handler.start_handler(_event("cases/C1/u16-huge.txt"), None)
    assert result["flaggedForRn"] is True
    [(_, status, _, note)] = rig["failed"]
    assert status == "NATIVE_TOO_LARGE"
    assert "summarize manually" in note


def test_extensionless_key_does_not_native_read(rig, monkeypatch):
    stub = _TextractStub()
    monkeypatch.setattr(handler, "textract", stub)
    monkeypatch.setenv("COMPLETION_SNS_TOPIC_ARN", "arn:aws:sns:us-east-1:0:topic")
    monkeypatch.setenv("TEXTRACT_SNS_ROLE_ARN", "arn:aws:iam::0:role/textract")

    handler.start_handler(_event("cases/C1/u17-no-extension"), None)

    assert rig["pages"] == []
    assert len(stub.calls) == 1  # falls through to Textract, as before


# ===== unit coverage of the page splitter =====

def test_build_native_pages_chunks_oversize_text(monkeypatch):
    monkeypatch.setattr(handler, "_MAX_PAGE_CHARS", 10)
    pages = handler._build_native_pages("abcdefghijKLMNOPQRSTuv")
    assert [p["text"] for p in pages] == ["abcdefghij", "KLMNOPQRST", "uv"]
    assert [p["pageNumber"] for p in pages] == [1, 2, 3]


# ===== Package 4a: orphan-race fix — raise-for-retry on unresolvable cases/ keys =====
# The Document row lands a beat AFTER the S3 object (recordDocument race), so the by-s3-key
# lookup can 404 on a perfectly good upload. Returning success silently dropped the file;
# raising lets the Lambda async retry (retryAttempts: 2) re-resolve once the row exists.
# HARD SCOPE GUARD (the highest-risk regression per the plan): ONLY cases/ raises —
# intake/ has no Document by design and must keep returning cleanly.

def test_unresolvable_cases_key_raises_for_async_retry(rig, monkeypatch):
    rig["doc"] = None  # _resolve_document → None: the 404/no-row outcome
    monkeypatch.setattr(handler, "_resolve_document", lambda key: rig["doc"])

    with pytest.raises(RuntimeError, match=r"no resolvable document .*cases/C1/u18-race\.pdf"):
        handler.start_handler(_event("cases/C1/u18-race.pdf"), None)

    # Nothing was posted or flagged — the event must surface to Lambda for the async retry,
    # not get half-processed first.
    assert rig["pages"] == [] and rig["failed"] == []


def test_unresolvable_intake_key_does_not_raise(rig, monkeypatch):
    """Regression guard for the scope mistake: intake/ objects legitimately have no Document
    (parse-at-intake caches to IntakePage) — the orphan-race raise must never reach them. Even
    when the intake ocr-start record fails (the intake no-doc analog), the handler returns
    cleanly so the file falls through to assign-time OCR."""
    rig["doc"] = None
    resolve_calls = []
    monkeypatch.setattr(handler, "_resolve_document", lambda key: (resolve_calls.append(key), rig["doc"])[1])

    def _record_fails(intake_s3_key, job_tag):
        raise RuntimeError("intake ocr-start record failed: 500")

    monkeypatch.setattr(handler, "_post_intake_ocr_start", _record_fails)

    result = handler.start_handler(_event("intake/I1/upload.pdf"), None)  # must NOT raise

    assert result == {"started": []}
    assert resolve_calls == []  # intake/ branches off BEFORE the by-s3-key lookup
    assert rig["pages"] == [] and rig["failed"] == []


def test_unresolvable_non_cases_non_intake_key_keeps_skip_behavior(rig, monkeypatch):
    """A key under any OTHER prefix (defensive: the rule only matches cases/ + intake/, but a
    manual test-invoke or future rule edit shouldn't retry-loop) keeps the old skip-with-success."""
    rig["doc"] = None
    monkeypatch.setattr(handler, "_resolve_document", lambda key: rig["doc"])

    result = handler.start_handler(_event("scratch/manual-test.pdf"), None)  # must NOT raise

    assert result == {"started": []}
    assert rig["pages"] == [] and rig["failed"] == []


def test_event_with_no_bucket_or_key_still_returns_success(rig):
    """The malformed-event early-return sits ABOVE the raise and must keep returning success —
    retrying a bucket-less event can never resolve anything."""
    assert handler.start_handler({"detail": {}}, None) == {"started": []}


def test_resolved_cases_key_is_unaffected_by_the_orphan_raise(rig, monkeypatch):
    """A resolvable Document rides the exact pre-4a path: native .txt reads post pages, no raise."""
    rig["with_bytes"](b"Resolved fine: lumbar strain, chronic.")
    result = handler.start_handler(_event("cases/C1/u19-resolved.txt"), None)
    assert result["started"] == []
    assert result["native"] == "txt"
    assert len(rig["pages"]) == 1 and rig["failed"] == []
