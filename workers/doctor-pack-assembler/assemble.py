"""
Doctor Pack assembler — PURE merge + link + outline logic.

Extracted from handler.py (2026-06-27, DOCTOR_PACK_LINKED_COVER) so it can be unit-tested without
boto3 / S3 / the API: the source bytes are supplied via a `fetch_source_bytes` callable. handler.py
is the thin I/O orchestrator (S3 fetch + API PATCH); EVERYTHING about page selection, the page cap,
and the clickable-cover link/outline stamping lives here.

The cover is manifest entry #0 (a pdf-lib-rendered TOC PDF produced by the TS service). When the
manifest carries `coverLinkMap`, each content row's cover-page rectangle is turned into a PDF link
annotation pointing at that document's first merged page, and a 2-level outline (category -> doc) is
added. Link/outline stamping is FAIL-OPEN: any error logs and the pack still ships with the cover
but no links. The merge / page-append path itself never raises from link code.
"""

import io
from typing import Any, Callable

from pypdf import PdfReader, PdfWriter
from pypdf.annotations import Link

# Belt-and-suspenders page caps (Dr. Kasky 2026-06-25 — "one recently came back with HUNDREDS of
# pages"). The real page SELECTION + budget live in the TS service (doctor-pack.ts
# applyPackPageBudget); these are the LAST-LINE physical guards so a legacy manifest, a stale queued
# message, or any future path that still ships empty/huge pageRanges can never put hundreds of pages
# in front of a physician. Mirror the TS PASSTHROUGH_BOUNDED_PAGES / PACK_PAGE_HARD_CAP values.
WHOLE_DOC_FALLBACK_MAX_PAGES = 8
PACK_HARD_PAGE_CAP = 60


def select_pages(source_pdf_bytes: bytes, page_ranges: list[dict[str, int]]) -> list:
    """Pull the specified page ranges from a source PDF, return PyPDF pages. 1-indexed manifest
    pages -> 0-indexed pypdf, clamped to the source length."""
    reader = PdfReader(io.BytesIO(source_pdf_bytes))
    pages = []
    for pr in page_ranges:
        from_idx = max(0, int(pr["from"]) - 1)
        to_idx = min(len(reader.pages), int(pr["to"]))
        for i in range(from_idx, to_idx):
            pages.append(reader.pages[i])
    return pages


def assemble_pack(
    writer: PdfWriter,
    entries: list[dict[str, Any]],
    fetch_source_bytes: Callable[[str], bytes],
    cover_link_map: list[dict[str, Any]] | None = None,
) -> dict[str, Any]:
    """Merge every manifest entry's selected pages into `writer`, in manifest order. The cover is
    entry #0 (merged first). Returns {entry_start_page, skipped_non_pdf, skipped_unreadable_pdf}.

    entry_start_page[i] = the writer page index at which entry i's pages BEGIN (captured BEFORE the
    entry is appended, so it reflects the cover pages, the whole-doc clamp, and the hard cap). It is
    the load-bearing offset the cover links point at.

    UNREADABLE-PDF entries (live finding 2026-07, Kimbrough: an AES-encrypted source raised
    DependencyError and the WHOLE pack failed) are skipped-not-fatal per the FRN no-halt-on-
    unreadable-files rule: the entry is logged + counted and the merge continues. A skipped entry
    contributes ZERO pages, so its start index EQUALS the next entry's start — its cover-link row
    and outline child are DROPPED (see skipped_entry_indices) or the link would point at the wrong
    document.
    """
    entry_start_page: list[int] = []
    skipped_non_pdf = 0
    skipped_unreadable_pdf = 0
    skipped_entry_indices: set[int] = set()

    for entry_idx, entry in enumerate(entries):
        # Capture the start offset BEFORE appending — this reflects everything merged so far
        # (cover pages + prior entries + any clamping / hard-cap drops).
        entry_start_page.append(len(writer.pages))

        file_path = entry.get("filePath")
        page_ranges = entry.get("pageRanges") or []
        if not file_path:
            # Only skip when there's no source to read. (Empty page_ranges does NOT mean skip.)
            # Record the skip index like every other skip path — otherwise this entry's cover link /
            # outline row would resolve to the FOLLOWING document (same off-by-one as the non-PDF path).
            skipped_entry_indices.add(entry_idx)
            continue

        # UNREADABLE-SOURCE ISOLATION: everything that touches the source bytes (fetch + PdfReader
        # + page selection + append) is per-entry fail-open. An encrypted PDF (pypdf DependencyError
        # without a crypto provider — now vendored, but belt-and-braces), a corrupt body behind a
        # valid %PDF- header, or a fetch error skips THIS entry only; the rest of the pack ships.
        try:
            pdf_bytes = fetch_source_bytes(file_path)
            # NON-PDF sources (live finding 2026-06-12, Perez): the key-docs selector can include
            # .txt/.docx records, but this assembler merges PDFs only — pypdf dies on a bad header and
            # the WHOLE pack used to fail. Skip the non-PDF entry (logged, count only) and keep going.
            if not pdf_bytes.lstrip()[:5].startswith(b"%PDF-"):
                skipped_non_pdf += 1
                skipped_entry_indices.add(entry_idx)
                print(f"skipping non-PDF manifest entry ({len(pdf_bytes)} bytes)")
                continue

            if page_ranges:
                pages = select_pages(pdf_bytes, page_ranges)
            else:
                # Per the route contract, empty pageRanges = include the WHOLE source PDF, but bound it
                # (a 300-page bundle is the exact failure mode the cap exists for).
                reader = PdfReader(io.BytesIO(pdf_bytes))
                all_pages = list(reader.pages)
                pages = all_pages[:WHOLE_DOC_FALLBACK_MAX_PAGES]
                if len(all_pages) > WHOLE_DOC_FALLBACK_MAX_PAGES:
                    print(
                        f"whole-doc passthrough {file_path}: bounded {len(all_pages)} -> "
                        f"{WHOLE_DOC_FALLBACK_MAX_PAGES} pages (empty pageRanges fallback cap)"
                    )

            # Absolute pack cap: never add a page once the writer is at the hard cap. The cover +
            # earliest (highest-priority) entries are added first, so trailing pages drop.
            for page in pages:
                if len(writer.pages) >= PACK_HARD_PAGE_CAP:
                    print(
                        f"pack hard cap {PACK_HARD_PAGE_CAP} reached; dropping remaining pages "
                        f"of {file_path} and any later entries"
                    )
                    break
                writer.add_page(page)
        except Exception as entry_err:  # noqa: BLE001 — isolate the entry, never the pack
            skipped_unreadable_pdf += 1
            skipped_entry_indices.add(entry_idx)
            print(
                f"skipping unreadable PDF manifest entry {file_path} "
                f"({type(entry_err).__name__}: {entry_err})"
            )
            continue

    # DOCTOR_PACK_LINKED_COVER: stamp clickable links + a 2-level outline. FAIL-OPEN — the pack
    # already has all its pages; a link/outline error must never fail the assembly.
    if cover_link_map:
        try:
            _stamp_cover_links_and_outline(
                writer, cover_link_map, entry_start_page, skipped_entry_indices
            )
        except Exception as link_err:  # pragma: no cover — defensive; pack ships without links
            print(f"cover link/outline stamping failed (pack ships without links): {link_err}")

    return {
        "entry_start_page": entry_start_page,
        "skipped_non_pdf": skipped_non_pdf,
        "skipped_unreadable_pdf": skipped_unreadable_pdf,
    }


def _stamp_cover_links_and_outline(
    writer: PdfWriter,
    cover_link_map: list[dict[str, Any]],
    entry_start_page: list[int],
    skipped_entry_indices: set[int] | None = None,
) -> None:
    """Add one /Link per content row (cover rect -> the document's first merged page) and a 2-level
    outline (category node -> doc child). entryIndex is the MANIFEST entry index (cover is #0).

    Rows whose entry was SKIPPED during the merge are dropped entirely: a skipped entry contributed
    zero pages, so its captured start index equals the NEXT entry's start — stamping it would link
    the cover row (and its outline child) at the wrong document."""
    n_pages = len(writer.pages)
    if n_pages == 0:
        return
    skipped = skipped_entry_indices or set()

    def _row_entry_index(row: dict[str, Any]) -> int | None:
        try:
            ei = int(row.get("entryIndex", -1))
        except (TypeError, ValueError):
            return None
        return ei

    cover_link_map = [
        row for row in cover_link_map
        if not (isinstance(row, dict) and _row_entry_index(row) in skipped)
    ]

    # --- Links ---
    for row in cover_link_map:
        try:
            entry_index = int(row.get("entryIndex", -1))
        except (TypeError, ValueError):
            continue
        if entry_index < 0 or entry_index >= len(entry_start_page):
            continue
        target = entry_start_page[entry_index]
        if target < 0 or target >= n_pages:
            continue
        cover_page_index = int(row.get("coverPageIndex", 0) or 0)
        if cover_page_index < 0 or cover_page_index >= n_pages:
            continue
        rect = row.get("rect")
        if not rect or len(rect) != 4:
            continue
        try:
            rect_tuple = tuple(float(v) for v in rect)
        except (TypeError, ValueError):
            continue
        link = Link(rect=rect_tuple, target_page_index=target)
        writer.add_annotation(page_number=cover_page_index, annotation=link)

    # --- Outline (2-level): category parent -> doc children, preserving manifest order ---
    grouped: dict[str, list[dict[str, Any]]] = {}
    order: list[str] = []
    for row in cover_link_map:
        cat = str(row.get("category", "other"))
        if cat not in grouped:
            grouped[cat] = []
            order.append(cat)
        grouped[cat].append(row)

    for cat in order:
        rows = grouped[cat]
        first = rows[0]
        try:
            first_ei = int(first.get("entryIndex", -1))
        except (TypeError, ValueError):
            continue
        if first_ei < 0 or first_ei >= len(entry_start_page):
            continue
        parent_page = max(0, min(entry_start_page[first_ei], n_pages - 1))
        parent_title = str(first.get("categoryLabel") or cat)
        parent_node = writer.add_outline_item(parent_title, parent_page)
        for row in rows:
            try:
                ei = int(row.get("entryIndex", -1))
            except (TypeError, ValueError):
                continue
            if ei < 0 or ei >= len(entry_start_page):
                continue
            child_page = max(0, min(entry_start_page[ei], n_pages - 1))
            child_title = str(row.get("label") or "Document")
            writer.add_outline_item(child_title, child_page, parent=parent_node)
