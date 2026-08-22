#!/usr/bin/env python
"""Extracts material/dimension/color/component/manufacturer/countryOfOrigin
CANDIDATES for one draft's job folder, using raw_json, the original HTML
text, and OCR over the original supplier detail-slice images (in that
priority order). Never guesses: a field stays null/empty with confidence 0
unless something in the source text literally says so.

This worker never touches PostgreSQL and never calls the Coupang API --
it only reads files under --job-dir and prints one JSON object to stdout.
Everything else (stderr) is diagnostic logging only.

Usage:
  python analyze_product.py --job-dir <path> [--lang kor+eng]
    [--tesseract-cmd <path>] [--tessdata-prefix <path>]
"""
import argparse
import json
import os
import re
import sys

# Windows' default console codepage is not UTF-8, so without this, printing
# Korean text to stdout/stderr silently mangles it (mojibake) rather than
# raising -- this must run before any Korean text is written anywhere.
sys.stdout.reconfigure(encoding="utf-8")
sys.stderr.reconfigure(encoding="utf-8")

from process_images import check_tesseract_available, ocr_image

MATERIAL_KEYWORDS = [
    "아크릴", "벨벳", "스테인리스", "플라스틱", "원목", "목재", "유리", "가죽",
    "인조가죽", "실리콘", "금속", "세라믹", "종이", "폴리에스터", "면", "합성수지",
    "MDF", "알루미늄", "스틸", "패브릭", "우레탄", "PVC", "ABS",
]
COLOR_KEYWORDS = [
    "베이지", "그레이", "블랙", "화이트", "아이보리", "브라운", "네이비", "핑크",
    "레드", "블루", "그린", "옐로우", "실버", "골드", "카키", "와인", "투명",
    "민트", "퍼플", "오렌지", "라이트그레이", "다크그레이",
]
COMPONENT_KEYWORDS = [
    "서랍", "손잡이", "칸막이", "트레이", "거울", "잠금장치", "포장", "구성품",
    "세트", "받침대", "커버", "뚜껑", "고리", "홈",
]
DIMENSION_PATTERN = re.compile(
    r"(\d+(?:\.\d+)?)\s*(?:cm|CM)?\s*[xX×]\s*(\d+(?:\.\d+)?)\s*(?:cm|CM)?\s*[xX×]\s*(\d+(?:\.\d+)?)\s*(cm|mm|CM|MM)"
)
UNIT_NUMBER_PATTERN = re.compile(r"\d+(?:\.\d+)?\s*(?:cm|mm|g|kg|ml|L|리터|그램)")
MANUFACTURER_LABEL_PATTERN = re.compile(r"제조자\s*[:：]?\s*([^\s,、]{2,20})")
COUNTRY_LABEL_PATTERN = re.compile(r"(제조국|원산지)\s*[:：]?\s*([^\s,、]{2,20})")
PRECAUTION_LINE_PATTERN = re.compile(r".*(오차|주의사항|주의 사항).*")

# Domeggook stamps every notice field it can't fill with this literal phrase
# (confirmed against real supplier data) -- never treat it as a real value.
PLACEHOLDER_MARKERS = ["상세정보 별도표기", "별도표기", "상세페이지 참고"]


def read_json(path):
    if not os.path.exists(path):
        return None
    with open(path, "r", encoding="utf-8") as f:
        return json.load(f)


def read_text(path):
    if not os.path.exists(path):
        return ""
    with open(path, "r", encoding="utf-8") as f:
        return f.read()


def strip_html_tags(html):
    text = re.sub(r"<[^>]+>", " ", html or "")
    return re.sub(r"\s+", " ", text).strip()


def is_placeholder(value):
    if not value:
        return True
    return any(marker in value for marker in PLACEHOLDER_MARKERS)


def field_single(value=None, confidence=0.0, source=None, evidence=None):
    return {"value": value, "confidence": confidence, "source": source, "evidence": evidence or []}


def field_multi(values=None, confidence=0.0, source=None, evidence=None):
    return {"values": values or [], "confidence": confidence, "source": source, "evidence": evidence or []}


def extract_from_raw_json(raw_json):
    """Highest-priority source: Domeggook's own structured fields."""
    result = {}
    detail = ((raw_json or {}).get("domeggook") or {}).get("detail") or {}

    manufacturer = detail.get("manufacturer")
    if manufacturer and not is_placeholder(manufacturer):
        result["manufacturer"] = field_single(
            manufacturer, 0.95, "raw_json",
            [{"file": None, "sliceIndex": None, "text": f"domeggook.detail.manufacturer={manufacturer}"}],
        )

    country = detail.get("country")
    if country and not is_placeholder(country):
        result["countryOfOrigin"] = field_single(
            country, 0.95, "raw_json",
            [{"file": None, "sliceIndex": None, "text": f"domeggook.detail.country={country}"}],
        )

    return result


def extract_from_text(text, source_label, source_file=None, slice_index=None):
    """Runs the same keyword/regex candidate extraction over any plain text
    (HTML-stripped or OCR'd) -- source_label/source_file/slice_index just
    tag where the text came from for evidence.

    Tesseract routinely inserts a space between every Hangul syllable on
    stylized graphic text (confirmed against real supplier images, e.g.
    "벨 벳" instead of "벨벳"), which breaks plain substring keyword checks.
    Keyword matching therefore also tries a fully space-collapsed variant of
    the text; regex patterns that rely on real word/number boundaries
    (dimensions, labeled manufacturer/country) stay on the original text,
    since collapsing spaces there would just produce different garbage, not
    a fix -- Codex's own image reading covers that case instead."""
    result = {}
    collapsed = re.sub(r"\s+", "", text)

    dim_match = DIMENSION_PATTERN.search(text)
    if dim_match:
        unit = dim_match.group(4).lower()
        value = f"{dim_match.group(1)}{unit} x {dim_match.group(2)}{unit} x {dim_match.group(3)}{unit}"
        result["dimensions"] = field_single(
            value, 0.6, source_label,
            [{"file": source_file, "sliceIndex": slice_index, "text": dim_match.group(0)}],
        )

    # material is a single string field (matches Codex's schema, e.g.
    # "아크릴 케이스, 벨벳 마감"), unlike colors/components which stay arrays --
    # multiple keyword hits get comma-joined rather than kept as a list.
    materials = [m for m in MATERIAL_KEYWORDS if m in text or m in collapsed]
    if materials:
        result["material"] = field_single(
            ", ".join(materials), 0.6, source_label,
            [{"file": source_file, "sliceIndex": slice_index, "text": m} for m in materials],
        )

    colors = [c for c in COLOR_KEYWORDS if c in text or c in collapsed]
    if colors:
        result["colors"] = field_multi(
            colors, 0.6, source_label,
            [{"file": source_file, "sliceIndex": slice_index, "text": c} for c in colors],
        )

    components = [c for c in COMPONENT_KEYWORDS if c in text or c in collapsed]
    if components:
        result["components"] = field_multi(
            components, 0.55, source_label,
            [{"file": source_file, "sliceIndex": slice_index, "text": c} for c in components],
        )

    precaution_match = PRECAUTION_LINE_PATTERN.search(text) or PRECAUTION_LINE_PATTERN.search(collapsed)
    if precaution_match:
        result["handlingPrecautions"] = field_single(
            precaution_match.group(0).strip(), 0.55, source_label,
            [{"file": source_file, "sliceIndex": slice_index, "text": precaution_match.group(0).strip()}],
        )

    manufacturer_match = MANUFACTURER_LABEL_PATTERN.search(text) or MANUFACTURER_LABEL_PATTERN.search(collapsed)
    if manufacturer_match and not is_placeholder(manufacturer_match.group(1)):
        result["manufacturer"] = field_single(
            manufacturer_match.group(1), 0.65, source_label,
            [{"file": source_file, "sliceIndex": slice_index, "text": manufacturer_match.group(0)}],
        )

    country_match = COUNTRY_LABEL_PATTERN.search(text) or COUNTRY_LABEL_PATTERN.search(collapsed)
    if country_match and not is_placeholder(country_match.group(2)):
        result["countryOfOrigin"] = field_single(
            country_match.group(2), 0.65, source_label,
            [{"file": source_file, "sliceIndex": slice_index, "text": country_match.group(0)}],
        )

    return result


def merge_field_candidates(fields_by_priority):
    """fields_by_priority: list of per-field dicts already ordered
    highest-priority source first (raw_json, then html, then ocr-per-image
    in slice order). Within one Python run, just keep the first (highest
    priority) hit per field and merge evidence from any later same-source
    hits at that same priority."""
    merged = {}
    for fields in fields_by_priority:
        for key, field in fields.items():
            if key not in merged:
                merged[key] = field
                continue
            existing = merged[key]
            is_multi = "values" in existing
            same_value = (existing.get("values") == field.get("values")) if is_multi else (existing.get("value") == field.get("value"))
            if same_value:
                existing["evidence"] = existing["evidence"] + [e for e in field["evidence"] if e not in existing["evidence"]]
                existing["confidence"] = min(0.98, max(existing["confidence"], field["confidence"]) + 0.05)
            elif is_multi:
                combined = list(dict.fromkeys(existing["values"] + field["values"]))
                existing["values"] = combined
                existing["evidence"] = existing["evidence"] + field["evidence"]
                existing["confidence"] = max(existing["confidence"], field["confidence"])
            # For single-value fields with genuinely different values, the
            # earlier (higher-priority) source wins for python-analysis.json
            # itself; the Node merge step against Codex is where real
            # cross-engine conflicts get surfaced, not here.
    return merged


REQUIRED_FIELDS = ["material", "dimensions", "colors", "components", "manufacturer", "countryOfOrigin", "handlingPrecautions"]


def analyze(job_dir, lang, tesseract_cmd, tessdata_prefix):
    input_dir = os.path.join(job_dir, "input")
    raw_json = read_json(os.path.join(input_dir, "raw.json"))
    html_text = strip_html_tags(read_text(os.path.join(input_dir, "detail.html")))

    slices_dir = os.path.join(input_dir, "detail-slices")
    slice_files = sorted(os.listdir(slices_dir)) if os.path.isdir(slices_dir) else []

    ocr_available, ocr_version, ocr_message = check_tesseract_available(tesseract_cmd)
    print(f"tesseract available={ocr_available} ({ocr_message})", file=sys.stderr)

    candidates = [extract_from_raw_json(raw_json)]
    if html_text:
        candidates.append(extract_from_text(html_text, "html"))

    ocr_results = []
    for filename in slice_files:
        slice_match = re.search(r"slice[-_]?(\d+)", filename, re.IGNORECASE)
        slice_index = int(slice_match.group(1)) if slice_match else None
        if not ocr_available:
            ocr_results.append({"file": filename, "sliceIndex": slice_index, "text": None, "ok": False})
            continue
        text = ocr_image(os.path.join(slices_dir, filename), lang=lang, tesseract_cmd=tesseract_cmd, tessdata_prefix=tessdata_prefix)
        ocr_results.append({"file": filename, "sliceIndex": slice_index, "text": text, "ok": text is not None})
        if text:
            candidates.append(extract_from_text(text, "ocr", source_file=filename, slice_index=slice_index))

    merged = merge_field_candidates(candidates)

    result = {}
    unresolved = []
    for key in REQUIRED_FIELDS:
        if key in merged:
            result[key] = merged[key]
        else:
            is_multi = key in ("colors", "components")
            result[key] = field_multi() if is_multi else field_single()
        if result[key]["confidence"] < 0.7:
            unresolved.append(key)
    result["unresolvedFields"] = unresolved
    result["ocrMeta"] = {
        "available": ocr_available,
        "version": ocr_version,
        "message": ocr_message,
        "imagesProcessed": len(slice_files),
        "imagesOcrOk": sum(1 for r in ocr_results if r["ok"]),
        "perImage": ocr_results,
    }
    return result


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--job-dir", required=True)
    parser.add_argument("--lang", default="kor+eng")
    parser.add_argument("--tesseract-cmd", default=None)
    parser.add_argument("--tessdata-prefix", default=None)
    args = parser.parse_args()

    try:
        result = analyze(args.job_dir, args.lang, args.tesseract_cmd, args.tessdata_prefix)
    except Exception as error:
        print(f"analyze_product failed: {error}", file=sys.stderr)
        sys.exit(1)

    print(json.dumps(result, ensure_ascii=False))


if __name__ == "__main__":
    main()
