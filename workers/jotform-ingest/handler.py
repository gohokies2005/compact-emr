"""
Jotform intake-ingest worker.

Trigger: SQS message {intakeId, formId, submissionId} published by the webhook doorbell
(POST /api/v1/jotform/webhook/:secret). The webhook returns 200 instantly; this worker does the
slow work so Jotform never times out.

On invocation, per message:
  1. Fetch the authoritative submission BY ID from the Jotform HIPAA API (APIKEY header).
  2. Parse the answers heuristically (name/email/phone/state/condition/dob) + collect file URLs.
  3. Download each uploaded file (APIKEY auth) and stream it to S3 under intake/<intakeId>/.
  4. PATCH /internal/intakes/:id with status=ready + parsed fields + the file manifest
     (the worker is the SOLE writer of these — spec §2/P1-6). On any failure: status=failed
     + errorMessage (surfaced in the pool with a Retry button — never a silent drop).

See docs/JOTFORM_INTAKE_INGESTION_SPEC.md. Deployed via workers-stack.ts
(compact-emr-<env>-jotform-ingest Lambda, SQS-triggered).

NOTE (v1): the "Intake Summary PDF" (rendering the Q&A into a chart document) is a planned
fast-follow — it needs a PDF lib bundled into the Lambda. v1 captures the answers in the Intake
row (rawAnswers) so nothing is lost; the PDF is layered on next.
"""

import json
import os
import re
import urllib.parse
import urllib.request
from typing import Any

import boto3

s3 = boto3.client("s3")

JOTFORM_BASE = os.environ.get("JOTFORM_API_BASE", "https://hipaa-api.jotform.com").rstrip("/")
MAX_FILE_BYTES = 50 * 1024 * 1024


def _api_base_url() -> str:
    return os.environ["COMPACT_EMR_API_URL"].rstrip("/")


def _worker_token() -> str:
    return os.environ["INTERNAL_WORKER_TOKEN"]


def _phi_bucket() -> str:
    return os.environ["RECORDS_BUCKET"]


def _jotform_api_key() -> str:
    return os.environ["JOTFORM_API_KEY"]


def _patch_intake(intake_id: str, body: dict[str, Any]) -> None:
    url = f"{_api_base_url()}/api/v1/internal/intakes/{urllib.parse.quote(intake_id)}"
    req = urllib.request.Request(
        url,
        data=json.dumps(body).encode("utf-8"),
        method="PATCH",
        headers={"Content-Type": "application/json", "X-Internal-Worker-Token": _worker_token()},
    )
    with urllib.request.urlopen(req, timeout=30) as response:
        if response.status >= 300:
            raise RuntimeError(f"API rejected intake PATCH: {response.status}")


def _jotform_get(path: str) -> dict[str, Any]:
    url = f"{JOTFORM_BASE}/{path.lstrip('/')}"
    req = urllib.request.Request(url, headers={"APIKEY": _jotform_api_key()})
    with urllib.request.urlopen(req, timeout=30) as response:
        return json.loads(response.read().decode("utf-8"))


def _download(url: str) -> bytes:
    # Jotform HIPAA file URLs need the APIKEY to authorize the download. The path can contain spaces
    # / commas (the original filename), which urllib rejects ("URL can't contain control characters")
    # — encode the path before requesting.
    parts = urllib.parse.urlsplit(url)
    safe_url = urllib.parse.urlunsplit((parts.scheme, parts.netloc, urllib.parse.quote(parts.path), parts.query, parts.fragment))
    req = urllib.request.Request(safe_url, headers={"APIKEY": _jotform_api_key()})
    with urllib.request.urlopen(req, timeout=120) as response:
        data = response.read(MAX_FILE_BYTES + 1)
    if len(data) > MAX_FILE_BYTES:
        raise RuntimeError("file exceeds 50 MB")
    return data


_CT_BY_EXT = {
    "pdf": "application/pdf", "jpg": "image/jpeg", "jpeg": "image/jpeg", "png": "image/png",
    "doc": "application/msword",
    "docx": "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
}


def _filename_from_url(url: str) -> str:
    name = urllib.parse.unquote(urllib.parse.urlparse(url).path.rsplit("/", 1)[-1]) or "file"
    return re.sub(r"[^A-Za-z0-9._-]", "_", name)[:200]


def _content_type(name: str) -> str:
    ext = name.rsplit(".", 1)[-1].lower() if "." in name else ""
    return _CT_BY_EXT.get(ext, "application/octet-stream")


_MONTHS = {m.lower(): i for i, m in enumerate(
    ["January", "February", "March", "April", "May", "June",
     "July", "August", "September", "October", "November", "December"], 1)}
_MONTHS_ABBR = {m[:3]: i for m, i in _MONTHS.items()}


def _iso_date(year: Any, month: Any, day: Any) -> str | None:
    """Build a strict ISO YYYY-MM-DD (what an <input type=date> needs), or None if implausible."""
    try:
        y = int(str(year).strip())
        d = int(str(day).strip())
        ms = str(month).strip().lower()
        mm = int(ms) if ms.isdigit() else (_MONTHS.get(ms) or _MONTHS_ABBR.get(ms[:3]) or 0)
        if not (1 <= mm <= 12) or not (1 <= d <= 31) or not (1900 <= y <= 2100):
            return None
        return f"{y:04d}-{mm:02d}-{d:02d}"
    except (TypeError, ValueError):
        return None


def _normalize_dob(answer: Any, pretty: Any) -> str | None:
    """Jotform birthdate/date answers come as a dict {month,day,year} or assorted strings — coerce to
    ISO so the assign drawer prefills the DOB and the RN never has to look it up in Jotform."""
    if isinstance(answer, dict):
        iso = _iso_date(answer.get("year"), answer.get("month"), answer.get("day"))
        if iso:
            return iso
    for s in (answer if isinstance(answer, str) else None, pretty if isinstance(pretty, str) else None):
        if not s:
            continue
        s = s.strip()
        m = re.match(r"^(\d{4})[-/](\d{1,2})[-/](\d{1,2})$", s)  # ISO-ish
        if m and (iso := _iso_date(m.group(1), m.group(2), m.group(3))):
            return iso
        m = re.match(r"^(\d{1,2})[-/](\d{1,2})[-/](\d{4})$", s)  # US MM/DD/YYYY
        if m and (iso := _iso_date(m.group(3), m.group(1), m.group(2))):
            return iso
        m = re.match(r"^([A-Za-z]+)\.?\s+(\d{1,2}),?\s+(\d{4})$", s)  # Month DD, YYYY
        if m and (iso := _iso_date(m.group(3), m.group(1), m.group(2))):
            return iso
    return None


def _normalize_claim_type(s: Any) -> str | None:
    """Map a free-text claim-type answer to the EMR enum (initial|supplemental|hlr|appeal)."""
    if not isinstance(s, str):
        return None
    t = s.strip().lower()
    if not t:
        return None
    if "supplement" in t:
        return "supplemental"
    if "higher" in t or t == "hlr":
        return "hlr"
    if "appeal" in t or "disagree" in t or t == "nod" or "board" in t:
        return "appeal"
    if "initial" in t or "original" in t or "new" in t or "first" in t:
        return "initial"
    return None


def _parse_submission(content: dict[str, Any]) -> dict[str, Any]:
    """Heuristically pull the fields we surface in the pool + collect uploaded-file URLs. Defensive:
    forms vary across 59 templates, so match on Jotform field TYPE first, then on the field name."""
    answers = content.get("answers", {}) or {}
    parsed: dict[str, Any] = {"name": None, "email": None, "phone": None, "state": None, "condition": None, "dob": None, "claim_type": None}
    file_urls: list[str] = []

    for _qid, a in answers.items():
        if not isinstance(a, dict):
            continue
        a_type = (a.get("type") or "").lower()
        a_name = (a.get("name") or "").lower()
        text = (a.get("text") or "").lower()
        ans = a.get("answer")

        if a_type == "control_fileupload" or "upload" in a_type:
            if isinstance(ans, list):
                file_urls.extend([u for u in ans if isinstance(u, str) and u.startswith("http")])
            elif isinstance(ans, str) and ans.startswith("http"):
                file_urls.append(ans)
            continue
        if a_type == "control_fullname" and isinstance(ans, dict):
            parsed["name"] = " ".join(str(v) for v in [ans.get("first"), ans.get("last")] if v).strip() or parsed["name"]
            continue
        if a_type == "control_email" and isinstance(ans, str):
            parsed["email"] = parsed["email"] or ans
            continue
        if a_type == "control_phone":
            parsed["phone"] = parsed["phone"] or (a.get("prettyFormat") or (ans if isinstance(ans, str) else None))
            continue
        if a_type in ("control_datetime", "control_birthdate") or "dob" in a_name or "birth" in (a_name + text):
            parsed["dob"] = parsed["dob"] or _normalize_dob(ans, a.get("prettyFormat"))
            continue
        # name/state/condition/claim-type by field name/label when not typed above
        if parsed["name"] is None and ("name" in a_name or "name" in text) and isinstance(ans, str):
            parsed["name"] = ans
        if "state" in (a_name + " " + text) and isinstance(ans, str) and len(ans) <= 20:
            parsed["state"] = parsed["state"] or ans
        if "condition" in (a_name + " " + text) and isinstance(ans, str):
            parsed["condition"] = parsed["condition"] or ans
        if parsed["claim_type"] is None and "claim" in (a_name + " " + text) and "type" in (a_name + " " + text):
            parsed["claim_type"] = _normalize_claim_type(ans if isinstance(ans, str) else a.get("prettyFormat"))
        if parsed["email"] is None and isinstance(ans, str) and "@" in ans and "." in ans:
            parsed["email"] = ans

    # Normalize a 2-letter state if a full name slipped in is left as-is (the EMR truncates to 2).
    return {"parsed": parsed, "file_urls": file_urls}


def _ingest_one(intake_id: str, submission_id: str) -> None:
    sub = _jotform_get(f"submission/{urllib.parse.quote(submission_id)}")
    content = sub.get("content", {}) or {}
    out = _parse_submission(content)
    parsed, file_urls = out["parsed"], out["file_urls"]

    manifest: list[dict[str, Any]] = []
    bucket = _phi_bucket()
    for url in file_urls:
        name = _filename_from_url(url)
        ct = _content_type(name)
        data = _download(url)
        key = f"intake/{intake_id}/{name}"
        s3.put_object(Bucket=bucket, Key=key, Body=data, ContentType=ct, ServerSideEncryption="aws:kms")
        manifest.append({"name": name, "s3Key": key, "contentType": ct, "sizeBytes": len(data)})

    body: dict[str, Any] = {
        "status": "ready",
        "fileManifest": manifest,
        "rawAnswers": content.get("answers", {}),
    }
    if parsed.get("name"):
        body["submittedName"] = parsed["name"]
    if parsed.get("email"):
        body["submittedEmail"] = parsed["email"]
    if parsed.get("phone"):
        body["submittedPhone"] = parsed["phone"]
    if parsed.get("state"):
        body["submittedState"] = parsed["state"]
    if parsed.get("condition"):
        body["submittedCondition"] = parsed["condition"]
    if parsed.get("dob"):
        body["submittedDob"] = parsed["dob"]
    if parsed.get("claim_type"):
        body["submittedClaimType"] = parsed["claim_type"]
    # Form title → drives the stage label + assign defaults in the pool (robust to unknown form IDs).
    form_id = content.get("form_id")
    if form_id:
        try:
            form = _jotform_get(f"form/{urllib.parse.quote(str(form_id))}")
            title = (form.get("content", {}) or {}).get("title")
            if isinstance(title, str) and title.strip():
                body["submittedFormTitle"] = title.strip()
        except Exception:  # noqa: BLE001 — title is best-effort; never fail the ingest over it
            pass
    created = sub.get("created_at")
    if isinstance(created, str):
        body["submittedAt"] = created.replace(" ", "T") + ("Z" if "Z" not in created else "")
    _patch_intake(intake_id, body)
    print(json.dumps({"msg": "jotform-ingest: ready", "intakeId": intake_id, "files": len(manifest)}))


def handler(event: dict[str, Any], _context: Any = None) -> dict[str, Any]:
    for record in event.get("Records", []):
        try:
            msg = json.loads(record.get("body", "{}"))
        except json.JSONDecodeError:
            print(json.dumps({"msg": "jotform-ingest: bad SQS body", "body": record.get("body")}))
            continue
        intake_id = msg.get("intakeId")
        submission_id = msg.get("submissionId")
        if not intake_id or not submission_id:
            print(json.dumps({"msg": "jotform-ingest: missing ids", "msgBody": msg}))
            continue
        try:
            _ingest_one(intake_id, submission_id)
        except Exception as exc:  # noqa: BLE001 — surface the reason, never a silent drop
            reason = f"{type(exc).__name__}: {exc}"
            print(json.dumps({"msg": "jotform-ingest: FAILED", "intakeId": intake_id, "error": reason}))
            try:
                _patch_intake(intake_id, {"status": "failed", "errorMessage": reason})
            except Exception as patch_exc:  # noqa: BLE001
                print(json.dumps({"msg": "jotform-ingest: failed-callback also failed", "intakeId": intake_id, "error": str(patch_exc)}))
    return {"ok": True}
