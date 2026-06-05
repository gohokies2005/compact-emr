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

DEPLOYED via workers-stack.ts (compact-emr-<env>-ocr-start / -ocr-completion Lambdas). To run
locally, see the README at workers/README.md.
"""

import base64
import json
import os
import urllib.error
import urllib.parse
import urllib.request
from collections import defaultdict
from typing import Any

import boto3

textract = boto3.client("textract")
s3 = boto3.client("s3")
_secrets = boto3.client("secretsmanager")

ANTHROPIC_MODEL = "claude-sonnet-4-6"  # matches local claude.js OCR model
MAX_OCR_BYTES = 25 * 1024 * 1024  # Claude document/image request cap headroom; larger → flag for RN
_MEDIA_BY_EXT = {"pdf": "application/pdf", "png": "image/png", "jpg": "image/jpeg", "jpeg": "image/jpeg"}
_cached_anthropic_key: str | None = None


def _api_base_url() -> str:
    url = os.environ["COMPACT_EMR_API_URL"]
    return url.rstrip("/")


def _worker_token() -> str:
    return os.environ["INTERNAL_WORKER_TOKEN"]


def _resolve_document_id(s3_key: str) -> str | None:
    """Resolve the Document row id from its S3 key via the internal API.

    The upload key (`cases/<caseId>/<uuid>-<filename>`) carries no documentId — the Document
    row id is minted after the key is chosen — so the worker must look it up. Returns the
    documentId, or None if the API has no Document for that key (404) or the call fails.
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
        return payload.get("data", {}).get("documentId")
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
    document_id = _resolve_document_id(key)
    if not document_id:
        print(f"skipping key with no resolvable document: {key}")
        return {"started": []}

    sns_topic = os.environ["COMPLETION_SNS_TOPIC_ARN"]
    sns_role_arn = os.environ["TEXTRACT_SNS_ROLE_ARN"]

    response = textract.start_document_text_detection(
        DocumentLocation={"S3Object": {"Bucket": bucket, "Name": key}},
        NotificationChannel={"SNSTopicArn": sns_topic, "RoleArn": sns_role_arn},
        JobTag=document_id,
    )
    started = [{"documentId": document_id, "jobId": response["JobId"]}]

    return {"started": started}


def _fetch_all_pages(job_id: str) -> list[dict[str, Any]]:
    """Page through GetDocumentTextDetection until all blocks are retrieved."""
    blocks: list[dict[str, Any]] = []
    next_token: str | None = None
    while True:
        kwargs: dict[str, Any] = {"JobId": job_id}
        if next_token:
            kwargs["NextToken"] = next_token
        response = textract.get_document_text_detection(**kwargs)
        blocks.extend(response.get("Blocks", []))
        next_token = response.get("NextToken")
        if not next_token:
            break
    return blocks


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


def _post_failed_read_attempt(document_id: str, textract_status: str, job_id: str) -> None:
    """POST a synthetic failed read-attempt to /api/v1/internal/documents/:id/read-attempt-
    failed so the file lands in file_read_status with terminalStatus='manual_summary_required'
    and the RN queue picks it up.

    Without this, a Textract failure (status != SUCCEEDED) leaves the file invisible to the
    chart-readiness gate and the pipeline silently halts. The route resolves documentId →
    caseId + s3Key server-side so the worker doesn't have to round-trip for the caseId.
    """
    url = f"{_api_base_url()}/api/v1/internal/documents/{document_id}/read-attempt-failed"
    body = json.dumps({
        "textractStatus": textract_status,
        "jobId": job_id,
    }).encode("utf-8")
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
            {"type": "text", "text": "Extract ALL text from this medical record document verbatim. Include every date, diagnosis, lab value, provider name, medication, and clinical finding. Preserve the document structure. Output the raw text only, no commentary."},
        ]}],
    }).encode("utf-8")
    req = urllib.request.Request(
        "https://api.anthropic.com/v1/messages", data=body, method="POST",
        headers={"x-api-key": api_key, "anthropic-version": "2023-06-01", "content-type": "application/json"},
    )
    with urllib.request.urlopen(req, timeout=300) as response:
        payload = json.loads(response.read().decode("utf-8"))
    parts = payload.get("content") or []
    return "".join(p.get("text", "") for p in parts if p.get("type") == "text").strip()


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
        document_id = message.get("JobTag")  # we stamped this on StartDocumentTextDetection

        if status != "SUCCEEDED":
            # Textract failed. Try the Claude OCR fallback; if it can't read it either, flag for the
            # RN (overridable) so the file is never silently lost.
            read = _handle_unreadable(document_id, status, job_id)
            processed.append({"jobId": job_id, "documentId": document_id, "status": status, "posted": read, "claudeOcr": read, "flaggedForRn": not read})
            continue

        blocks = _fetch_all_pages(job_id)
        pages, document_page_count = _build_page_payload(blocks)
        if pages:
            _post_pages_to_api(document_id, pages, document_page_count)
            processed.append({"jobId": job_id, "documentId": document_id, "status": "POSTED", "pages": len(pages)})
        else:
            # Textract succeeded but extracted NO text (image-only/scanned doc it choked on). Same
            # fallback path — Claude OCR, else flag for the RN.
            read = _handle_unreadable(document_id, "EMPTY", job_id)
            processed.append({"jobId": job_id, "documentId": document_id, "status": "EMPTY", "pages": 0, "claudeOcr": read, "flaggedForRn": not read})

    return {"processed": processed}
