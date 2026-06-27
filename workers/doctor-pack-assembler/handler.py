"""
Doctor Pack PDF assembler (SQS-triggered Lambda).

Trigger: SQS message from the API when POST /api/v1/cases/:id/doctor-pack/generate creates a queued
DoctorPack row. The message body carries `{doctorPackId, manifest, pdfS3Key}`.

On invocation:
  1. PATCH state='generating' so the UI shows progress.
  2. Merge every manifest entry's selected page ranges (pulled from S3) into one output PDF. The
     COVER is manifest entry #0 — a single calm pdf-lib-rendered table-of-contents PDF produced by
     the TS service (record-text-render). There is no separate cover/TOC rendering here.
  3. DOCTOR_PACK_LINKED_COVER (2026-06-27): if the manifest carries `coverLinkMap`, stamp a PDF link
     on each cover content row (-> that document's first merged page) + a 2-level outline. Fail-open.
  4. Upload the assembled PDF to the server-computed pdfS3Key.
  5. PATCH state='ready' with pdfS3Key + pageCount. On any failure: PATCH state='failed'.

The merge / link / outline logic lives in assemble.py (pure, unit-tested without AWS). This module
is the thin I/O orchestrator: S3 fetch + API PATCH.

DEPLOYED via workers-stack.ts (compact-emr-<env>-doctor-pack-assembler Lambda, SQS-triggered).

Note (2026-06-27): the old WeasyPrint HTML->PDF cover + TOC rendering was DELETED. WeasyPrint was an
optional Lambda layer that was never attached on the live path ('No module named weasyprint' on 100%
of runs), so it never rendered anything — the real cover has been the pdf-lib cover-index entry for a
while. The pack is now ONE pdf-lib cover + the merged source pages.
"""

import io
import json
import os
import urllib.request
from typing import Any

import boto3

# pypdf ships VENDORED in this asset dir (pip install pypdf -t .) — it is pure-Python, so the
# vendor is platform-safe. Import failure must NOT init-crash the Lambda (2026-06-12 incident:
# pypdf was never deployed, every invocation died at import, the watcher republished the queued
# rows forever → 101-deep queue and NO error ever reached a human). A failed import is recorded
# and surfaced per-record so the row flips to 'failed' loudly instead.
try:
    from pypdf import PdfWriter

    from assemble import assemble_pack
    _PYPDF_IMPORT_ERROR: str | None = None
except Exception as _e:  # pragma: no cover — only fires on a broken deployment artifact
    PdfWriter = None  # type: ignore[assignment]
    assemble_pack = None  # type: ignore[assignment]
    _PYPDF_IMPORT_ERROR = f"pypdf/assemble unavailable in deployment artifact: {_e}"

s3 = boto3.client("s3")


def _api_base_url() -> str:
    return os.environ["COMPACT_EMR_API_URL"].rstrip("/")


def _worker_token() -> str:
    return os.environ["INTERNAL_WORKER_TOKEN"]


def _records_bucket() -> str:
    return os.environ["RECORDS_BUCKET"]


def _doctor_packs_bucket() -> str:
    return os.environ["DOCTOR_PACKS_BUCKET"]


def _patch_doctor_pack(doctor_pack_id: str, body: dict[str, Any]) -> None:
    url = f"{_api_base_url()}/api/v1/internal/doctor-packs/{doctor_pack_id}"
    req = urllib.request.Request(
        url,
        data=json.dumps(body).encode("utf-8"),
        method="PATCH",
        headers={
            "Content-Type": "application/json",
            "X-Internal-Worker-Token": _worker_token(),
        },
    )
    with urllib.request.urlopen(req, timeout=30) as response:
        if response.status >= 300:
            raise RuntimeError(f"API rejected doctor-pack PATCH: {response.status}")


def handler(event: dict[str, Any], _context: Any) -> dict[str, Any]:
    """SQS-triggered. The route POSTs `{doctorPackId, manifest, pdfS3Key}` to the queue."""
    records = event.get("Records") or []
    results: list[dict[str, Any]] = []

    for record in records:
        body = json.loads(record.get("body", "{}"))
        doctor_pack_id = body.get("doctorPackId")
        manifest = body.get("manifest", {})
        pdf_s3_key = body.get("pdfS3Key")
        if not doctor_pack_id or not pdf_s3_key:
            print(f"skipping malformed message: {body}")
            continue

        try:
            _patch_doctor_pack(doctor_pack_id, {"state": "generating"})

            if _PYPDF_IMPORT_ERROR is not None:
                # Fail the ROW loudly instead of init-crashing the whole Lambda — the RN sees a
                # failed pack with the real reason, and the watcher stops republishing it. MUST
                # come AFTER the 'generating' PATCH: the API's state machine only allows
                # queued→generating→failed, so failing straight from 'queued' would 409 and leave
                # the row stuck (adversarial-audit finding #14 — the fail-loud path was dead code).
                raise RuntimeError(_PYPDF_IMPORT_ERROR)

            writer = PdfWriter()
            entries = manifest.get("entries") or []
            cover_link_map = manifest.get("coverLinkMap")  # None unless DOCTOR_PACK_LINKED_COVER on

            def _fetch(file_path: str) -> bytes:
                # filePath is the source S3 key (relative to the records bucket).
                obj = s3.get_object(Bucket=_records_bucket(), Key=file_path)
                return obj["Body"].read()

            outcome = assemble_pack(writer, entries, _fetch, cover_link_map)
            skipped_non_pdf = outcome["skipped_non_pdf"]

            if skipped_non_pdf:
                print(f"assembled with {skipped_non_pdf} non-PDF manifest entr(ies) skipped")
            if len(writer.pages) == 0:
                # EVERY source was unreadable/non-PDF — an empty pack would be a silent lie.
                raise RuntimeError(
                    f"no PDF pages could be assembled ({skipped_non_pdf} non-PDF source(s) skipped); "
                    "the case's key documents may all be text files"
                )

            # Upload to the server-computed S3 key.
            output = io.BytesIO()
            writer.write(output)
            output.seek(0)
            s3.put_object(
                Bucket=_doctor_packs_bucket(),
                Key=pdf_s3_key,
                Body=output.getvalue(),
                ContentType="application/pdf",
            )

            _patch_doctor_pack(
                doctor_pack_id,
                {"state": "ready", "pdfS3Key": pdf_s3_key, "pageCount": len(writer.pages)},
            )
            results.append({"doctorPackId": doctor_pack_id, "state": "ready", "pages": len(writer.pages)})
        except Exception as exc:  # broad catch — every failure surfaces to the UI via state='failed'
            error_message = f"{type(exc).__name__}: {exc}"
            try:
                _patch_doctor_pack(doctor_pack_id, {"state": "failed", "errorMessage": error_message[:2000]})
            except Exception:
                print(f"double-failure: could not write failed state for {doctor_pack_id}: {exc}")
            results.append({"doctorPackId": doctor_pack_id, "state": "failed", "error": error_message})

    return {"results": results}
