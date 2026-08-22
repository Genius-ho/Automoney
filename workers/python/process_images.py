"""OCR + light preprocessing helpers.

Never raises for a missing/broken Tesseract install -- the caller
(analyze_product.py) must be able to fall back to "no OCR" and still return a
valid result with Codex's analysis as the only source. Only ever reads the
image files it's given (the job folder's own already-sliced detail images);
never re-slices, re-fetches, or upscales anything -- per spec, existing
slices/thumbnails are used as-is.
"""
import os


def check_tesseract_available(tesseract_cmd=None):
    """Returns (available, version, message). Never raises."""
    try:
        import pytesseract
        if tesseract_cmd:
            pytesseract.pytesseract.tesseract_cmd = tesseract_cmd
        version = str(pytesseract.get_tesseract_version())
        return True, version, f"tesseract {version}"
    except ImportError as error:
        return False, None, f"pytesseract not installed: {error}"
    except Exception as error:  # pytesseract.TesseractNotFoundError and friends
        return False, None, f"tesseract not usable: {error}"


def ocr_image(image_path, lang="kor+eng", tesseract_cmd=None, tessdata_prefix=None):
    """Runs OCR on one image. Returns extracted text, or None on any failure
    (missing binary, missing language data, corrupt image, ...) -- errors are
    the caller's to log, never raised past this function so one bad image
    can't abort the whole analysis."""
    try:
        import pytesseract
        from PIL import Image

        if tesseract_cmd:
            pytesseract.pytesseract.tesseract_cmd = tesseract_cmd
        if tessdata_prefix:
            os.environ["TESSDATA_PREFIX"] = tessdata_prefix

        with Image.open(image_path) as img:
            # Grayscale only -- a cheap, well-established accuracy win for
            # Tesseract on flat marketing-graphic text. No resizing/upscaling.
            gray = img.convert("L")
            return pytesseract.image_to_string(gray, lang=lang)
    except Exception:
        return None
