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
from pypdf._crypt_providers import crypt_provider

from assemble import PACK_HARD_PAGE_CAP, assemble_pack

# True when a real crypto provider (cryptography / pycryptodome) is importable locally. The VENDORED
# Crypto/ in this dir is manylinux (Lambda) — it cannot import on Windows/mac, so local runs need
# e.g. `pip install cryptography` for the encrypted-PDF test; it skips otherwise.
CRYPTO_AVAILABLE = crypt_provider[0] != "local_crypt_fallback"


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
    assert outcome["skipped_unreadable_pdf"] == 0
    assert len(writer.pages) == 1  # only the cover


# ---------------------------------------------------------------------------------------------------
# Unreadable-PDF isolation (Kimbrough class, 2026-07): a source whose PdfReader raises — encrypted
# without a crypto provider, corrupt body behind a valid %PDF- header — is skipped-not-fatal. Later
# entries still merge, the counter increments, and the skipped entry's cover link/outline child is
# DROPPED (its start index equals the NEXT entry's start, so a stamped link would hit the wrong doc).
# ---------------------------------------------------------------------------------------------------

def test_unreadable_pdf_entry_skipped_later_entries_still_merge():
    # Valid %PDF- header (passes the non-PDF sniff) but garbage body -> PdfReader raises.
    corrupt = b"%PDF-1.7 this is not really a pdf body, no xref, no EOF"
    sources = {
        "cover.pdf": make_pdf(1),
        "corrupt.pdf": corrupt,
        "doc2.pdf": make_pdf(2),
    }
    entries = [
        {"filePath": "cover.pdf", "pageRanges": [{"from": 1, "to": 1}]},
        {"filePath": "corrupt.pdf", "pageRanges": [{"from": 1, "to": 3}]},
        {"filePath": "doc2.pdf", "pageRanges": [{"from": 1, "to": 2}]},
    ]
    cover_link_map = [
        {"entryIndex": 1, "coverPageIndex": 0, "rect": [72, 700, 540, 716], "category": "clinical", "categoryLabel": "CLINICAL", "label": "Corrupt record"},
        {"entryIndex": 2, "coverPageIndex": 0, "rect": [72, 680, 540, 696], "category": "sc_proof", "categoryLabel": "SERVICE-CONNECTION PROOF", "label": "VA rating decision"},
    ]
    writer = PdfWriter()
    outcome = assemble_pack(writer, entries, fetch_from(sources), cover_link_map)

    # The corrupt entry contributed zero pages: cover(1) + doc2(2).
    assert outcome["skipped_unreadable_pdf"] == 1
    assert outcome["skipped_non_pdf"] == 0
    assert len(writer.pages) == 3
    # Skipped entry's start index EQUALS the next entry's start (captured before append).
    assert outcome["entry_start_page"] == [0, 1, 1]

    # Exactly ONE link survives (the skipped entry's row is dropped) and it lands on doc2's first
    # merged page — NOT on a page belonging to another document.
    links = _link_annots(writer.pages[0])
    assert len(links) == 1
    assert _dest_target_index(writer, links[0]) == 1  # doc2 starts right after the 1-page cover

    # Outline: the skipped entry's category/child is gone; doc2's parent points at page 1.
    buf = io.BytesIO()
    writer.write(buf)
    buf.seek(0)
    reader = PdfReader(buf)
    parents = [node for node in reader.outline if not isinstance(node, list)]
    titles = [str(p.title) for p in parents]
    assert "SERVICE-CONNECTION PROOF" in titles
    assert "CLINICAL" not in titles
    assert reader.get_destination_page_number(parents[titles.index("SERVICE-CONNECTION PROOF")]) == 1


@pytest.mark.skipif(not CRYPTO_AVAILABLE, reason="no local crypto provider (pip install cryptography)")
def test_encrypted_empty_password_pdf_merges_normally():
    """The Kimbrough source itself: an AES-encrypted PDF with an EMPTY user password (how VA docs
    commonly ship). With a crypto provider vendored, pypdf's automatic empty-password decrypt makes
    it merge like any other source — no skip, no failure."""
    enc_writer = PdfWriter()
    for _ in range(2):
        enc_writer.add_blank_page(width=612, height=792)
    enc_writer.encrypt("", algorithm="AES-256")
    buf = io.BytesIO()
    enc_writer.write(buf)
    encrypted_bytes = buf.getvalue()
    assert PdfReader(io.BytesIO(encrypted_bytes)).is_encrypted

    sources = {"cover.pdf": make_pdf(1), "encrypted.pdf": encrypted_bytes}
    entries = [
        {"filePath": "cover.pdf", "pageRanges": [{"from": 1, "to": 1}]},
        {"filePath": "encrypted.pdf", "pageRanges": [{"from": 1, "to": 2}]},
    ]
    writer = PdfWriter()
    outcome = assemble_pack(writer, entries, fetch_from(sources))
    assert outcome["skipped_unreadable_pdf"] == 0
    assert outcome["skipped_non_pdf"] == 0
    assert len(writer.pages) == 3  # cover + both encrypted pages
    assert outcome["entry_start_page"] == [0, 1]


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
