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
import time
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

# CLAUDE_VISION_DESCRIBE (dark, default OFF): when the verbatim-OCR path yields effectively-no text
# AND the media is a textless image (a photo of an injured leg, a scar, hardware — no chart text to
# read), make a SECOND, separate Claude vision call that DESCRIBES what is medically observable, so
# the description becomes usable record text and the readiness char-floor passes instead of dead-ending
# a $500 letter. Ryan 2026-06-14: "with pic only without text maybe that's the rare time where a manual
# person reviews it before submitting." The description is therefore stamped as AI-generated visual
# evidence (NOT OCR'd record text) and surfaced for human confirm — never silently treated as a clean read.
# The "effectively-no text" gate is the _handle_unreadable chokepoint itself: it is reached only when the
# verbatim path produced no usable text (Textract FAILED/EMPTY, or _claude_ocr returned '' after .strip()).
_IMAGE_DESCRIBE_MEDIA = {"image/png", "image/jpeg"}  # describe path is image-only (not PDFs)
_IMAGE_EVIDENCE_PREFIX = "[IMAGE EVIDENCE — AI visual description, not OCR text]\n"
_NO_CLINICAL_CONTENT = "NO CLINICAL CONTENT"  # exact sentinel the describe prompt returns when nothing is visible


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

    # Layer 1: a .pdf with a real EMBEDDED TEXT LAYER (a born-digital VA Blue Button dump) is read
    # DIRECTLY with pypdf BEFORE Textract — Textract image-OCR choked on Lozano's 2,294-page dump and
    # stored NO pages. _native_pdf_read probes the text layer: a hit posts pages through the same
    # /pages pipeline and returns a result; a true image-only scan (or any pypdf error) returns the
    # _PDF_TEXTRACT_FALLTHROUGH sentinel and we start Textract exactly as before. See the DEPLOY NOTE
    # in _native_pdf_read: ocr-start must be raised to ~1769MB/5min for a big dump to finish inline.
    if ext == "pdf":
        pdf_result = _native_pdf_read(bucket, key, document_id)
        if pdf_result is not _PDF_TEXTRACT_FALLTHROUGH:
            return pdf_result

    # Per-page VISION path (dark default; CLAUDE_VISION_SCANNED_PAGES=on). A SCANNED pdf (born-digital
    # already returned above via the pypdf probe) or an image goes page-by-page to Claude vision with the
    # two-tier Haiku→Sonnet strategy, posting per-page provenance — closing the combo-page handwriting
    # loss + the per-file false-100% at the source. _vision_read returns _VISION_FALLTHROUGH when vision
    # is not applicable (too large / encrypted / over the page cap / not pdf-or-image), and we start
    # Textract exactly as before. Off by default → zero live behavior change until flipped + validated.
    if _vision_scanned_enabled() and (ext == "pdf" or _media_type(key, None) in ("image/png", "image/jpeg")):
        vision_result = _vision_read(bucket, key, document_id, ext)
        if vision_result is not _VISION_FALLTHROUGH:
            return vision_result

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

_NATIVE_TEXT_EXTS = {"txt", "docx", "doc", "html", "htm"}
_MAX_PAGE_CHARS = 95_000  # /pages route rejects text over 100k chars/page; chunk with headroom
_OLE_MAGIC = b"\xd0\xcf\x11\xe0\xa1\xb1\x1a\xe1"  # genuine legacy .doc (OLE compound file)
_LEGACY_DOC_NOTE = "legacy .doc format — ask the veteran for PDF/docx, or summarize manually"

# ===== Layer 1: native PDF text-layer extraction (pypdf, BEFORE Textract) =====
# A DIGITAL text-layer PDF (a VA Blue Button dump exported from VA.gov — born-digital, every page
# carries a real embedded text layer) is read DIRECTLY with pypdf instead of going to Textract
# image-OCR. Textract treats every page as an image to OCR; on a 2,294-page dump (Lozano
# CLM-44F17A108A) it choked and stored NO pages, stranding the case in ocr_in_progress. pypdf reads
# the same file's 3.04M-char text layer in ~21s (dev box; ~one full vCPU on Lambda). A TRUE image-only
# scan has a thin/empty text layer → the probe fails → we fall through to Textract exactly as before.
#
# DECIDE native-vs-Textract with a PER-DOCUMENT PROBE: sample first/middle/last N pages and require a
# per-page char floor. A born-digital dump scores hundreds-to-thousands of chars/page on the sample; a
# scan scores ~0. The probe is cheap (open + ~9 pages ≈ 0.3s) and runs inline in start_handler; the
# full extraction is the only heavy part (see the DEPLOY NOTE in _native_pdf_read).
_PDF_PROBE_PAGES = 4          # sample size from EACH of head / middle / tail (≤12 pages probed total)
_PDF_PROBE_MIN_CHARS = 50     # mean non-whitespace chars/page across the probe to call it a text layer
_PDF_TEXTRACT_FALLTHROUGH = None  # sentinel: probe was thin → caller starts Textract as before
# Pages per /pages POST. The route caps a request at 2,000 entries (internal-worker.ts
# parsePageUpsertBody); 1,000 keeps each batch well under that AND under the writer's 30s Prisma
# transaction window for the per-page upserts. A 2,294-page dump posts in 3 batches.
_PAGES_PER_POST = 1_000


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


def _strip_html(data: bytes) -> str:
    """Best-effort HTML -> text using only the Python stdlib (no BeautifulSoup dependency).
    VA "Rated Disabilities" + Blue Button HTML exports are plain tables of SC conditions / meds /
    problems — stripping the tags yields exactly the text the chart-extractor needs (E4, 2026-06-13).
    script/style content is dropped; block tags become newlines and cells become tabs so the table
    structure survives as readable text; entities are unescaped (convert_charrefs). Never raises on
    malformed markup — the downstream word-count / garble gate judges whether the read is usable,
    same as every other native reader."""
    from html.parser import HTMLParser

    block_tags = {"br", "p", "div", "tr", "li", "h1", "h2", "h3", "h4", "table", "ul", "ol"}

    class _TextExtractor(HTMLParser):
        def __init__(self) -> None:
            super().__init__(convert_charrefs=True)
            self.parts: list[str] = []
            self._skip_depth = 0

        def handle_starttag(self, tag: str, attrs: Any) -> None:
            if tag in ("script", "style", "head"):
                self._skip_depth += 1
            elif tag in block_tags:
                self.parts.append("\n")
            elif tag in ("td", "th"):
                self.parts.append("\t")

        def handle_endtag(self, tag: str) -> None:
            if tag in ("script", "style", "head") and self._skip_depth > 0:
                self._skip_depth -= 1
            elif tag in block_tags:
                self.parts.append("\n")

        def handle_data(self, data: str) -> None:
            if self._skip_depth == 0:
                self.parts.append(data)

    parser = _TextExtractor()
    parser.feed(_decode_text_bytes(data))
    parser.close()
    text = "".join(parser.parts)
    text = re.sub(r"[ \t]+", " ", text)        # collapse runs of spaces/tabs
    text = re.sub(r" *\n *", "\n", text)        # trim spaces around newlines
    text = re.sub(r"\n{3,}", "\n\n", text)      # collapse blank-line runs
    return text.strip()


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
    elif ext in ("html", "htm"):
        try:
            text, method, via = _strip_html(data), "native_html", "stdlib-htmlparser"
            if not text:  # tags stripped to nothing (e.g. an all-script page) → flag, don't post an empty read
                text, note = None, "HTML file had no readable text after tag-strip — ask for a PDF, or summarize manually"
        except Exception as exc:  # noqa: BLE001 — deterministic parse failure → RN flag
            text, method, via = None, "", ""
            note = f".html could not be parsed ({type(exc).__name__}) — re-save as PDF, or summarize manually"
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


# ===== Layer 1 native PDF text-layer extractor =====


def _nonws_len(text: str) -> int:
    """Non-whitespace char count — mirrors the server-side chart-readiness `nonWhitespaceCharCount`
    so the probe floor speaks the same 'is this real content?' language the gate does."""
    return len("".join(text.split()))


def _probe_indices(n: int) -> list[int]:
    """Sample page indices from the head, middle, and tail of an n-page PDF (deduped, in range).
    A born-digital dump has text EVERYWHERE; a scan with a sparse cover page only wouldn't pass a
    head-only probe, so we look at the middle and tail too before trusting the text layer."""
    if n <= 0:
        return []
    if n <= _PDF_PROBE_PAGES * 3:
        return list(range(n))
    head = list(range(_PDF_PROBE_PAGES))
    mid_start = max(0, n // 2 - _PDF_PROBE_PAGES // 2)
    middle = list(range(mid_start, mid_start + _PDF_PROBE_PAGES))
    tail = list(range(n - _PDF_PROBE_PAGES, n))
    return sorted(set(head + middle + tail))


def _build_pdf_native_pages(reader: Any, page_count: int) -> tuple[list[dict[str, Any]], int]:
    """Extract per-page text for the WHOLE doc, preserving page_number so the downstream chunker +
    grounding gate keep their [p.N] structure. A page whose text-layer extraction yields nothing (a
    scanned image page inside an otherwise-digital PDF) posts as an EMPTY page — acceptable, noted in
    the return; we never fail the whole doc for a few image pages. Any single page over the route's
    100k-char cap is hard-chunked into extra page entries (same headroom as the native-text readers),
    so the emitted pageNumber sequence is dense + monotonic but may exceed page_count when chunking
    fires. Returns (pages, empty_page_count)."""
    pages: list[dict[str, Any]] = []
    empty = 0
    seq = 0
    for idx in range(page_count):
        try:
            raw = reader.pages[idx].extract_text() or ""
        except Exception as exc:  # noqa: BLE001 — one bad page must not sink a 2,294-page read
            print(json.dumps({"msg": "ocr: pypdf page extract error (posting empty page)", "page": idx + 1, "error": f"{type(exc).__name__}: {exc}"}))
            raw = ""
        text = raw.strip("\n\r")
        if not text.strip():
            empty += 1
            seq += 1
            pages.append({"pageNumber": seq, "text": "", "confidence": None})
            continue
        # Hard-chunk a page over the route cap (rare for a real text page, but VA exports can pack a
        # whole table onto one page); each chunk is its own /pages entry, exactly like the native readers.
        for i in range(0, len(text), _MAX_PAGE_CHARS):
            seq += 1
            pages.append({"pageNumber": seq, "text": text[i : i + _MAX_PAGE_CHARS], "confidence": None})
    return pages, empty


def _post_pages_batched(document_id: str, pages: list[dict[str, Any]], document_page_count: int) -> None:
    """POST pages through the SAME /pages upsert as Textract + the native readers, but in batches of
    <= _PAGES_PER_POST so a big dump stays under the route's 2,000-entries-per-request cap
    (internal-worker.ts parsePageUpsertBody). The TRUE document_page_count is sent on EVERY batch (so
    the readiness gate's size-aware floor always sees the real size, and Document.pageCount is correct
    regardless of batch order). The /pages upsert is idempotent (keyed on documentId+pageNumber), so a
    re-fire / retry overwrites in place. NOTE (single-batch terminal-status): writeDocumentPages runs
    the chart-readiness classifier on the pages IN EACH POST and writes file_read_status from that
    subset — for a real text-layer dump every batch is substantive so the last batch resolves to
    'read', but a hypothetical sparse-TAIL batch could mis-park; see the DEPLOY NOTE."""
    for start in range(0, len(pages), _PAGES_PER_POST):
        batch = pages[start : start + _PAGES_PER_POST]
        _post_pages_to_api(document_id, batch, document_page_count)


def _native_pdf_read(bucket: str, key: str, document_id: str) -> dict[str, Any] | None:
    """Layer 1: try to read a .pdf's EMBEDDED TEXT LAYER directly with pypdf, BEFORE Textract.

    Returns a result dict when the native path HANDLED the doc (text-layer found → pages posted).
    Returns _PDF_TEXTRACT_FALLTHROUGH (None) when the doc is NOT a usable text-layer PDF (a true
    image-only scan, an encrypted/garbage PDF, or any pypdf error) — the caller then starts Textract
    exactly as before. NEVER raises for a parse problem: a bad PDF must degrade to Textract, never
    crash start_handler (which would burn the orphan-race retry budget + hit the DLQ).

    DEPLOY NOTE (infra, ocr-start Lambda — REQUIRED before this can read a big dump in production):
    full extraction of Lozano's 2,294-page PDF is ~21s on a dev box → ~21-30s at a FULL Lambda vCPU
    (1769MB) but >120s at the current 256MB (~0.15 vCPU). ocr-start is timeout=2min/memory=256MB
    (workers-stack.ts:278). To run this inline, ocr-start MUST be raised to memorySize≈1769MB (full
    vCPU; pypdf is single-threaded CPU-bound, RAM peak is only ~55MB) and timeout to ≈5min. Cost of the
    bump is negligible (the tiny .txt/.docx/Textract-start invocations finish sub-second). A doc that
    is too large for the bumped budget would time out → raise → DLQ; the size guard below caps the
    bytes we even attempt so a pathological file flags rather than loops."""
    data = s3.get_object(Bucket=bucket, Key=key)["Body"].read(MAX_OCR_BYTES + 1)
    if len(data) > MAX_OCR_BYTES:
        # Too big to buffer for a native read — let Textract (which streams from S3) own it.
        print(json.dumps({"msg": "ocr: pdf over native size cap; deferring to textract", "documentId": document_id, "bytes": len(data)}))
        return _PDF_TEXTRACT_FALLTHROUGH

    from pypdf import PdfReader  # lazy: only a .pdf with a text layer pays the import

    try:
        reader = PdfReader(io.BytesIO(data))
        if getattr(reader, "is_encrypted", False):
            # An encrypted PDF: pypdf can't read the text layer without the password. Let Textract try.
            print(json.dumps({"msg": "ocr: pdf encrypted; deferring to textract", "documentId": document_id}))
            return _PDF_TEXTRACT_FALLTHROUGH
        page_count = len(reader.pages)
    except Exception as exc:  # noqa: BLE001 — unreadable/corrupt PDF → Textract owns it (never crash)
        print(json.dumps({"msg": "ocr: pypdf could not open pdf; deferring to textract", "documentId": document_id, "error": f"{type(exc).__name__}: {exc}"}))
        return _PDF_TEXTRACT_FALLTHROUGH

    if page_count == 0:
        return _PDF_TEXTRACT_FALLTHROUGH

    # PROBE: sample head/middle/tail; mean non-whitespace chars/page must clear the floor to trust the
    # text layer. A born-digital dump scores hundreds/page; a scan scores ~0 → fall through to Textract.
    probe = _probe_indices(page_count)
    probe_chars = 0
    for idx in probe:
        try:
            probe_chars += _nonws_len(reader.pages[idx].extract_text() or "")
        except Exception:  # noqa: BLE001 — a probe-page error just contributes 0 (conservative)
            pass
    mean = probe_chars / len(probe) if probe else 0
    if mean < _PDF_PROBE_MIN_CHARS:
        print(json.dumps({"msg": "ocr: pdf text-layer thin; deferring to textract", "documentId": document_id, "pages": page_count, "probeMeanChars": round(mean, 1)}))
        return _PDF_TEXTRACT_FALLTHROUGH

    # Text layer confirmed → extract the WHOLE doc natively and POST through the same /pages pipeline.
    pages, empty = _build_pdf_native_pages(reader, page_count)
    total_chars = sum(len(p["text"]) for p in pages)
    _post_pages_batched(document_id, pages, page_count)
    print(json.dumps({
        "msg": "ocr: native pdf text-layer read posted", "documentId": document_id,
        "path": "native-text-layer", "pdfPages": page_count, "postedPages": len(pages),
        "emptyPages": empty, "chars": total_chars, "probeMeanChars": round(mean, 1),
    }))
    return {"started": [], "native": "pdf", "method": "native_pdf_text", "via": "pypdf", "pages": len(pages), "pdfPages": page_count, "emptyPages": empty}


# ===== Per-page vision transcription (CLAUDE_VISION_SCANNED_PAGES, dark default off) =====
# Definitive fix for silent content loss on SCANNED pages (Ryan 2026-06-16). Today Textract reads a
# combo page's PRINTED boilerplate, clears the char floor, and the page is marked read while the
# HANDWRITING is silently dropped — and coverage was counted per-FILE, so a multi-page scan with
# blank/partial pages read "100%" (the Stephens incident: 9/37 pages blank + combo handwriting lost).
# This routes every SCANNED page (born-digital PDFs still take the pypdf Layer-1 path above) to Claude
# vision PER PAGE, with a TWO-TIER model strategy (Ryan, validated on Stephens): a cheap Haiku first
# pass, escalate that page to Sonnet on ANY doubt — coverage != "full", handwriting present, near-empty
# text, or malformed output. (On the Stephens A/B this routed every cursive/combo page — including the
# one Haiku confabulated — to Sonnet, and kept Haiku only on the clean printed pages it nailed.) Each
# page self-reports coverage + handwriting via a FORCED record_page tool, and we POST per-page
# provenance so coverage is honest PER PAGE instead of per file.
#
# NO RASTERIZER DEPENDENCY: a scanned PDF is split into single-page PDFs with pypdf (already vendored)
# and each is sent as a Claude `document` block — Claude renders the page image itself (same mechanism
# the existing _claude_ocr whole-PDF fallback already relies on), so no binary image lib is added.
#
# DEPLOY NOTE (infra, ocr-start Lambda): the per-file vision read runs INLINE in start_handler like the
# native-pdf read. Each page is ~1 (Haiku) + maybe 1 (Sonnet) API call; VISION_CONCURRENCY runs them in
# parallel so a typical small enclosure finishes in seconds. A single uploaded file is capped at
# VISION_MAX_PAGES pages (larger files fall through to Textract, which streams + handles huge async).
# When CLAUDE_VISION_SCANNED_PAGES=on, raise ocr-start to ~2048MB / 900s (15min) to cover the worst
# single oversized scanned upload under the cap.


def _int_env(name: str, default: int) -> int:
    """Positive-int env read with a fallback on missing / NaN / non-positive."""
    try:
        v = int(os.environ.get(name, ""))
        return v if v > 0 else default
    except (TypeError, ValueError):
        return default


def _vision_scanned_enabled() -> bool:
    return os.environ.get("CLAUDE_VISION_SCANNED_PAGES", "off").lower() == "on"


VISION_TIER1_MODEL = os.environ.get("CLAUDE_VISION_MODEL", "claude-haiku-4-5-20251001")
VISION_ESCALATE_MODEL = os.environ.get("CLAUDE_VISION_ESCALATE_MODEL", "claude-sonnet-4-6")
VISION_ESCALATE_CHAR_FLOOR = _int_env("VISION_ESCALATE_CHAR_FLOOR", 10)  # tier-1 text shorter than this → escalate
VISION_CONCURRENCY = _int_env("VISION_CONCURRENCY", 8)
VISION_MAX_PAGES = _int_env("VISION_MAX_PAGES", 280)  # per-file cap; larger → defer to Textract
VISION_PAGE_MAX_TOKENS = 4000  # one page never needs more; near-zero truncation risk per-page
_VISION_FALLTHROUGH = None  # sentinel: vision not applicable for this file → caller starts Textract
_VISION_COVERAGE = {"full", "partial", "illegible", "blank"}

_RECORD_PAGE_TOOL = {
    "name": "record_page",
    "description": "Record the verbatim transcription and an honest coverage assessment of this single scanned medical-record page.",
    "input_schema": {
        "type": "object",
        "properties": {
            "transcription": {
                "type": "string",
                "description": "Verbatim text of the page — printed text AND handwriting together, in reading order. Transcribe exactly what is written. Mark any unreadable span inline as [illegible]. Do NOT guess, normalize, expand abbreviations, or correct apparent errors. If the page is blank, use an empty string.",
            },
            "handwriting_present": {
                "type": "boolean",
                "description": "True ONLY if the page has SUBSTANTIVE handwritten content — clinical notes, handwritten form entries, marginal annotations. A bare signature, initials, a handwritten date, a stamp, or stray scanner marks do NOT count: set false when those are the only handwriting.",
            },
            "coverage": {
                "type": "string",
                "enum": ["full", "partial", "illegible", "blank"],
                "description": "full = all the actual CONTENT was transcribed with high confidence. A signature, initials, a stamp, or stray marks are NOT content — if you captured the real text and the only thing you couldn't read is a signature/stamp/marks, coverage is 'full'. partial = a region of real content was too faint/cut-off/overlapping to read confidently (marked [illegible] inline). illegible = the page has content but almost none could be read. blank = no content on the page.",
            },
            "uncertain_regions": {
                "type": "string",
                "description": "Brief plain-language note of WHAT was hard to read and where (e.g. 'handwritten provider note in bottom-right margin, faded'). Empty string if coverage is full or blank.",
            },
        },
        "required": ["transcription", "handwriting_present", "coverage", "uncertain_regions"],
        "additionalProperties": False,
    },
}

# NOTE: NO SSN redaction instruction (Ryan 2026-06-16 — under the Anthropic BAA, PHI may flow through
# the API; the chart extraction must be FAITHFUL verbatim like Textract/native readers. SSN omission is
# enforced at the LETTER layer, not extraction). Anti-confabulation is the load-bearing rule here.
_VISION_SYSTEM = (
    "You are a meticulous medical-record transcriptionist working on VA disability claims. "
    "Accuracy is a legal and clinical requirement: a fabricated date, lab value, diagnosis, "
    "or medication can corrupt a veteran's disability claim. Transcribe ONLY what is actually "
    "on the page.\n"
    "Rules:\n"
    "- Transcribe printed text and handwriting together, in natural reading order. Handwritten "
    "entries on a printed form are part of the record — never skip them.\n"
    "- Read cursive and faded ('BEST COPY') scans as carefully as you can.\n"
    "- If a word, number, or region is genuinely unreadable, write [illegible] in place of it. "
    "NEVER guess a clinical value, date, name, or dosage. An honest [illegible] is correct; a "
    "plausible guess is a serious error.\n"
    "- Do not summarize, diagnose, interpret, expand abbreviations, or add commentary. Verbatim only.\n"
    "- A signature, initials, a handwritten date, a stamp, or stray scanner marks are NOT record "
    "content. If the only handwriting you could not fully read is one of those, coverage is 'full' and "
    "handwriting_present is false — do not flag a fully-readable typed page for review just because it "
    "is signed. Reserve handwriting_present=true + 'partial' for SUBSTANTIVE handwritten content.\n"
    "- Report coverage honestly via the tool. If you had to mark real CONTENT [illegible], coverage "
    "is 'partial', not 'full'."
)


def _model_short(model_id: str) -> str:
    """Short provenance tag for the extraction_method column: 'vision_haiku' / 'vision_sonnet' / raw."""
    low = model_id.lower()
    if "haiku" in low:
        return "vision_haiku"
    if "sonnet" in low:
        return "vision_sonnet"
    if "opus" in low:
        return "vision_opus"
    return "vision_" + low[:24]


def _split_pdf_pages(data: bytes) -> list[bytes] | None:
    """Split a PDF into one single-page PDF blob per page (pypdf — already vendored; no rasterizer).
    Returns None for an encrypted/corrupt PDF (caller falls through to Textract). Each blob is sent to
    Claude as a `document` block; Claude renders the page image itself."""
    from pypdf import PdfReader, PdfWriter

    try:
        reader = PdfReader(io.BytesIO(data))
        if getattr(reader, "is_encrypted", False):
            return None
        blobs: list[bytes] = []
        for page in reader.pages:
            writer = PdfWriter()
            writer.add_page(page)
            buf = io.BytesIO()
            writer.write(buf)
            blobs.append(buf.getvalue())
        return blobs
    except Exception as exc:  # noqa: BLE001 — corrupt PDF → Textract owns it, never crash start_handler
        print(json.dumps({"msg": "ocr: pypdf could not split pdf for vision; deferring to textract", "error": f"{type(exc).__name__}: {exc}"}))
        return None


def _claude_vision_page(page_bytes: bytes, media: str, api_key: str, model: str) -> dict[str, Any]:
    """One page → Claude vision with the forced record_page tool. Returns a normalized dict
    {text, coverage, handwriting, stop_reason, ok}. ok=False on truncation / missing tool block / a
    coverage outside the enum (caller treats !ok as a reason to escalate or flag — never posts blindly)."""
    b64 = base64.b64encode(page_bytes).decode("ascii")
    block = (
        {"type": "document", "source": {"type": "base64", "media_type": media, "data": b64}}
        if media == "application/pdf"
        else {"type": "image", "source": {"type": "base64", "media_type": media, "data": b64}}
    )
    body = json.dumps({
        "model": model,
        "max_tokens": VISION_PAGE_MAX_TOKENS,
        "system": _VISION_SYSTEM,
        "tools": [_RECORD_PAGE_TOOL],
        "tool_choice": {"type": "tool", "name": "record_page"},
        "messages": [{"role": "user", "content": [
            block,
            {"type": "text", "text": "Transcribe this single page and record it with the record_page tool."},
        ]}],
    }).encode("utf-8")
    req = urllib.request.Request(
        "https://api.anthropic.com/v1/messages", data=body, method="POST",
        headers={"x-api-key": api_key, "anthropic-version": "2023-06-01", "content-type": "application/json"},
    )
    with urllib.request.urlopen(req, timeout=120) as response:
        payload = json.loads(response.read().decode("utf-8"))
    tool_input: dict[str, Any] = {}
    for blk in payload.get("content") or []:
        if blk.get("type") == "tool_use" and blk.get("name") == "record_page":
            tool_input = blk.get("input") or {}
            break
    coverage = tool_input.get("coverage")
    text = tool_input.get("transcription") or ""
    stop = payload.get("stop_reason")
    ok = stop == "tool_use" and bool(tool_input) and coverage in _VISION_COVERAGE
    return {
        "text": text if isinstance(text, str) else "",
        "coverage": coverage if coverage in _VISION_COVERAGE else None,
        "handwriting": tool_input.get("handwriting_present") if isinstance(tool_input.get("handwriting_present"), bool) else None,
        "stop_reason": stop,
        "ok": ok,
    }


def _vision_page_with_retry(page_bytes: bytes, media: str, api_key: str, model: str) -> dict[str, Any]:
    """One page, one retry on a TRANSIENT failure (429 / 5xx / 529 / network), HONORING Retry-After; a
    4xx client error (bad request) is terminal — no retry. Never raises: returns ok=False on final
    failure so the two-tier logic can escalate or the page is flagged. (QA F3: the raw urllib path
    doesn't get the SDK's backoff, so under the 8-way fan-out an instant 429 retry self-throttles.)"""
    fail = {"text": "", "coverage": None, "handwriting": None, "stop_reason": "error", "ok": False}
    for attempt in range(2):
        try:
            r = _claude_vision_page(page_bytes, media, api_key, model)
            if r["ok"] or attempt == 1:
                return r
        except urllib.error.HTTPError as http_err:
            transient = http_err.code in (429, 500, 502, 503, 529)
            if attempt == 0 and transient:
                try:
                    delay = min(int(http_err.headers.get("Retry-After", "2")), 10)
                except (TypeError, ValueError):
                    delay = 2
                time.sleep(delay)  # backed-off single retry (Lambda: time.sleep is fine)
                continue
            # a non-transient 4xx, or the second attempt → terminal, never raise
            print(json.dumps({"msg": "ocr: vision page http error (final)", "model": model, "code": http_err.code}))
            return fail
        except Exception as exc:  # noqa: BLE001 — network/parse; retry once then give a non-ok result
            if attempt == 1:
                print(json.dumps({"msg": "ocr: vision page error (final)", "model": model, "error": f"{type(exc).__name__}: {exc}"}))
                return fail
    return fail


def _vision_transcribe_page(page_bytes: bytes, media: str, api_key: str) -> dict[str, Any]:
    """TWO-TIER per-page transcription: cheap tier-1 (Haiku) first, escalate to tier-2 (Sonnet) on ANY
    doubt. Returns {text, coverage, handwriting, method}. A page that BOTH tiers fail is returned
    coverage='illegible' (never silently dropped — the readiness gate / RN queue then owns it)."""
    t1 = _vision_page_with_retry(page_bytes, media, api_key, VISION_TIER1_MODEL)
    escalate = (
        (not t1["ok"])
        or t1["coverage"] != "full"
        or t1["handwriting"] is True
        or _nonws_len(t1["text"]) < VISION_ESCALATE_CHAR_FLOOR
    )
    if escalate and VISION_ESCALATE_MODEL and VISION_ESCALATE_MODEL != VISION_TIER1_MODEL:
        t2 = _vision_page_with_retry(page_bytes, media, api_key, VISION_ESCALATE_MODEL)
        if t2["ok"] and t1["ok"]:
            # Both tiers usable → KEEP THE READ THAT CAPTURED MORE (text length is the proxy that caught
            # the Stephens handwriting loss in the first place), breaking ties toward higher coverage.
            # Never blindly discard a COMPLETE tier-1 read for a tier-2 pass that may have read LESS — a
            # tier-1 'partial' is often just an honest [illegible] on a smudge, not a worse read. (QA F1.)
            cov_rank = {"full": 3, "partial": 2, "illegible": 1, "blank": 0}
            t2_better = (
                _nonws_len(t2["text"]) >= _nonws_len(t1["text"])
                or cov_rank.get(t2["coverage"] or "", 0) > cov_rank.get(t1["coverage"] or "", 0)
            )
            chosen, used = (t2, VISION_ESCALATE_MODEL) if t2_better else (t1, VISION_TIER1_MODEL)
            return {"text": chosen["text"], "coverage": chosen["coverage"], "handwriting": chosen["handwriting"], "method": _model_short(used), "escalated": True}
        if t2["ok"]:
            return {"text": t2["text"], "coverage": t2["coverage"], "handwriting": t2["handwriting"], "method": _model_short(VISION_ESCALATE_MODEL), "escalated": True}
        # escalation failed — fall back to tier-1 if IT was usable, else flag illegible below.
    if t1["ok"]:
        return {"text": t1["text"], "coverage": t1["coverage"], "handwriting": t1["handwriting"], "method": _model_short(VISION_TIER1_MODEL), "escalated": False}
    return {"text": "", "coverage": "illegible", "handwriting": None, "method": _model_short(VISION_TIER1_MODEL), "escalated": escalate}


def _vision_read(bucket: str, key: str, document_id: str, ext: str) -> dict[str, Any] | None:
    """Per-page vision transcription for a SCANNED file. Returns a result dict on success, or
    _VISION_FALLTHROUGH (None) when vision is not applicable for this file (no key/too large/encrypted/
    non-pdf-non-image/over the page cap) — the caller then starts Textract exactly as before. Never
    raises: any unexpected error returns FALLTHROUGH so a scanned file degrades to Textract, never
    crashes start_handler."""
    api_key = _anthropic_key()
    if not api_key:
        return _VISION_FALLTHROUGH
    try:
        data = s3.get_object(Bucket=bucket, Key=key)["Body"].read(MAX_OCR_BYTES + 1)
    except Exception as exc:  # noqa: BLE001
        print(json.dumps({"msg": "ocr: vision s3 read failed; deferring to textract", "documentId": document_id, "error": f"{type(exc).__name__}: {exc}"}))
        return _VISION_FALLTHROUGH
    if len(data) > MAX_OCR_BYTES:
        print(json.dumps({"msg": "ocr: file over vision size cap; deferring to textract", "documentId": document_id, "bytes": len(data)}))
        return _VISION_FALLTHROUGH

    media = _media_type(key, None)
    if ext == "pdf":
        page_blobs = _split_pdf_pages(data)
        if not page_blobs:
            return _VISION_FALLTHROUGH  # encrypted/corrupt/empty → Textract
        page_media = "application/pdf"
    elif media in ("image/png", "image/jpeg"):
        page_blobs = [data]
        page_media = media
    else:
        return _VISION_FALLTHROUGH  # not a vision input (e.g. unexpected ext)

    n = len(page_blobs)
    if n > VISION_MAX_PAGES:
        print(json.dumps({"msg": "ocr: scanned file over vision page cap; deferring to textract", "documentId": document_id, "pages": n, "cap": VISION_MAX_PAGES}))
        return _VISION_FALLTHROUGH

    from concurrent.futures import ThreadPoolExecutor

    results: list[dict[str, Any] | None] = [None] * n

    def _work(idx: int) -> tuple[int, dict[str, Any]]:
        return idx, _vision_transcribe_page(page_blobs[idx], page_media, api_key)

    with ThreadPoolExecutor(max_workers=min(VISION_CONCURRENCY, n)) as pool:
        for idx, res in pool.map(_work, range(n)):
            results[idx] = res

    pages: list[dict[str, Any]] = []
    cov_counts: dict[str, int] = defaultdict(int)
    escalations = 0
    for i, res in enumerate(results):
        r = res or {"text": "", "coverage": "illegible", "handwriting": None, "method": _model_short(VISION_TIER1_MODEL), "escalated": True}
        cov_counts[r.get("coverage") or "unknown"] += 1
        if r.get("escalated"):
            escalations += 1
        pages.append({
            "pageNumber": i + 1,
            "text": r["text"],
            "confidence": None,
            "extractionMethod": r["method"],
            "extractionCoverage": r["coverage"],
            "handwritingPresent": r["handwriting"],
        })

    _post_pages_batched(document_id, pages, n)
    total_chars = sum(len(p["text"]) for p in pages)
    print(json.dumps({
        "msg": "ocr: vision per-page read posted", "documentId": document_id, "path": "vision-scanned",
        "pages": n, "chars": total_chars, "escalations": escalations, "coverage": dict(cov_counts),
        "tier1": VISION_TIER1_MODEL, "escalateModel": VISION_ESCALATE_MODEL,
    }))
    return {"started": [], "vision": True, "pages": n, "escalations": escalations, "coverage": dict(cov_counts)}


def _claude_enabled() -> bool:
    return os.environ.get("CLAUDE_OCR_FALLBACK", "off").lower() == "on"


def _vision_describe_enabled() -> bool:
    """Dark flag (default OFF): textless-image auto-describe. Ships dark so it cannot change live
    behavior until smoke-tested — flip CLAUDE_VISION_DESCRIBE=on to activate. Independent of
    CLAUDE_OCR_FALLBACK (the describe call still uses _anthropic_key/_phi_bucket, but is a distinct path)."""
    return os.environ.get("CLAUDE_VISION_DESCRIBE", "off").lower() == "on"


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
    # NOTE (Ryan, Jamarious 2026-06-14 — root fix): we USED to skip anything matching
    # `-intake_summary.pdf` here to save a Claude call on our OWN sparse-but-valid generated summary.
    # But that regex ALSO matched a VETERAN-UPLOADED "Intake_Summary.pdf" (the presign key is
    # <uuid>-<OriginalName>, so an uploaded file ends in `-Intake_Summary.pdf` too). When such an
    # uploaded file FAILED Textract, the Claude rescue skipped it, the readiness gate hid it, yet the
    # DRAFTER still refused ("1 record file failed extraction and was NOT reviewed") — undraftable
    # FOREVER, invisible in the RN queue, with no way to clear it (10+ dead draft attempts). The whole
    # point of this fallback is "if Textract couldn't read it, TRY Claude" — we must NEVER skip a file
    # that already failed extraction. The optimization is removed; a wasted call on the rare genuinely
    # short generated summary is trivial next to dead-ending a $500 letter. (Original ask: if in doubt,
    # send it to Anthropic.)
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


def _claude_describe_image(document_id: str) -> str:
    """SECOND Claude vision call — a DESCRIBE pass (separate from the verbatim-OCR prompt in _claude_ocr).
    Fires only for a textless IMAGE when CLAUDE_VISION_DESCRIBE is on. Returns the raw description text
    (caller stamps provenance), '' when disabled / not an image / too large / on error, and '' when the
    model reports NO CLINICAL CONTENT (caller then leaves it as a failed read → manual path; we never post
    a meaningless description). Ports the _claude_ocr plumbing but with a documentarian prompt that
    describes (does NOT transcribe, diagnose, or speculate)."""
    if not _vision_describe_enabled():
        return ""
    api_key = _anthropic_key()
    if not api_key:
        return ""
    src = _document_source(document_id)
    s3_key = src.get("s3Key")
    if not s3_key:
        return ""
    media = _media_type(s3_key, src.get("contentType"))
    if media not in _IMAGE_DESCRIBE_MEDIA:  # PDFs and non-image media never take the describe path
        return ""
    data = s3.get_object(Bucket=_phi_bucket(), Key=s3_key)["Body"].read(MAX_OCR_BYTES + 1)
    if len(data) > MAX_OCR_BYTES:
        print(json.dumps({"msg": "ocr: image too large for Claude vision describe", "documentId": document_id, "bytes": len(data)}))
        return ""
    b64 = base64.b64encode(data).decode("ascii")
    body = json.dumps({
        "model": ANTHROPIC_MODEL,
        "max_tokens": 4000,
        "system": (
            "You are a clinical documentarian. Describe ONLY what is medically observable in this "
            "photograph of a veteran's body or record — anatomical region, visible findings (swelling, "
            "deformity, scar, surgical hardware, skin changes, laterality), and any visible text/labels. "
            "Do NOT diagnose, infer cause, or speculate. If nothing clinically relevant is visible, output "
            f"exactly: {_NO_CLINICAL_CONTENT}"
        ),
        "messages": [{"role": "user", "content": [
            {"type": "image", "source": {"type": "base64", "media_type": media, "data": b64}},
            {"type": "text", "text": "Describe what is medically observable in this photograph."},
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
    # NO CLINICAL CONTENT → don't post a description; leave it as a failed read so the manual path owns it.
    if not text or text.strip() == _NO_CLINICAL_CONTENT:
        print(json.dumps({"msg": "ocr: vision describe found no clinical content; not posting (manual path)", "documentId": document_id}))
        return ""
    return text


def _try_image_describe(document_id: str) -> bool:
    """If CLAUDE_VISION_DESCRIBE is on and this is a textless image, run the describe pass and, on a real
    description, POST it as the page text PREFIXED with an AI-visual-evidence provenance marker so it never
    reads as charted OCR text. Returns True if a description was posted (the file now has usable text →
    readiness char-floor passes → the $500 letter isn't blocked).

    HUMAN-CONFIRM (option b, lightest correct): because this is an AI description of an image and NOT a real
    record read, it must be surfaced for a quick RN/physician confirm rather than silently accepted as a
    clean machine read. The in-band `_IMAGE_EVIDENCE_PREFIX` is the durable provenance signal every
    downstream reader (RN queue, drafter, chart-extractor) sees on the page text itself. A dedicated
    confirm-surface (a distinct file_read_status method/UI flag) is OWED as a follow-up — see the
    `needsHumanConfirm` log breadcrumb below; we deliberately do NOT route through
    _post_failed_read_attempt here because that sets terminalStatus='manual_summary_required', which would
    re-block the very letter we just unblocked."""
    description = ""
    try:
        description = _claude_describe_image(document_id)
    except Exception as exc:  # noqa: BLE001 — surface the reason, never a silent drop
        print(json.dumps({"msg": "ocr: vision describe error", "documentId": document_id, "error": f"{type(exc).__name__}: {exc}"}))
    if not description:
        return False
    page_text = _IMAGE_EVIDENCE_PREFIX + description
    _post_pages_to_api(document_id, [{"pageNumber": 1, "text": page_text, "confidence": None}], 1)
    print(json.dumps({"msg": "ocr: image-described (needs human confirm)", "documentId": document_id, "chars": len(description), "needsHumanConfirm": True}))
    return True


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
    # Verbatim OCR yielded effectively no text. If this is a textless IMAGE and CLAUDE_VISION_DESCRIBE is
    # on, auto-describe it (stamped as AI visual evidence, surfaced for human confirm) so the readiness
    # char-floor passes instead of dead-ending the letter. Dark-by-default: when the flag is off this is a
    # no-op and the code falls straight through to the unchanged RN flag below. Guarded so any error here
    # can never block the flag path (_try_image_describe swallows + logs its own errors and returns False).
    if _try_image_describe(document_id):
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
