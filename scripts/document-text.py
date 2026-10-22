"""Local document extraction as JSON lines; never evaluates document code/links."""
import json
import os
import sys
import zipfile
import re
import xml.etree.ElementTree as ET


def emit(location, text):
    # A pathological page/paragraph/row must not create an unbounded IPC frame.
    for offset in range(0, len(text), 16384):
        chunk = text[offset:offset + 16384]
        if chunk.strip():
            print(json.dumps({"location": location, "text": chunk}, ensure_ascii=True), flush=True)


def sections(filename, display_name=None):
    ext = os.path.splitext(display_name or filename)[1].lower()
    if ext in {".docx", ".xlsx"}:
        with zipfile.ZipFile(filename) as archive:
            if sum(entry.file_size for entry in archive.infolist()) > 512 * 1024 * 1024:
                raise ValueError("Document expands beyond the 512 MiB safe parsing limit")
    if ext == ".pdf":
        import fitz
        import pytesseract
        from PIL import Image
        ocr_languages = None
        with fitz.open(filename) as document:
            for number, page in enumerate(document, 1):
                text = page.get_text()
                if not text.strip():
                    if ocr_languages is None:
                        available = pytesseract.get_languages(config="")
                        ocr_languages = "+".join(language for language in ("rus", "eng") if language in available)
                        if not ocr_languages:
                            raise ValueError("PDF OCR requires installed Russian or English Tesseract language data")
                    # Keep the entire page, scaled down, not a crop. Bound raster memory.
                    scale = min(2, 2400 / max(page.rect.width, page.rect.height))
                    pix = page.get_pixmap(matrix=fitz.Matrix(scale, scale), alpha=False)
                    text = pytesseract.image_to_string(Image.frombytes("RGB", [pix.width, pix.height], pix.samples), lang=ocr_languages, timeout=120)
                emit(f"Page {number}", text)
    elif ext == ".docx":
        # Stream body, table, header/footer and note paragraphs; no links fetched.
        with zipfile.ZipFile(filename) as archive:
            members = ["word/document.xml"] + sorted(name for name in archive.namelist() if re.fullmatch(r"word/(header\d+|footer\d+|footnotes|endnotes|comments)\.xml", name))
            paragraph_tag = "{http://schemas.openxmlformats.org/wordprocessingml/2006/main}p"
            for member in members:
                with archive.open(member) as source:
                    number = 0
                    stack = []
                    paragraph_depth = 0
                    for event, element in ET.iterparse(source, events=("start", "end")):
                        if event == "start":
                            stack.append(element)
                            if element.tag == paragraph_tag:
                                paragraph_depth += 1
                            continue
                        if element.tag == paragraph_tag:
                            number += 1
                            text = "".join(node.text or "" for node in element.iter() if node.tag.endswith("}t"))
                            location = f"Paragraph {number}" if member == "word/document.xml" else f"{os.path.basename(member)}, paragraph {number}"
                            emit(location, text)
                            paragraph_depth -= 1
                        if paragraph_depth == 0:
                            element.clear()
                            if len(stack) > 1:
                                stack[-2].remove(element)
                        stack.pop()
    elif ext == ".xlsx":
        from openpyxl import load_workbook
        with open(filename, "rb") as source:
            workbook = load_workbook(source, read_only=True, data_only=False, keep_links=False)
            try:
                for sheet in workbook:
                    for number, row in enumerate(sheet.iter_rows(values_only=True), 1):
                        emit(f"Sheet {sheet.title}, row {number}", "\t".join("" if value is None else str(value) for value in row))
            finally:
                workbook.close()
    else:
        # A binary file (an archive, an executable) is not a text document, and
        # must say so instead of failing the decode half-way and printing a
        # codec traceback to the caller.
        try:
            with open(filename, encoding="utf-8-sig", errors="strict") as source:
                number = 1
                while True:
                    text = source.readline(16384)
                    if not text:
                        break
                    if any(ord(char) < 32 and char not in "\t\r\n\f" for char in text):
                        raise ValueError("Binary data is not a text document")
                    emit(f"Line {number}", text.rstrip("\r\n"))
                    if text.endswith("\n"):
                        number += 1
        except UnicodeDecodeError:
            raise ValueError("Binary data is not a text document")


def image_derivative(original, output):
    from PIL import Image, ImageOps
    with os.fdopen(os.open(original, os.O_RDONLY | getattr(os, "O_NOFOLLOW", 0)), "rb") as raw, Image.open(raw) as source, open(output, "xb") as target:
        source.seek(0)
        source.draft("RGB", (1280, 1280))
        image = ImageOps.exif_transpose(source).convert("RGB")
        image.thumbnail((1280, 1280))
        for quality in (85, 65, 45, 25):
            target.seek(0)
            target.truncate()
            image.save(target, "JPEG", quality=quality)
            if target.tell() <= 400 * 1024:
                return
        raise ValueError("Cannot create a bounded full-frame image derivative")


if __name__ == "__main__":
    try:
        if sys.argv[1] == "--image":
            image_derivative(sys.argv[2], sys.argv[3])
        else:
            sections(sys.argv[1], sys.argv[2] if len(sys.argv) > 2 else None)
    except Exception as error:
        print(str(error), file=sys.stderr)
        sys.exit(1)
