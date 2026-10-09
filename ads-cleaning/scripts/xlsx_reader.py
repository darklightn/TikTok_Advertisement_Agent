"""Small dependency-free XLSX value reader for deterministic cleaning runtime."""

from __future__ import annotations

import re
import zipfile
from pathlib import Path
from xml.etree import ElementTree as ET

MAIN = "http://schemas.openxmlformats.org/spreadsheetml/2006/main"
REL = "http://schemas.openxmlformats.org/officeDocument/2006/relationships"
PACKAGE_REL = "http://schemas.openxmlformats.org/package/2006/relationships"
CELL_REF = re.compile(r"^([A-Z]+)([1-9][0-9]*)$")


class XlsxReadError(Exception):
    def __init__(self, code: str, message: str):
        super().__init__(message)
        self.code = code


def _column_number(reference: str) -> int:
    match = CELL_REF.match(reference)
    if not match:
        raise XlsxReadError("xlsx_cell_reference_invalid", f"invalid cell reference: {reference}")
    result = 0
    for char in match.group(1):
        result = result * 26 + ord(char) - 64
    return result


def _shared_strings(archive: zipfile.ZipFile) -> list[str]:
    if "xl/sharedStrings.xml" not in archive.namelist():
        return []
    root = ET.fromstring(archive.read("xl/sharedStrings.xml"))
    return ["".join(node.text or "" for node in item.iter(f"{{{MAIN}}}t")) for item in root.findall(f"{{{MAIN}}}si")]


def _sheet_target(archive: zipfile.ZipFile) -> tuple[str, str]:
    workbook = ET.fromstring(archive.read("xl/workbook.xml"))
    sheets = workbook.find(f"{{{MAIN}}}sheets")
    items = [] if sheets is None else list(sheets)
    if len(items) != 1:
        raise XlsxReadError("unexpected_sheet_count", f"expected one sheet, found {len(items)}")
    sheet = items[0]
    relationship_id = sheet.attrib.get(f"{{{REL}}}id")
    relationships = ET.fromstring(archive.read("xl/_rels/workbook.xml.rels"))
    target = None
    for item in relationships.findall(f"{{{PACKAGE_REL}}}Relationship"):
        if item.attrib.get("Id") == relationship_id:
            target = item.attrib.get("Target")
            break
    if not target:
        raise XlsxReadError("xlsx_sheet_target_missing", "worksheet relationship is missing")
    normalized = target.lstrip("/")
    if not normalized.startswith("xl/"):
        normalized = f"xl/{normalized}"
    return sheet.attrib.get("name") or "Sheet1", normalized


def _cell_value(cell: ET.Element, shared: list[str]):
    reference = cell.attrib.get("r") or "unknown"
    if cell.find(f"{{{MAIN}}}f") is not None:
        raise XlsxReadError("formula_cell", f"formula cell is not accepted: {reference}")
    cell_type = cell.attrib.get("t")
    if cell_type == "inlineStr":
        inline = cell.find(f"{{{MAIN}}}is")
        return "" if inline is None else "".join(node.text or "" for node in inline.iter(f"{{{MAIN}}}t"))
    value = cell.find(f"{{{MAIN}}}v")
    if value is None or value.text is None:
        return None
    if cell_type == "s":
        try:
            return shared[int(value.text)]
        except (ValueError, IndexError) as exc:
            raise XlsxReadError("xlsx_shared_string_invalid", f"invalid shared string: {reference}") from exc
    if cell_type == "b":
        return value.text == "1"
    if cell_type == "e":
        raise XlsxReadError("xlsx_error_cell", f"Excel error cell is not accepted: {reference}")
    return value.text


def read_first_sheet(path: Path) -> tuple[str, list[tuple[object, ...]]]:
    try:
        with zipfile.ZipFile(path) as archive:
            shared = _shared_strings(archive)
            sheet_name, target = _sheet_target(archive)
            root = ET.fromstring(archive.read(target))
    except (OSError, zipfile.BadZipFile, KeyError, ET.ParseError) as exc:
        raise XlsxReadError("xlsx_unreadable", f"cannot read XLSX: {path}") from exc
    sheet_data = root.find(f"{{{MAIN}}}sheetData")
    rows = []
    if sheet_data is None:
        return sheet_name, rows
    for row in sheet_data.findall(f"{{{MAIN}}}row"):
        values: list[object] = []
        for cell in row.findall(f"{{{MAIN}}}c"):
            column = _column_number(cell.attrib.get("r") or "")
            if column > len(values):
                values.extend([None] * (column - len(values)))
            values[column - 1] = _cell_value(cell, shared)
        while values and values[-1] is None:
            values.pop()
        rows.append(tuple(values))
    return sheet_name, rows
