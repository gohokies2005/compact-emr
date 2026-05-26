"""
Phase 7B-revised Build 3: OCR worker — Textract async extraction.

Trigger: S3 EventBridge "Object Created" on the records bucket prefix `records/`.
On invocation:
  1. Parse the S3 event for the bucket + key + documentId (encoded in the key path:
     records/<caseId>/<documentId>/<filename>.pdf).
  2. Start a Textract async StartDocumentTextDetection job pointing at the S3 object.
     Provide an SNS topic ARN (env COMPLETION_SNS_TOPIC_ARN) so Textract notifies the
     completion handler when done. Job tag = documentId (so we can find it on completion).
  3. Exit. Textract takes minutes; this Lambda doesn't block on it.

Completion handler (`completion_handler` below): SNS-triggered. Fetches the Textract result
in pages, groups blocks by Page, and POSTs to the API:
  - POST /api/v1/internal/documents/<documentId>/pages with the per-page text + confidence.

Per FRN ingest spec (HARD requirement #1): we NEVER use Claude as OCR. Textract is the
single OCR provider on this path.

NOT YET DEPLOYED. This file is the Lambda source the CDK stack (workers-stack.ts, follow-up
commit) will package and deploy. To run locally, see the README at workers/README.md.
"""

import json
import os
import urllib.request
from collections import defaultdict
from typing import Any

import boto3

textract = boto3.client("textract")


def _api_base_url() -> str:
    url = os.environ["COMPACT_EMR_API_URL"]
    return url.rstrip("/")


def _worker_token() -> str:
    return os.environ["INTERNAL_WORKER_TOKEN"]


def _document_id_from_s3_key(key: str) -> str | None:
    # Convention: records/<caseId>/<documentId>/<filename>
    parts = key.split("/")
    if len(parts) < 4 or parts[0] != "records":
        return None
    return parts[2]


def start_handler(event: dict[str, Any], _context: Any) -> dict[str, Any]:
    """S3 EventBridge trigger. Kicks off Textract async job."""
    records = event.get("Records") or []
    started: list[dict[str, Any]] = []
    sns_topic = os.environ["COMPLETION_SNS_TOPIC_ARN"]
    sns_role_arn = os.environ["TEXTRACT_SNS_ROLE_ARN"]

    for record in records:
        s3 = record.get("s3", {})
        bucket = s3.get("bucket", {}).get("name")
        key = s3.get("object", {}).get("key")
        if not bucket or not key:
            continue
        document_id = _document_id_from_s3_key(key)
        if not document_id:
            print(f"skipping non-records key: {key}")
            continue

        response = textract.start_document_text_detection(
            DocumentLocation={"S3Object": {"Bucket": bucket, "Name": key}},
            NotificationChannel={"SNSTopicArn": sns_topic, "RoleArn": sns_role_arn},
            JobTag=document_id,
        )
        started.append({"documentId": document_id, "jobId": response["JobId"]})

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
            # Architect final QA finding #3 (REVIEW.md 0f8b64a): on Textract failure, POST a
            # synthetic failed read-attempt so the chart-readiness gate sees this file as
            # 'manual_summary_required' and the RN queue picks it up. Otherwise the file
            # silently disappears from the pipeline and no human ever knows it failed.
            try:
                _post_failed_read_attempt(document_id, status, job_id)
            except Exception as post_exc:
                print(f"could not post failed read-attempt for {document_id} (status={status}): {post_exc}")
            processed.append({"jobId": job_id, "documentId": document_id, "status": status, "posted": False, "flaggedForRn": True})
            continue

        blocks = _fetch_all_pages(job_id)
        pages, document_page_count = _build_page_payload(blocks)
        if pages:
            _post_pages_to_api(document_id, pages, document_page_count)
            processed.append({"jobId": job_id, "documentId": document_id, "status": "POSTED", "pages": len(pages)})
        else:
            processed.append({"jobId": job_id, "documentId": document_id, "status": "EMPTY", "pages": 0})

    return {"processed": processed}
