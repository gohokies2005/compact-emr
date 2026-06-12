"""
Phase 7B-revised Build 3: Doctor Pack PDF assembler.

Trigger: SQS message from the API when POST /api/v1/cases/:id/doctor-pack/generate creates
a queued DoctorPack row. The message carries the doctorPackId; the worker reads the full
row + manifest from the API.

On invocation:
  1. PATCH state='generating' so the UI shows progress.
  2. GET the DoctorPack row + its manifest entries (per-file s3Key + pageRanges).
  3. For each manifest entry: pull the source PDF from S3, extract the specified page
     ranges with pypdf, and append to the output writer.
  4. Render the chart-summary cover page (from manifestJson.coverPage) as page 1 using
     WeasyPrint (HTML→PDF; ships in the layer with a Roboto fallback font).
  5. Render a TOC page 2: "Included documents: 1. Rating decision (case 2024-03-12) —
     pages 3-7 / 2. DBQ for PTSD — pages 8-9 / ...".
  6. Upload the assembled PDF to the server-computed pdfS3Key.
  7. PATCH state='ready' with pdfS3Key + pageCount. On any failure: PATCH state='failed'
     with errorMessage.

DEPLOYED via workers-stack.ts (compact-emr-<env>-doctor-pack-assembler Lambda, SQS-triggered).
Note: the WeasyPrint layer (HTML→PDF for the cover page + TOC) is attached only when
DOCTOR_PACK_WEASYPRINT_LAYER_ARN is set at synth time; without it the worker gracefully skips
cover + TOC and still produces the source-PDF concatenation (see H3 in the port audit).

A 250-page pack assembles in ~20-40 seconds; well under Lambda's 15-min ceiling.
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
    from pypdf import PdfReader, PdfWriter
    _PYPDF_IMPORT_ERROR: str | None = None
except Exception as _e:  # pragma: no cover — only fires on a broken deployment artifact
    PdfReader = PdfWriter = None  # type: ignore[assignment]
    _PYPDF_IMPORT_ERROR = f"pypdf unavailable in deployment artifact: {_e}"

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


def _fetch_doctor_pack_manifest(doctor_pack_id: str) -> dict[str, Any]:
    """Pulled via the user-facing GET — for now. Server-side: TODO add an /internal route
    that bypasses Cognito so the worker can fetch its own manifest without a user JWT."""
    # FIXME(phase7a-part3): add GET /api/v1/internal/doctor-packs/:id endpoint mirroring
    # /api/v1/cases/:caseId/doctor-pack/latest but bypassing Cognito. For now the worker
    # is invoked by SQS with the full manifest embedded in the message body (avoids the
    # round-trip).
    raise NotImplementedError("worker pulls manifest via SQS payload, not API GET (until /internal GET added)")


def _select_pages(source_pdf_bytes: bytes, page_ranges: list[dict[str, int]]) -> list:
    """Pull the specified page ranges from a source PDF, return PyPDF pages."""
    reader = PdfReader(io.BytesIO(source_pdf_bytes))
    pages = []
    for pr in page_ranges:
        # Manifest uses 1-indexed pages; PyPDF uses 0-indexed.
        from_idx = max(0, int(pr["from"]) - 1)
        to_idx = min(len(reader.pages), int(pr["to"]))
        for i in range(from_idx, to_idx):
            pages.append(reader.pages[i])
    return pages


def _render_cover_page(cover_page: dict[str, Any]) -> bytes:
    """Render the chart-summary cover page as a single-page PDF via WeasyPrint."""
    # weasyprint is imported lazily because it pulls in cairo and the lambda layer is heavy.
    from weasyprint import HTML

    vet = cover_page.get("veteran", {})
    case = cover_page.get("caseRow", {})
    sc_conditions = cover_page.get("serviceConnectedConditions", [])
    problems = cover_page.get("activeProblems", [])
    medications = cover_page.get("activeMedications", [])
    cds_verdict = cover_page.get("cdsVerdict", "")
    cds_odds = cover_page.get("cdsOddsPct")
    veteran_statement = cover_page.get("veteranStatement", "") or ""
    in_service = cover_page.get("inServiceEvent", "") or ""

    sc_list = "<br/>".join(f"&bull; {c}" for c in sc_conditions) if sc_conditions else "<em>none recorded</em>"
    prob_list = "<br/>".join(f"&bull; {p}" for p in problems) if problems else "<em>none recorded</em>"
    med_list = "<br/>".join(
        f"&bull; {m['drugName']} " + (f"({m['dose']})" if m.get('dose') else '') + (f" — {m['indication']}" if m.get('indication') else '')
        for m in medications
    ) if medications else "<em>none recorded</em>"

    html = f"""
    <html>
    <head><style>
    body {{ font-family: 'Roboto', sans-serif; color: #111827; padding: 40px; font-size: 11pt; }}
    h1 {{ color: #1f2937; border-bottom: 2px solid #6366f1; padding-bottom: 8px; }}
    h2 {{ color: #4b5563; font-size: 12pt; margin-top: 18px; margin-bottom: 6px; }}
    .case-meta {{ background: #f3f4f6; padding: 12px; border-radius: 6px; margin: 12px 0; }}
    .verdict-badge {{ display: inline-block; padding: 4px 10px; border-radius: 12px; font-weight: 600; }}
    .verdict-accept {{ background: #d1fae5; color: #065f46; }}
    .verdict-caution {{ background: #fef3c7; color: #92400e; }}
    .verdict-reject {{ background: #fee2e2; color: #991b1b; }}
    .verdict-not_yet_run {{ background: #e5e7eb; color: #374151; }}
    .small {{ font-size: 9pt; color: #6b7280; }}
    </style></head>
    <body>
      <h1>Doctor Pack — {vet.get('fullName', 'Unknown')}</h1>
      <div class="case-meta">
        <strong>Case {case.get('id', '')}</strong> · {case.get('claimedCondition', '')} ({case.get('claimType', '')})<br/>
        Framing: {case.get('framingChoice') or '<em>unset</em>'}{' · Upstream: ' + (case.get('upstreamScCondition') or '') if case.get('upstreamScCondition') else ''}<br/>
        Status: {case.get('status', '')} · CDS: <span class="verdict-badge verdict-{cds_verdict}">{cds_verdict}</span>{f' · {cds_odds:.0f}% IMO win rate' if cds_odds is not None else ''}
      </div>

      <h2>Veteran</h2>
      DOB {vet.get('dob') or 'unknown'} · {vet.get('branch', '')} {vet.get('serviceDates', '')} ·
      Combat: {vet.get('combatVeteran', '')} · PACT: {vet.get('pactArea', '')} · TERA: {vet.get('teraConceded', '')}

      <h2>Service-connected conditions</h2>{sc_list}
      <h2>Active problems</h2>{prob_list}
      <h2>Medications</h2>{med_list}

      <h2>In-service event (per intake)</h2>
      {in_service or '<em>not recorded</em>'}

      <h2>Veteran statement</h2>
      {veteran_statement or '<em>not recorded</em>'}

      <p class="small">Generated {cover_page.get('generatedAt', '')} · cover-page version {cover_page.get('version', '')}</p>
    </body>
    </html>
    """
    pdf_bytes = HTML(string=html).write_pdf()
    return pdf_bytes


def _render_toc_page(entries: list[dict[str, Any]]) -> bytes:
    """Render a table-of-contents page listing every included doc + its page range."""
    from weasyprint import HTML

    rows_html = "\n".join(
        f"<tr><td>{i + 1}</td><td>{e['filePath']}</td><td>{e['docType']}</td><td>"
        + ", ".join(f"{r['from']}–{r['to']}" for r in (e.get('pageRanges') or []))
        + f"</td><td style=\"text-align:right\">{e.get('pageCount', '')}</td></tr>"
        for i, e in enumerate(entries)
    )
    html = f"""
    <html>
    <head><style>
    body {{ font-family: 'Roboto', sans-serif; padding: 40px; font-size: 10pt; color: #111827; }}
    h1 {{ color: #1f2937; border-bottom: 2px solid #6366f1; padding-bottom: 8px; }}
    table {{ width: 100%; border-collapse: collapse; margin-top: 12px; }}
    th, td {{ padding: 6px 8px; border-bottom: 1px solid #e5e7eb; text-align: left; }}
    th {{ background: #f3f4f6; font-size: 9pt; color: #6b7280; text-transform: uppercase; letter-spacing: 0.5px; }}
    </style></head>
    <body>
      <h1>Table of contents</h1>
      <table>
        <thead><tr><th>#</th><th>File</th><th>Doc type</th><th>Pages selected</th><th style="text-align:right">Page count</th></tr></thead>
        <tbody>{rows_html}</tbody>
      </table>
    </body>
    </html>
    """
    return HTML(string=html).write_pdf()


def handler(event: dict[str, Any], _context: Any) -> dict[str, Any]:
    """SQS-triggered. The route POSTs `{doctorPackId, manifest}` to the queue."""
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

            # Cover page + TOC. Both depend on WeasyPrint (HTML -> PDF), which requires the
            # cairo/pango/gobject Lambda layer. If the layer isn't attached (e.g. staging
            # deploy without DOCTOR_PACK_WEASYPRINT_LAYER_ARN), gracefully skip both pages —
            # the core page-selected source-PDF concatenation still produces a usable pack.
            # The DoctorPack row records `coverPageSkipped: true` so the UI can flag it.
            weasyprint_available = False
            try:
                import weasyprint  # noqa: F401  (probe only)
                weasyprint_available = True
            except ImportError as imp_err:
                print(f"weasyprint not available; skipping cover + TOC ({imp_err})")

            entries = manifest.get("entries") or []

            if weasyprint_available:
                cover = manifest.get("coverPage")
                if cover:
                    try:
                        cover_bytes = _render_cover_page(cover)
                        cover_reader = PdfReader(io.BytesIO(cover_bytes))
                        for page in cover_reader.pages:
                            writer.add_page(page)
                    except Exception as cover_err:
                        print(f"cover-page render failed (continuing without): {cover_err}")

                if entries:
                    try:
                        toc_bytes = _render_toc_page(entries)
                        toc_reader = PdfReader(io.BytesIO(toc_bytes))
                        for page in toc_reader.pages:
                            writer.add_page(page)
                    except Exception as toc_err:
                        print(f"TOC render failed (continuing without): {toc_err}")

            # Source-doc page extraction
            for entry in entries:
                file_path = entry.get("filePath")
                page_ranges = entry.get("pageRanges") or []
                if not file_path:
                    # Only skip when there's no source to read. (H2: empty page_ranges does
                    # NOT mean skip — see below.)
                    continue
                # filePath is the source S3 key (relative to records bucket)
                obj = s3.get_object(Bucket=_records_bucket(), Key=file_path)
                pdf_bytes = obj["Body"].read()
                if page_ranges:
                    pages = _select_pages(pdf_bytes, page_ranges)
                else:
                    # H2 (audit 2026-05-27): per the route contract (doctor-pack.ts),
                    # empty pageRanges = include the WHOLE source PDF. The prior `continue`
                    # silently dropped every such entry, yielding a cover+TOC-only pack.
                    reader = PdfReader(io.BytesIO(pdf_bytes))
                    pages = list(reader.pages)
                for page in pages:
                    writer.add_page(page)

            # Upload to the server-computed S3 key
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
