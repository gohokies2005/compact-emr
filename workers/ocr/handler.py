"""
Phase 7B-revised Build 3: OCR worker — Textract async extraction.

Trigger: S3 EventBridge "Object Created" on the PHI bucket prefix `cases/`.
On invocation:
  1. Read the EventBridge event for the bucket + key (detail.bucket.name /
     detail.object.key). The upload key is `cases/<caseId>/<uuid>-<filename>` and embeds NO
     documentId, so resolve the real documentId via the API
     (GET /api/v1/internal/documents/by-s3-key?key=...).
  2. Start a Textract async StartDocumentTextDetection job pointing at the S3 object.
     Provide an SNS topic ARN (env COMPLETION_SNS_TOPIC_ARN) so Textract notifies the
     completion handler when done. Job tag = documentId (so we can find it on completion).
  3. Exit. Textract takes minutes; this Lambda doesn't block on it.

Completion handler (`completion_handler` below): SNS-triggered. Fetches the Textract result
in pages, groups blocks by Page, and POSTs to the API:
  - POST /api/v1/internal/documents/<documentId>/pages with the per-page text + confidence.

OCR provider: Textract first. When Textract CANNOT read a file (job FAILED, or SUCCEEDED with no
text — image-only/scanned docs it choked on), fall back to CLAUDE OCR (ports the local app's
claude.js ocrSinglePdf: send the file as a base64 document/image, ask for verbatim text). This
restores the local behavior on the cloud side so an unreadable file is auto-read instead of
dead-ending to the RN queue. Reversible: env CLAUDE_OCR_FALLBACK=off → Textract-only.

NATIVE TEXT-READERS (keystone plan Package 2): `.txt`/`.docx`/`.doc` are not OCR inputs —
Textract rejects them and Claude vision can't take them, so they used to dead-end to the RN
queue with a generic flag. start_handler now branches on the s3-key EXTENSION (the declared
contentType arrives as application/octet-stream — same lesson as intakes.ts
effectiveContentType) BEFORE Textract: .txt is decoded directly (BOM-tolerant UTF-8),
.docx is extracted with python-docx (vendored into this directory — see workers/README.md
"Vendored dependencies"), and legacy .doc gets a best-effort ladder (mislabeled-docx → RTF
strip → plain-text sniff → flag with an actionable note). Native reads POST through the SAME
/pages upsert as Textract, so the word-count/garbled chart-readiness gating applies unchanged.

DEPLOYED via workers-stack.ts (compact-emr-<env>-ocr-start / -ocr-completion Lambdas). To run
locally, see the README at workers/README.md.
"""

import base64
import io
import json
import os
import re
import urllib.error
import urllib.parse
import urllib.request
import uuid
from collections import defaultdict
from typing import Any

import boto3

textract = boto3.client("textract")
s3 = boto3.client("s3")
_secrets = boto3.client("secretsmanager")

ANTHROPIC_MODEL = "claude-sonnet-4-6"  # matches local claude.js OCR model
MAX_OCR_BYTES = 25 * 1024 * 1024  # Claude document/image request cap headroom; larger → flag for RN
LOW_TEXT_CHARS = 200  # Textract output below this ≈ a barely-read scan → try Claude (≈ the 20-word read gate)
CLAUDE_REREAD_PER_PAGE_FLOOR = 50  # chars/page below which a MULTI-page doc is a choked scan (not a thin-but-fine form) → Claude re-read
_MEDIA_BY_EXT = {"pdf": "application/pdf", "png": "image/png", "jpg": "image/jpeg", "jpeg": "image/jpeg"}
_cached_anthropic_key: str | None = None


def _api_base_url() -> str:
    url = os.environ["COMPACT_EMR_API_URL"]
    return url.rstrip("/")


def _worker_token() -> str:
    return os.environ["INTERNAL_WORKER_TOKEN"]


def _resolve_document(s3_key: str) -> dict[str, Any] | None:
    """Resolve the Document row (id + whether it already has OCR pages) from its S3 key.

    The upload key (`cases/<caseId>/<uuid>-<filename>`) carries no documentId — the Document
    row id is minted after the key is chosen — so the worker must look it up. Returns
    {"documentId": ..., "hasPages": bool}, or None if the API has no Document for that key
    (404) or the call fails. `hasPages` drives the double-OCR guard (#8 v1).
    """
    query = urllib.parse.urlencode({"key": s3_key})
    url = f"{_api_base_url()}/api/v1/internal/documents/by-s3-key?{query}"
    req = urllib.request.Request(
        url,
        method="GET",
        headers={"X-Internal-Worker-Token": _worker_token()},
    )
    try:
        with urllib.request.urlopen(req, timeout=30) as response:
            payload = json.loads(response.read().decode("utf-8"))
        data = payload.get("data")
        return data if isinstance(data, dict) and data.get("documentId") else None
    except urllib.error.HTTPError as http_err:
        if http_err.code == 404:
            print(f"no document for s3 key {s3_key} (404); skipping")
            return None
        print(f"document lookup failed for {s3_key}: HTTP {http_err.code}")
        return None
    except Exception as exc:
        print(f"document lookup failed for {s3_key}: {exc}")
        return None


def start_handler(event: dict[str, Any], _context: Any) -> dict[str, Any]:
    """S3 EventBridge trigger. Kicks off a Textract async job.

    EventBridge delivers a single "Object Created" event (NOT an S3-direct Records[] list):
    the bucket + key live at event["detail"]["bucket"]["name"] / ["object"]["key"]. The key
    is URL-encoded in the event, so decode it before use.
    """
    detail = event.get("detail", {})
    bucket = detail.get("bucket", {}).get("name")
    raw_key = detail.get("object", {}).get("key")
    if not bucket or not raw_key:
        print(f"skipping event with no bucket/key in detail: {event.get('detail')}")
        return {"started": []}

    key = urllib.parse.unquote_plus(raw_key)

    # #8 v2 parse-at-intake: intake/ objects are OCR'd in place BEFORE assign. No Document exists yet,
    # so cache to IntakePage keyed by the intake s3 key. Branch off before the by-s3-key lookup.
    if key.startswith("intake/"):
        return _start_intake_ocr(bucket, key)

    # The auto-generated screening-summary file (cases/<id>/00000000-screening-summary.txt) is an
    # EXTRACTION OUTPUT, not a record to OCR. The cases/ EventBridge rule fires on its write, but it
    # has no clinical content to read, and re-OCRing it writes spurious document_pages/file_read_status
    # rows + a benign re-trigger (already no-op'd by the trigger-hash exclusion). Skip it. Keep this
    # marker in sync with chart-build-state.ts isScreeningSummaryKey + the writer. (Ryan 2026-06-13.)
    if key.endswith("00000000-screening-summary.txt"):
        print(f"skipping screening-summary output file (not an OCR input): {key}")
        return {"started": [], "skipped": "screening_summary"}

    # Rendered-letter outputs live at cases/<id>/_rendered/<doc>-v<n>.pdf — an EXTRA path segment, so
    # isCaseDocumentS3Key rejects them and no Document is ever recorded. The cases/ EventBridge rule still
    # fires on their write; without this skip _resolve_document 404s and (because key startswith cases/)
    # start_handler RAISES → exhausts retries → floods the ocr-start DLQ with output PDFs, crying wolf over
    # the real-failure alarm. Skip them like the screening-summary output. (QA 2026-06-13.)
    if "/_rendered/" in key:
        print(f"skipping rendered-letter output (not an OCR input): {key}")
        return {"started": [], "skipped": "rendered_output"}

    doc = _resolve_document(key)
    if not doc:
        # Package 4a orphan-race fix (raise-for-retry): a cases/ upload fires this Lambda the
        # instant the S3 object lands, but the Document row is recorded by the API a beat later
        # (recordDocument), so the by-s3-key lookup can 404 on a perfectly good upload. Returning
        # success here silently dropped the file — the configured async retry never fired.
        # Raising lets the Lambda async retry (retryAttempts: 2, ~1min/~2min backoff) re-resolve
        # after the row lands; the retry delay IS the grace period (no in-handler sleep). A
        # genuinely dead key (Document deleted) exhausts the retries and lands in the ocr-start
        # onFailure DLQ (workers-stack.ts), whose depth alarm makes it loud, never silent.
        # HARD SCOPE GUARD: raise for cases/ ONLY — intake/ already returned above (no Document
        # exists by design; raising there would break parse-at-intake), and any other prefix
        # keeps the original skip-with-success behavior.
        if key.startswith("cases/"):
            raise RuntimeError(
                f"no resolvable document for s3 key {key} yet (recordDocument may not have "
                f"landed); raising so the Lambda async retry re-resolves it"
            )
        print(f"skipping key with no resolvable document: {key}")
        return {"started": []}
    document_id = doc["documentId"]

    # Double-OCR guard (#8 v1): the document already carries OCR text (a re-fired ObjectCreated
    # event, a retry, or — once #8 v2 lands — text transplanted from the intake-time OCR at assign).
    # Skip Textract; the /pages upsert is idempotent so correctness never depended on this — pure
    # cost-saving. NOT keyed on the prefix: works for cases/ today and intake/ under v2.
    if doc.get("hasPages"):
        print(f"document {document_id} already has OCR pages; skipping Textract for {key}")
        return {"started": [], "skipped": "already_has_pages"}

    # Package 2: native text-readers. Keyed on the s3-key EXTENSION, not the declared
    # contentType (which arrives as application/octet-stream). Never starts Textract.
    ext = _key_extension(key)
    if ext in _NATIVE_TEXT_EXTS:
        return _native_read(bucket, key, document_id, ext)

    sns_topic = os.environ["COMPLETION_SNS_TOPIC_ARN"]
    sns_role_arn = os.environ["TEXTRACT_SNS_ROLE_ARN"]

    response = textract.start_document_text_detection(
        DocumentLocation={"S3Object": {"Bucket": bucket, "Name": key}},
        NotificationChannel={"SNSTopicArn": sns_topic, "RoleArn": sns_role_arn},
        JobTag=document_id,
    )
    started = [{"documentId": document_id, "jobId": response["JobId"]}]

    return {"started": started}


def _post_intake_ocr_start(intake_s3_key: str, job_tag: str) -> None:
    """Record the jobTag -> intake s3Key mapping (IntakePage placeholder) BEFORE Textract starts, so
    the async completion can route the result back (JobTag can't hold the slash-bearing s3 key)."""
    url = f"{_api_base_url()}/api/v1/internal/intakes/ocr-start"
    body = json.dumps({"intakeS3Key": intake_s3_key, "jobTag": job_tag}).encode("utf-8")
    req = urllib.request.Request(
        url, data=body, method="POST",
        headers={"Content-Type": "application/json", "X-Internal-Worker-Token": _worker_token()},
    )
    with urllib.request.urlopen(req, timeout=30) as response:
        if response.status >= 300:
            raise RuntimeError(f"intake ocr-start record failed: {response.status}")


def _start_intake_ocr(bucket: str, key: str) -> dict[str, Any]:
    """Parse-at-intake (#8 v2): start Textract on an intake/ object. Records the jobTag->s3Key mapping
    first; if that fails we DON'T start a job we couldn't route — the file is OCR'd at assign instead."""
    job_tag = uuid.uuid4().hex  # 32 hex chars; "intake:" + tag = 39 < the 64-char JobTag limit
    try:
        _post_intake_ocr_start(key, job_tag)
    except Exception as exc:  # noqa: BLE001 — surface + fall through to assign-time OCR
        print(json.dumps({"msg": "ocr: intake ocr-start record failed; will OCR at assign", "key": key, "error": f"{type(exc).__name__}: {exc}"}))
        return {"started": []}
    sns_topic = os.environ["COMPLETION_SNS_TOPIC_ARN"]
    sns_role_arn = os.environ["TEXTRACT_SNS_ROLE_ARN"]
    response = textract.start_document_text_detection(
        DocumentLocation={"S3Object": {"Bucket": bucket, "Name": key}},
        NotificationChannel={"SNSTopicArn": sns_topic, "RoleArn": sns_role_arn},
        JobTag="intake:" + job_tag,
    )
    return {"started": [{"intakeS3Key": key, "jobId": response["JobId"], "jobTag": job_tag}]}


def _post_intake_pages(job_tag: str, pages: list[dict[str, Any]], page_count: int) -> bool:
    """POST intake OCR pages -> /internal/intakes/by-job-tag/pages. 404 (unknown jobTag) is terminal
    (don't retry forever); other errors raise so SNS redelivers."""
    url = f"{_api_base_url()}/api/v1/internal/intakes/by-job-tag/pages"
    body = json.dumps({"jobTag": job_tag, "pages": pages, "documentPageCount": page_count}).encode("utf-8")
    req = urllib.request.Request(
        url, data=body, method="POST",
        headers={"Content-Type": "application/json", "X-Internal-Worker-Token": _worker_token()},
    )
    try:
        with urllib.request.urlopen(req, timeout=30) as response:
            return response.status < 300
    except urllib.error.HTTPError as http_err:
        if http_err.code == 404:
            print(json.dumps({"msg": "ocr: intake jobTag not found; dropping (assign will live-OCR)", "jobTag": job_tag}))
            return False
        raise


def _complete_intake(job_id: str, status: str, job_tag: str) -> dict[str, Any]:
    """Parse-at-intake completion. Best-effort Textract-only: cache the text to IntakePage if the job
    read text; if Textract FAILED or read nothing, do NOTHING — at assign the CopyObject's live OCR
    (with the Claude fallback) handles it. Keeps the intake path simple + cheap (no Claude at intake)."""
    if status != "SUCCEEDED":
        print(json.dumps({"msg": "ocr: intake textract not SUCCEEDED; assign will live-OCR", "jobTag": job_tag, "status": status}))
        return {"status": status, "posted": False}
    blocks, _ = _fetch_all_pages(job_id)
    pages, page_count = _build_page_payload(blocks)
    if not pages:
        print(json.dumps({"msg": "ocr: intake textract read no text; assign will live-OCR", "jobTag": job_tag}))
        return {"status": "EMPTY", "posted": False}
    posted = _post_intake_pages(job_tag, pages, page_count)
    total_chars = sum(len(p.get("text", "")) for p in pages)
    print(json.dumps({"msg": "ocr: intake pages posted" if posted else "ocr: intake pages dropped (jobTag gone)", "jobTag": job_tag, "pages": len(pages), "chars": total_chars, "posted": posted}))
    return {"status": "POSTED" if posted else "DROPPED", "pages": len(pages), "posted": posted}


def _fetch_all_pages(job_id: str) -> tuple[list[dict[str, Any]], int]:
    """Page through GetDocumentTextDetection until all blocks are retrieved. Returns (blocks,
    total_pages) where total_pages = Textract's DocumentMetadata.Pages — the REAL page count of the
    PDF, NOT max-page-with-text. A 50-page scan Textract choked on (text on page 1 only) reports
    total_pages=50 even though only page 1 carries blocks; the caller needs the real count so the
    size-relative Claude re-read fires AND the readiness gate treats it as substantial. (QA 2026-06-13.)"""
    blocks: list[dict[str, Any]] = []
    total_pages = 0
    next_token: str | None = None
    while True:
        kwargs: dict[str, Any] = {"JobId": job_id}
        if next_token:
            kwargs["NextToken"] = next_token
        response = textract.get_document_text_detection(**kwargs)
        if not total_pages:
            total_pages = int(response.get("DocumentMetadata", {}).get("Pages", 0) or 0)
        blocks.extend(response.get("Blocks", []))
        next_token = response.get("NextToken")
        if not next_token:
            break
    return blocks, total_pages


def _build_page_payload(blocks: list[dict[str, Any]]) -> tuple[list[dict[str, Any]], int]:
    """Group LINE blocks by Page → ordered per-page text + confidence. Returns
    (pages, document_page_count). Document page count is max(Page) across all blocks."""
    lines_by_page: dict[int, list[dict[str, Any]]] = defaultdict(list)
    max_page = 0
    for block in blocks:
        if block.get("BlockType") != "LINE":
            continue
        page = int(block.get("Page", 1))
        lines_by_page[page].append(block)
        if page > max_page:
            max_page = page

    pages: list[dict[str, Any]] = []
    for page_num in sorted(lines_by_page.keys()):
        lines = lines_by_page[page_num]
        text_lines = [b.get("Text", "") for b in lines]
        confidences = [b.get("Confidence", 0.0) for b in lines if b.get("Confidence") is not None]
        avg_conf = (sum(confidences) / len(confidences) / 100.0) if confidences else None
        pages.append({
            "pageNumber": page_num,
            "text": "\n".join(text_lines),
            "confidence": avg_conf,
        })
    return pages, max_page


def _post_pages_to_api(document_id: str, pages: list[dict[str, Any]], document_page_count: int) -> None:
    url = f"{_api_base_url()}/api/v1/internal/documents/{document_id}/pages"
    body = json.dumps({"pages": pages, "documentPageCount": document_page_count}).encode("utf-8")
    req = urllib.request.Request(
        url,
        data=body,
        method="POST",
        headers={
            "Content-Type": "application/json",
            "X-Internal-Worker-Token": _worker_token(),
        },
    )
    with urllib.request.urlopen(req, timeout=30) as response:
        if response.status >= 300:
            raise RuntimeError(f"API rejected pages upsert: {response.status}")


def _post_failed_read_attempt(document_id: str, textract_status: str, job_id: str, error_message: str | None = None) -> None:
    """POST a synthetic failed read-attempt to /api/v1/internal/documents/:id/read-attempt-
    failed so the file lands in file_read_status with terminalStatus='manual_summary_required'
    and the RN queue picks it up.

    Without this, a Textract failure (status != SUCCEEDED) leaves the file invisible to the
    chart-readiness gate and the pipeline silently halts. The route resolves documentId →
    caseId + s3Key server-side so the worker doesn't have to round-trip for the caseId.

    `error_message` (optional) is appended to the RN-visible note by the route — the native
    text-readers use it to make the flag ACTIONABLE (e.g. the legacy-.doc disposition), never
    a generic "could not read".
    """
    url = f"{_api_base_url()}/api/v1/internal/documents/{document_id}/read-attempt-failed"
    payload: dict[str, Any] = {"textractStatus": textract_status, "jobId": job_id}
    if error_message:
        payload["errorMessage"] = error_message[:2000]  # route caps errorMessage at 2000 chars
    body = json.dumps(payload).encode("utf-8")
    req = urllib.request.Request(
        url,
        data=body,
        method="POST",
        headers={
            "Content-Type": "application/json",
            "X-Internal-Worker-Token": _worker_token(),
        },
    )
    with urllib.request.urlopen(req, timeout=30) as response:
        if response.status >= 300:
            raise RuntimeError(f"API rejected failed-read-attempt POST: {response.status}")


# ===== Package 2 (F): native text-readers — .txt / .docx / legacy .doc =====
# These extensions are not OCR inputs (Textract rejects them; Claude vision can't take them),
# so before this branch they structurally dead-ended to the RN queue. start_handler reads the
# bytes directly and POSTs through the SAME /pages upsert as Textract — the server-side
# classifyReadAttempt word-count/garble gating therefore applies to native reads unchanged.

_NATIVE_TEXT_EXTS = {"txt", "docx", "doc"}
_MAX_PAGE_CHARS = 95_000  # /pages route rejects text over 100k chars/page; chunk with headroom
_OLE_MAGIC = b"\xd0\xcf\x11\xe0\xa1\xb1\x1a\xe1"  # genuine legacy .doc (OLE compound file)
_LEGACY_DOC_NOTE = "legacy .doc format — ask the veteran for PDF/docx, or summarize manually"


def _key_extension(key: str) -> str:
    """Lower-cased extension of the s3 key's filename segment ('' when none)."""
    name = key.rsplit("/", 1)[-1]
    return name.rsplit(".", 1)[-1].lower() if "." in name else ""


def _decode_text_bytes(data: bytes) -> str:
    """BOM-tolerant text decode. UTF-16 LE/BE BOMs are honored (Windows Notepad exports
    both), a UTF-8 BOM is stripped, everything else is UTF-8 with errors='replace' — never
    raises; undecodable bytes become U+FFFD and the readiness garble gate judges the result."""
    if data.startswith(b"\xff\xfe") or data.startswith(b"\xfe\xff"):
        return data.decode("utf-16", errors="replace")
    if data.startswith(b"\xef\xbb\xbf"):
        return data.decode("utf-8-sig", errors="replace")
    return data.decode("utf-8", errors="replace")


def _extract_docx_text(data: bytes) -> str:
    """python-docx extraction: paragraphs + tables in DOCUMENT ORDER via iter_inner_content
    (python-docx>=1.1, pinned in requirements.txt). Table rows render as ' | '-joined cells.
    Lazy import: docx (and its compiled lxml dep) is vendored into this directory for the
    Lambda asset; importing at module top would tax every non-docx cold start."""
    from docx import Document as _DocxDocument
    from docx.table import Table as _DocxTable

    document = _DocxDocument(io.BytesIO(data))
    parts: list[str] = []
    for item in document.iter_inner_content():
        if isinstance(item, _DocxTable):
            for row in item.rows:
                cells = [cell.text.strip() for cell in row.cells]
                if any(cells):
                    parts.append(" | ".join(cells))
        elif item.text:
            parts.append(item.text)
    return "\n".join(parts).strip()


def _strip_rtf(data: bytes) -> str:
    """CRUDE RTF→text (no dependency): enough for a best-effort read of an RTF masquerading
    as .doc. Header/font-table residue may survive — the downstream word-count/garble gate
    decides whether the read is usable, same as any other extraction."""
    text = data.decode("latin-1", errors="replace")
    text = re.sub(r"\{\\\*[^{}]*\}", "", text)  # starred destination groups (\*\generator …)
    text = re.sub(r"\\par[d]?\b", "\n", text)
    text = re.sub(r"\\(line|row)\b", "\n", text)
    text = re.sub(r"\\tab\b", "\t", text)
    text = re.sub(r"\\'([0-9a-fA-F]{2})", lambda m: chr(int(m.group(1), 16)), text)  # hex escapes
    text = re.sub(r"\\[a-zA-Z]+-?\d* ?", "", text)  # remaining control words
    text = re.sub(r"[{}]", "", text)
    text = re.sub(r"\\([^a-zA-Z])", r"\1", text)  # control symbols (\~ \- \_ …)
    return text.strip()


def _mostly_printable(text: str) -> bool:
    """Heuristic for 'these bytes are really just text': ≥85% printable/whitespace chars
    (replacement chars from a lossy decode count AGAINST it) over the first 64KB."""
    sample = text[:65536]
    if not sample.strip():
        return False
    good = sum(1 for ch in sample if (ch.isprintable() or ch in "\t\n\r\f") and ch != "�")
    return good / len(sample) >= 0.85


def _read_legacy_doc(data: bytes) -> tuple[str | None, str, str, str | None, str]:
    """Best-effort ladder for legacy `.doc` (Ryan: 'read any form thereof'). Returns
    (text, method, via, flag_note, flag_status); text=None ⇒ flag for RN with flag_note.

    (i)   try python-docx anyway — catches a real .docx mislabeled .doc (zip magic);
    (ii)  magic-byte sniffs: RTF header → crude control-word strip; genuine OLE compound
          file → flag with the ACTIONABLE legacy-.doc note (no OLE reader in the bundle —
          antiword/libreoffice judged too heavy for a rare format);
    (iii) mostly-printable bytes → treat as plain text (e.g. a .txt renamed .doc);
    else  flag with an actionable note. Never silent, never a generic flag."""
    try:  # (i) mislabeled .docx
        return _extract_docx_text(data), "native_docx", "python-docx (mislabeled .doc)", None, ""
    except Exception:  # noqa: BLE001 — not a docx; descend the ladder
        pass
    if data.lstrip()[:5].startswith(b"{\\rtf"):  # (ii) RTF masquerading as .doc
        return _strip_rtf(data), "native_text", "rtf-strip", None, ""
    if data[:8] == _OLE_MAGIC:  # (ii) genuine OLE .doc — flag, actionably
        return None, "", "", _LEGACY_DOC_NOTE, "LEGACY_DOC"
    decoded = _decode_text_bytes(data)
    if _mostly_printable(decoded):  # (iii) plain text wearing a .doc name
        return decoded, "native_text", "plain-text-sniff", None, ""
    return None, "", "", "unreadable .doc — ask the veteran for PDF/docx, or summarize manually", "NATIVE_UNREADABLE"


def _build_native_pages(text: str) -> list[dict[str, Any]]:
    """Form-feed (\\f) page breaks → one /pages entry per page; a no-FF file is a single page.
    Pages over the route's 100k-char cap are hard-chunked. An all-empty decode still posts one
    (empty) page so the readiness classifier flags it through the normal threshold path."""
    segments = [seg.strip("\n\r") for seg in text.split("\f")]
    segments = [seg for seg in segments if seg.strip()] or [text.strip()]
    chunks: list[str] = []
    for seg in segments:
        if not seg:
            chunks.append(seg)
            continue
        chunks.extend(seg[i : i + _MAX_PAGE_CHARS] for i in range(0, len(seg), _MAX_PAGE_CHARS))
    return [{"pageNumber": i + 1, "text": chunk, "confidence": None} for i, chunk in enumerate(chunks)]


def _native_read(bucket: str, key: str, document_id: str, ext: str) -> dict[str, Any]:
    """Read a .txt/.docx/.doc directly (no Textract, no Claude) and POST pages. Deterministic
    parse failures flag for the RN via read-attempt-failed (actionable note, never silent);
    transient errors (S3 get, API post) propagate so the EventBridge target retries."""
    data = s3.get_object(Bucket=bucket, Key=key)["Body"].read(MAX_OCR_BYTES + 1)
    if len(data) > MAX_OCR_BYTES:
        _post_failed_read_attempt(
            document_id, "NATIVE_TOO_LARGE", "native-read",
            error_message=f".{ext} file over {MAX_OCR_BYTES // (1024 * 1024)}MB — split it, convert to PDF, or summarize manually",
        )
        print(json.dumps({"msg": "ocr: native read too large; flagged for RN", "documentId": document_id, "ext": ext, "bytes": len(data)}))
        return {"started": [], "native": ext, "flaggedForRn": True}

    text: str | None
    note: str | None = None
    status = "NATIVE_UNREADABLE"
    if ext == "txt":
        text, method, via = _decode_text_bytes(data), "native_text", "utf8"
    elif ext == "docx":
        try:
            text, method, via = _extract_docx_text(data), "native_docx", "python-docx"
        except Exception as exc:  # noqa: BLE001 — deterministic parse failure → RN flag
            text, method, via = None, "", ""
            note = f".docx could not be parsed ({type(exc).__name__}) — re-save as PDF or .docx, or summarize manually"
    else:  # legacy .doc — best-effort ladder
        text, method, via, note, status = _read_legacy_doc(data)

    if text is None:
        _post_failed_read_attempt(document_id, status, "native-read", error_message=note)
        print(json.dumps({"msg": "ocr: native read flagged for RN", "documentId": document_id, "ext": ext, "status": status, "note": note}))
        return {"started": [], "native": ext, "flaggedForRn": True}

    pages = _build_native_pages(text)
    _post_pages_to_api(document_id, pages, len(pages))
    print(json.dumps({"msg": "ocr: native read posted", "documentId": document_id, "ext": ext, "method": method, "via": via, "pages": len(pages), "chars": len(text)}))
    return {"started": [], "native": ext, "method": method, "via": via, "pages": len(pages)}


def _claude_enabled() -> bool:
    return os.environ.get("CLAUDE_OCR_FALLBACK", "off").lower() == "on"


def _phi_bucket() -> str:
    return os.environ["RECORDS_BUCKET"]


def _anthropic_key() -> str | None:
    global _cached_anthropic_key
    if _cached_anthropic_key is None:
        arn = os.environ.get("ANTHROPIC_SECRET_ARN")
        if not arn:
            return None
        _cached_anthropic_key = _secrets.get_secret_value(SecretId=arn)["SecretString"].strip()
    return _cached_anthropic_key


def _document_source(document_id: str) -> dict[str, Any]:
    """Resolve documentId -> {s3Key, contentType} (the worker only has the id on completion)."""
    url = f"{_api_base_url()}/api/v1/internal/documents/{urllib.parse.quote(document_id)}/source"
    req = urllib.request.Request(url, headers={"X-Internal-Worker-Token": _worker_token()})
    with urllib.request.urlopen(req, timeout=30) as response:
        return json.loads(response.read().decode("utf-8")).get("data", {})


def _media_type(s3_key: str, content_type: str | None) -> str | None:
    if content_type in ("application/pdf", "image/png", "image/jpeg"):
        return content_type
    ext = s3_key.rsplit(".", 1)[-1].lower() if "." in s3_key else ""
    return _MEDIA_BY_EXT.get(ext)


def _claude_ocr(document_id: str) -> str:
    """Claude OCR fallback — ports local claude.js ocrSinglePdf. Fetch the file from S3 and ask
    Claude to extract verbatim text. Returns '' if disabled / unsupported / too large / on error
    (caller then flags the file for the RN, which is overridable — never a dead-end)."""
    if not _claude_enabled():
        return ""
    api_key = _anthropic_key()
    if not api_key:
        return ""
    src = _document_source(document_id)
    s3_key = src.get("s3Key")
    if not s3_key:
        return ""
    # Skip our OWN generated Intake Summary — a short one is valid (it's just a sparse intake) and the
    # readiness gate already excludes it, so don't waste a Claude call on it.
    if re.search(r"-intake_summary\.pdf$", str(s3_key), re.IGNORECASE):
        return ""
    media = _media_type(s3_key, src.get("contentType"))
    if media is None:  # e.g. .docx — not a Claude vision input; let it flag (overridable)
        return ""
    data = s3.get_object(Bucket=_phi_bucket(), Key=s3_key)["Body"].read(MAX_OCR_BYTES + 1)
    if len(data) > MAX_OCR_BYTES:
        print(json.dumps({"msg": "ocr: file too large for Claude fallback", "documentId": document_id, "bytes": len(data)}))
        return ""
    b64 = base64.b64encode(data).decode("ascii")
    block = (
        {"type": "document", "source": {"type": "base64", "media_type": media, "data": b64}}
        if media == "application/pdf"
        else {"type": "image", "source": {"type": "base64", "media_type": media, "data": b64}}
    )
    body = json.dumps({
        "model": ANTHROPIC_MODEL,
        "max_tokens": 16000,
        "messages": [{"role": "user", "content": [
            block,
            {"type": "text", "text": (
                "Extract ALL text from this medical record document verbatim. Include every date, "
                "diagnosis, lab value, provider name, medication, and clinical finding. Preserve the "
                "document structure. If the document has multiple pages, prefix each page's text with a "
                "line '=== Page N ==='. If a page contains no legible text, output nothing for that page "
                "— do NOT describe the image or guess. Output the raw text only, no commentary."
            )},
        ]}],
    }).encode("utf-8")
    req = urllib.request.Request(
        "https://api.anthropic.com/v1/messages", data=body, method="POST",
        headers={"x-api-key": api_key, "anthropic-version": "2023-06-01", "content-type": "application/json"},
    )
    with urllib.request.urlopen(req, timeout=300) as response:
        payload = json.loads(response.read().decode("utf-8"))
    parts = payload.get("content") or []
    text = "".join(p.get("text", "") for p in parts if p.get("type") == "text").strip()
    # Truncation guard (QA 2026-06-13): if Claude hit max_tokens the extraction is PARTIAL. Posting it
    # would clear the readiness gate looking complete while silently dropping the back half of the record
    # — a correctness hazard for the letter. Return '' so the caller falls through to the thin Textract
    # text → readiness gate flags for the RN. Fail to a FLAG, never to a silent partial.
    if payload.get("stop_reason") == "max_tokens":
        print(json.dumps({"msg": "ocr: claude OCR truncated at max_tokens; flagging instead of posting partial", "documentId": document_id, "chars": len(text)}))
        return ""
    return text


def _handle_unreadable(document_id: str, textract_status: str, job_id: str) -> bool:
    """Textract could not read this file. Try the Claude OCR fallback; if it yields text, post it as
    a page so the file reads (no dead-end). Otherwise flag for the RN (overridable). Never silent."""
    text = ""
    try:
        text = _claude_ocr(document_id)
    except Exception as exc:  # noqa: BLE001 — surface the reason, never a silent drop
        print(json.dumps({"msg": "ocr: claude fallback error", "documentId": document_id, "error": f"{type(exc).__name__}: {exc}"}))
    if text:
        _post_pages_to_api(document_id, [{"pageNumber": 1, "text": text, "confidence": None}], 1)
        print(json.dumps({"msg": "ocr: claude fallback succeeded", "documentId": document_id, "chars": len(text)}))
        return True
    try:
        _post_failed_read_attempt(document_id, textract_status, job_id)
    except Exception as post_exc:  # noqa: BLE001
        print(f"could not post failed read-attempt for {document_id} (status={textract_status}): {post_exc}")
    return False


def completion_handler(event: dict[str, Any], _context: Any) -> dict[str, Any]:
    """SNS-triggered handler. Textract notifies us when an async job is done. Pull the
    blocks, group by page, POST to the API."""
    records = event.get("Records") or []
    processed: list[dict[str, Any]] = []

    for record in records:
        sns = record.get("Sns", {})
        message_raw = sns.get("Message")
        if not message_raw:
            continue
        message = json.loads(message_raw)
        job_id = message.get("JobId")
        status = message.get("Status")
        job_tag = message.get("JobTag")  # we stamped this on StartDocumentTextDetection

        # #8 v2 parse-at-intake: intake jobs are tagged "intake:<jobTag>" and route to IntakePage.
        if isinstance(job_tag, str) and job_tag.startswith("intake:"):
            intake_result = _complete_intake(job_id, status, job_tag[len("intake:"):])
            processed.append({"jobId": job_id, "intake": True, **intake_result})
            continue

        document_id = job_tag  # cases path: JobTag == documentId

        if status != "SUCCEEDED":
            # Textract failed. Try the Claude OCR fallback; if it can't read it either, flag for the
            # RN (overridable) so the file is never silently lost.
            read = _handle_unreadable(document_id, status, job_id)
            processed.append({"jobId": job_id, "documentId": document_id, "status": status, "posted": read, "claudeOcr": read, "flaggedForRn": not read})
            continue

        blocks, total_pages = _fetch_all_pages(job_id)
        pages, max_text_page = _build_page_payload(blocks)
        # REAL PDF page count (DocumentMetadata.Pages), falling back to max-page-with-text. A 50-page scan
        # Textract choked on has total_pages=50 but max_text_page=1 — the real count makes the size-relative
        # re-read fire AND the readiness gate treat it as substantial (flag thin text), instead of silently
        # accepting a 1-page read of a 50-page record. (QA 2026-06-13.)
        document_page_count = total_pages or max_text_page
        if pages:
            # Textract read SOMETHING but very little (a scan it choked on → a few words). Try Claude
            # OCR and keep whichever extraction has more text — so a partially-read scanned record
            # gets a real read instead of tripping the <40-word readiness threshold. (Our generated
            # Intake_Summary is skipped inside _claude_ocr.)
            total_chars = sum(len(p.get("text", "")) for p in pages)
            # Size-relative low-text trigger (Ryan 2026-06-13: "if in doubt, send it to Anthropic").
            # Fire the Claude deep-read when text is sparse in ABSOLUTE terms (a small choked scan) OR
            # sparse RELATIVE to the page count (a 10-page doc with 800 chars is a big scan Textract
            # choked on — re-read it before it ever reaches the readiness gate). Cost stays bounded by
            # the 25MB cap inside _claude_ocr; a legitimately short small file stays Textract-only.
            low_text = total_chars < LOW_TEXT_CHARS or (document_page_count >= 2 and total_chars < CLAUDE_REREAD_PER_PAGE_FLOOR * document_page_count)
            if low_text:
                claude_text = ""
                try:
                    claude_text = _claude_ocr(document_id)
                except Exception as exc:  # noqa: BLE001
                    print(json.dumps({"msg": "ocr: claude low-text fallback error", "documentId": document_id, "error": f"{type(exc).__name__}: {exc}"}))
                if len(claude_text) > total_chars:
                    # Post the REAL page count (not 1): if Claude itself read a big scan poorly, the doc
                    # still trips the multi-page word floor downstream rather than passing as a 1-pager.
                    _post_pages_to_api(document_id, [{"pageNumber": 1, "text": claude_text, "confidence": None}], document_page_count)
                    print(json.dumps({"msg": "ocr: claude low-text fallback won", "documentId": document_id, "textractChars": total_chars, "claudeChars": len(claude_text)}))
                    processed.append({"jobId": job_id, "documentId": document_id, "status": "POSTED", "pages": 1, "claudeOcr": True})
                    continue
            _post_pages_to_api(document_id, pages, document_page_count)
            processed.append({"jobId": job_id, "documentId": document_id, "status": "POSTED", "pages": len(pages)})
        else:
            # Textract succeeded but extracted NO text (image-only/scanned doc it choked on). Same
            # fallback path — Claude OCR, else flag for the RN.
            read = _handle_unreadable(document_id, "EMPTY", job_id)
            processed.append({"jobId": job_id, "documentId": document_id, "status": "EMPTY", "pages": 0, "claudeOcr": read, "flaggedForRn": not read})

    return {"processed": processed}
