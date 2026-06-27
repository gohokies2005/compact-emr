"""
Pytest for the Doctor Pack assembler merge + linked-cover (DOCTOR_PACK_LINKED_COVER, 2026-06-27).

Pure: builds synthetic multi-page source PDFs in-test and merges them via assemble.assemble_pack
with a dict-backed fetch (no boto3 / S3 / API). Asserts the load-bearing offset
(entry_start_page) under a forced range clamp + the 60-page hard cap, the cover /Link annotations
and their resolved destinations, the 2-level outline, and fail-open when the link-map is absent or
malformed.
"""

import io

import pytest
from pypdf import PdfReader, PdfWriter

from assemble import PACK_HARD_PAGE_CAP, assemble_pack


def make_pdf(n: int) -> bytes:
    """An n-page PDF (blank Letter-ish pages); valid '%PDF-' bytes for the assembler's header check."""
    w = PdfWriter()
    for _ in range(n):
        w.add_blank_page(width=612, height=792)
    buf = io.BytesIO()
    w.write(buf)
    return buf.getvalue()


def fetch_from(sources: dict[str, bytes]):
    def _fetch(file_path: str) -> bytes:
        return sources[file_path]
    return _fetch


# ---------------------------------------------------------------------------------------------------
# entry_start_page reflects the cover, a forced range clamp, and the 60-page hard cap.
# ---------------------------------------------------------------------------------------------------

def test_entry_start_page_with_clamp_and_cap():
    # cover=1pg; entry1 asks for 5 pages but the source has only 3 (clamp -> 3); entry2 = 2 pages;
    # entry3 asks for 100 pages -> the 60-cap stops it.
    sources = {
        "cover.pdf": make_pdf(1),
        "doc1.pdf": make_pdf(3),
        "doc2.pdf": make_pdf(2),
        "doc3.pdf": make_pdf(100),
    }
    entries = [
        {"filePath": "cover.pdf", "pageRanges": [{"from": 1, "to": 1}]},
        {"filePath": "doc1.pdf", "pageRanges": [{"from": 1, "to": 5}]},  # clamps to 3
        {"filePath": "doc2.pdf", "pageRanges": [{"from": 1, "to": 2}]},
        {"filePath": "doc3.pdf", "pageRanges": [{"from": 1, "to": 100}]},  # hits the cap
    ]
    writer = PdfWriter()
    outcome = assemble_pack(writer, entries, fetch_from(sources))

    # cover starts at 0; doc1 at 1; doc2 at 1+3=4; doc3 at 4+2=6.
    assert outcome["entry_start_page"] == [0, 1, 4, 6]
    # cover(1) + doc1(3) + doc2(2) + doc3 fills to the cap.
    assert len(writer.pages) == PACK_HARD_PAGE_CAP
    assert outcome["skipped_non_pdf"] == 0


def test_non_pdf_source_is_skipped_not_fatal():
    sources = {"cover.pdf": make_pdf(1), "note.txt": b"this is a text file, not a pdf"}
    entries = [
        {"filePath": "cover.pdf", "pageRanges": [{"from": 1, "to": 1}]},
        {"filePath": "note.txt", "pageRanges": [{"from": 1, "to": 1}]},
    ]
    writer = PdfWriter()
    outcome = assemble_pack(writer, entries, fetch_from(sources))
    assert outcome["skipped_non_pdf"] == 1
    assert len(writer.pages) == 1  # only the cover


# ---------------------------------------------------------------------------------------------------
# Cover links: one /Link per content row, each resolving to the document's first merged page.
# ---------------------------------------------------------------------------------------------------

def _link_annots(page) -> list:
    annots = page.get("/Annots")
    if annots is None:
        return []
    out = []
    for ref in annots:
        obj = ref.get_object()
        if obj.get("/Subtype") == "/Link":
            out.append(obj)
    return out


def _dest_target_index(writer: PdfWriter, annot) -> int:
    """Resolve a /Link annotation's destination to a writer page index, tolerant of pypdf storing it
    either as a bare page number or as an indirect page reference."""
    dest = annot.get("/Dest")
    assert dest is not None, "link annotation has no /Dest"
    first = dest[0]
    try:
        return int(first)
    except (TypeError, ValueError):
        target = first.get_object()
        for idx, pg in enumerate(writer.pages):
            ref = pg.indirect_reference
            if ref is not None and target.indirect_reference is not None and ref.idnum == target.indirect_reference.idnum:
                return idx
        return -1


def _build_with_links():
    sources = {
        "cover.pdf": make_pdf(1),
        "doc1.pdf": make_pdf(3),
        "doc2.pdf": make_pdf(2),
    }
    entries = [
        {"filePath": "cover.pdf", "pageRanges": [{"from": 1, "to": 1}]},
        {"filePath": "doc1.pdf", "pageRanges": [{"from": 1, "to": 3}]},
        {"filePath": "doc2.pdf", "pageRanges": [{"from": 1, "to": 2}]},
    ]
    cover_link_map = [
        {"entryIndex": 1, "coverPageIndex": 0, "rect": [72, 700, 540, 716], "category": "clinical", "categoryLabel": "CLINICAL", "label": "Office visit note"},
        {"entryIndex": 2, "coverPageIndex": 0, "rect": [72, 680, 540, 696], "category": "sc_proof", "categoryLabel": "SERVICE-CONNECTION PROOF", "label": "VA rating decision"},
    ]
    writer = PdfWriter()
    outcome = assemble_pack(writer, entries, fetch_from(sources), cover_link_map)
    return writer, outcome, cover_link_map


def test_cover_has_one_link_per_row_targeting_entry_start_page():
    writer, outcome, cover_link_map = _build_with_links()
    esp = outcome["entry_start_page"]
    assert esp == [0, 1, 4]  # cover, doc1, doc2

    links = _link_annots(writer.pages[0])
    assert len(links) == len(cover_link_map) == 2

    targets = sorted(_dest_target_index(writer, a) for a in links)
    # doc1 starts at page 1, doc2 at page 4.
    assert targets == [esp[1], esp[2]] == [1, 4]


def test_outline_two_level_destinations():
    writer, outcome, _ = _build_with_links()
    buf = io.BytesIO()
    writer.write(buf)
    buf.seek(0)
    reader = PdfReader(buf)

    outline = reader.outline
    # Two category parents, each followed by a nested child list.
    parents = [node for node in outline if not isinstance(node, list)]
    children_lists = [node for node in outline if isinstance(node, list)]
    titles = [str(p.title) for p in parents]
    assert "CLINICAL" in titles
    assert "SERVICE-CONNECTION PROOF" in titles
    assert len(children_lists) == 2

    # Each parent points at its category's first doc page (doc1=1, doc2=4).
    pages = {str(p.title): reader.get_destination_page_number(p) for p in parents}
    assert pages["CLINICAL"] == 1
    assert pages["SERVICE-CONNECTION PROOF"] == 4


# ---------------------------------------------------------------------------------------------------
# Fail-open: absent or malformed link-map => pack assembles, cover present, zero links, no exception.
# ---------------------------------------------------------------------------------------------------

def test_no_link_map_means_no_links_and_today_behavior():
    sources = {"cover.pdf": make_pdf(1), "doc1.pdf": make_pdf(3)}
    entries = [
        {"filePath": "cover.pdf", "pageRanges": [{"from": 1, "to": 1}]},
        {"filePath": "doc1.pdf", "pageRanges": [{"from": 1, "to": 3}]},
    ]
    writer = PdfWriter()
    outcome = assemble_pack(writer, entries, fetch_from(sources), None)
    assert len(writer.pages) == 4
    assert outcome["entry_start_page"] == [0, 1]
    assert _link_annots(writer.pages[0]) == []


def test_malformed_link_map_fails_open():
    sources = {"cover.pdf": make_pdf(1), "doc1.pdf": make_pdf(3)}
    entries = [
        {"filePath": "cover.pdf", "pageRanges": [{"from": 1, "to": 1}]},
        {"filePath": "doc1.pdf", "pageRanges": [{"from": 1, "to": 3}]},
    ]
    bad_maps = [
        [{"entryIndex": 99, "coverPageIndex": 0, "rect": [1, 2, 3, 4], "category": "clinical", "categoryLabel": "CLINICAL", "label": "x"}],  # out-of-range entryIndex
        [{"entryIndex": 1, "coverPageIndex": 0, "rect": [1, 2], "category": "clinical", "categoryLabel": "CLINICAL", "label": "x"}],  # bad rect
        [{"entryIndex": 1, "coverPageIndex": 7, "rect": [1, 2, 3, 4], "category": "clinical", "categoryLabel": "CLINICAL", "label": "x"}],  # cover page out of range
    ]
    for bad in bad_maps:
        writer = PdfWriter()
        # Must NOT raise.
        outcome = assemble_pack(writer, entries, fetch_from(sources), bad)
        assert len(writer.pages) == 4  # pack still fully assembled
        # No valid links stamped from a malformed map.
        assert _link_annots(writer.pages[0]) == []
        assert outcome["entry_start_page"] == [0, 1]


if __name__ == "__main__":
    raise SystemExit(pytest.main([__file__, "-v"]))
