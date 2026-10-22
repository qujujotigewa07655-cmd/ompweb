"""Local document extraction as JSON lines; never evaluates document code/links."""
import codecs
import bz2
import gzip
import json
import lzma
import os
import shutil
import stat
import subprocess
import sys
import tarfile
import tempfile
import zipfile
import re
import xml.etree.ElementTree as ET


SECTION_PREFIX = ""
EMITTED = 0


def emit(location, text):
    # A pathological page/paragraph/row must not create an unbounded IPC frame.
    global EMITTED
    where = f"{SECTION_PREFIX} · {location}" if SECTION_PREFIX else location
    for offset in range(0, len(text), 16384):
        chunk = text[offset:offset + 16384]
        if chunk.strip():
            print(json.dumps({"location": where, "text": chunk}, ensure_ascii=True), flush=True)
            EMITTED += 1


def format_bytes(size):
    if size >= 1024 * 1024:
        return f"{size / (1024 * 1024):.1f} MB"
    if size >= 1024:
        return f"{size / 1024:.1f} KB"
    return f"{size} B"


def emit_manifest(entries):
    """No text member: describe the archive instead of returning nothing, so the
    caller knows what is inside without unpacking it first."""
    if not entries:
        # Nothing at all: the caller attaches the original without sections.
        return
    total = sum(size for _, size in entries)
    lines = [f"Archive contents: {len(entries)} file(s), {format_bytes(total)} uncompressed. No text members were extracted."]
    for name, size in sorted(entries, key=lambda entry: entry[1], reverse=True)[:MANIFEST_LIMIT]:
        lines.append(f"{name} ({format_bytes(size)})")
    if len(entries) > MANIFEST_LIMIT:
        lines.append(f"... and {len(entries) - MANIFEST_LIMIT} more file(s)")
    emit("Archive contents", "\n".join(lines))


TEXT_MEMBER_LIMIT = 8 * 1024 * 1024
ARCHIVE_EXPANDED_LIMIT = 512 * 1024 * 1024
ARCHIVE_ENTRY_LIMIT = 20000
DOCUMENT_SUFFIXES = {".pdf", ".docx", ".xlsx"}
MANIFEST_LIMIT = 200
# A document inside an archive is materialised once to reuse the normal parser;
# the cap bounds that temporary copy, the archive-wide 512 MiB limit still holds.
NESTED_DOCUMENT_LIMIT = 64 * 1024 * 1024


def nested_document(source, member):
    """Parse a document stored inside an archive and prefix its sections with
    the member path. A member that cannot be parsed is skipped: one broken file
    must not reject the whole archive."""
    global SECTION_PREFIX
    suffix = os.path.splitext(member)[1].lower()
    handle, temporary = tempfile.mkstemp(prefix="omp-member-", suffix=suffix)
    try:
        written = 0
        with os.fdopen(handle, "wb") as target:
            while True:
                chunk = source.read(65536)
                if not chunk:
                    break
                written += len(chunk)
                if written > NESTED_DOCUMENT_LIMIT:
                    return
                target.write(chunk)
        SECTION_PREFIX = member
        try:
            sections(temporary, member)
        except Exception:
            return
        finally:
            SECTION_PREFIX = ""
    finally:
        os.unlink(temporary)


STREAM_OPENERS = {"gz": gzip.open, "bz2": bz2.open, "xz": lzma.open}


def archive_kind(name):
    # Longest suffix first: ".tar.gz" must win over ".gz".
    lowered = name.lower()
    for suffix, kind in (
        (".tar.gz", "tar"), (".tgz", "tar"), (".tar.bz2", "tar"), (".tbz2", "tar"), (".tbz", "tar"),
        (".tar.xz", "tar"), (".txz", "tar"), (".tar", "tar"),
        (".zip", "zip"), (".jar", "zip"), (".war", "zip"), (".whl", "zip"), (".apk", "zip"),
        (".7z", "7z"), (".rar", "7z"),
        (".gz", "gz"), (".bz2", "bz2"), (".xz", "xz"),
    ):
        if lowered.endswith(suffix):
            return kind
    return None


def safe_member(name):
    # Archive member paths are untrusted: no absolute paths, drive letters,
    # leading switches or ".." segments.
    normalized = name.replace("\\", "/")
    if not normalized or normalized.startswith(("/", "-")) or re.match(r"^[A-Za-z]:", normalized):
        return False
    return ".." not in normalized.split("/")


def check_archive_limits(entries, expanded):
    # Declared sizes come from the container index, so a bomb is refused before
    # any decompression work is done.
    if entries > ARCHIVE_ENTRY_LIMIT:
        raise ValueError("Archive contains too many entries to scan")
    if expanded > ARCHIVE_EXPANDED_LIMIT:
        raise ValueError("Archive expands beyond the 512 MiB safe parsing limit")


def emit_member(prefix, source):
    """Emit a member's UTF-8 lines; a non-text member is dropped, not fatal."""
    decoder = codecs.getincrementaldecoder("utf-8")()
    pending = ""
    number = 1
    consumed = 0
    while True:
        chunk = source.read(65536)
        try:
            text = decoder.decode(chunk, not chunk)
        except UnicodeDecodeError:
            return
        if any(ord(char) < 32 and char not in "\t\r\n\f" for char in text):
            return
        consumed += len(chunk)
        pending += text
        lines = pending.split("\n")
        pending = lines.pop()
        for line in lines:
            emit(f"{prefix} · Line {number}", line.rstrip("\r"))
            number += 1
        if not chunk:
            if pending:
                emit(f"{prefix} · Line {number}", pending)
            return
        if consumed >= TEXT_MEMBER_LIMIT:
            return


def zip_sections(filename):
    with zipfile.ZipFile(filename) as archive:
        members = archive.infolist()
        check_archive_limits(len(members), sum(member.file_size for member in members))
        entries = []
        start = EMITTED
        for member in members:
            if member.is_dir() or member.flag_bits & 0x1:
                continue
            if (member.external_attr >> 16) & 0o170000 == 0o120000:
                continue
            if not safe_member(member.filename) or archive_kind(member.filename):
                continue
            entries.append((member.filename, member.file_size))
            try:
                with archive.open(member) as source:
                    if os.path.splitext(member.filename)[1].lower() in DOCUMENT_SUFFIXES:
                        nested_document(source, member.filename)
                    else:
                        emit_member(member.filename, source)
            except Exception:
                continue
        if EMITTED == start:
            emit_manifest(entries)


def tar_sections(filename):
    with tarfile.open(filename, "r:*") as archive:
        members = archive.getmembers()
        check_archive_limits(len(members), sum(member.size for member in members))
        entries = []
        start = EMITTED
        for member in members:
            if not member.isfile() or not safe_member(member.name) or archive_kind(member.name):
                continue
            entries.append((member.name, member.size))
            try:
                source = archive.extractfile(member)
                if source is None:
                    continue
                with source:
                    if os.path.splitext(member.name)[1].lower() in DOCUMENT_SUFFIXES:
                        nested_document(source, member.name)
                    else:
                        emit_member(member.name, source)
            except Exception:
                continue
        if EMITTED == start:
            emit_manifest(entries)


def gzip_inner_name(filename, fallback):
    # The gzip FNAME field names the payload; the file on disk is often an fd.
    try:
        with open(filename, "rb") as source:
            header = source.read(512)
    except OSError:
        return fallback
    if len(header) < 10 or header[:2] != b"\x1f\x8b" or not header[3] & 0x08:
        return fallback
    end = header.find(b"\x00", 10)
    if end < 0:
        return fallback
    name = os.path.basename(header[10:end].decode("latin-1").replace("\\", "/"))
    if not name or any(ord(char) < 32 for char in name):
        return fallback
    return name


def stream_sections(filename, kind, display_name):
    base = os.path.basename(display_name)
    fallback = os.path.splitext(base)[0] or base
    inner = gzip_inner_name(filename, fallback) if kind == "gz" else fallback
    with STREAM_OPENERS[kind](filename, "rb") as source:
        emit_member(inner, source)


def sevenzip_tool():
    tool = shutil.which("7z") or shutil.which("7za")
    if not tool:
        raise ValueError("7z archives require the 7z tool")
    return tool


def sevenzip_entries(tool, filename):
    result = subprocess.run([tool, "l", "-slt", filename], stdout=subprocess.PIPE, stderr=subprocess.DEVNULL, text=True, errors="replace", timeout=120)
    if result.returncode != 0:
        # Same signal as an unreadable container: the caller attaches the
        # original instead of failing the upload.
        raise ValueError("Binary data is not a text document")
    entries = []
    entry = {}
    for line in result.stdout.splitlines():
        if not line.strip():
            if entry:
                entries.append(entry)
            entry = {}
        elif " = " in line:
            key, value = line.split(" = ", 1)
            entry[key.strip()] = value
    if entry:
        entries.append(entry)
    # The archive's own header block carries no Size field.
    return [entry for entry in entries if "Size" in entry]


def declared_size(entry):
    try:
        return int(entry.get("Size", ""))
    except ValueError:
        return 0


def sevenzip_sections(filename):
    tool = sevenzip_tool()
    entries = sevenzip_entries(tool, filename)
    check_archive_limits(len(entries), sum(declared_size(entry) for entry in entries))
    files = []
    for entry in entries:
        if entry.get("Attributes", "").startswith("D") or entry.get("Encrypted") == "+":
            continue
        member = entry.get("Path", "")
        # 7z reads its member arguments as wildcards and "@file" as a list file:
        # such a name would widen the extraction beyond the vetted set.
        if not safe_member(member) or archive_kind(member) or member.startswith("@") or any(char in "*?[]" for char in member):
            continue
        files.append((member, declared_size(entry)))
    start = EMITTED
    directory = tempfile.mkdtemp(prefix="omp-archive-")
    try:
        # Only vetted member names are extracted, so 7z never sees a path that
        # could land outside the temporary directory.
        names = [name for name, _ in files]
        for offset in range(0, len(names), 100):
            subprocess.run([tool, "x", "-y", "-bso0", "-bsp0", f"-o{directory}", filename] + names[offset:offset + 100], stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL, timeout=300)
        root = os.path.realpath(directory)
        for member, _size in files:
            target = os.path.realpath(os.path.join(root, member))
            if not target.startswith(root + os.sep):
                continue
            try:
                if not stat.S_ISREG(os.stat(target, follow_symlinks=False).st_mode):
                    continue
                with os.fdopen(os.open(target, os.O_RDONLY | getattr(os, "O_NOFOLLOW", 0)), "rb") as source:
                    if os.path.splitext(member)[1].lower() in DOCUMENT_SUFFIXES:
                        nested_document(source, member)
                    else:
                        emit_member(member, source)
            except OSError:
                continue
        if EMITTED == start:
            emit_manifest(files)
    finally:
        shutil.rmtree(directory, ignore_errors=True)


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
    elif (kind := archive_kind(display_name or filename)):
        # A container that cannot be parsed is still a file the user attached:
        # it falls back to the binary result (original only), never to a crash.
        # Our own limit errors are deliberately left uncaught so a bomb stays
        # a visible rejection instead of a silent attachment.
        try:
            if kind == "zip":
                zip_sections(filename)
            elif kind == "tar":
                tar_sections(filename)
            elif kind == "7z":
                sevenzip_sections(filename)
            else:
                stream_sections(filename, kind, display_name or filename)
        except (zipfile.BadZipFile, tarfile.TarError, gzip.BadGzipFile, lzma.LZMAError, EOFError, OSError):
            raise ValueError("Binary data is not a text document")
    else:
        # A binary file that is not a known archive is not a text document, and
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
