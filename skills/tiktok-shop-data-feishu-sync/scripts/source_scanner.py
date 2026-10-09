"""只读发现店铺、扫描合法源文件并查询本地路径存在性。"""

import hashlib
import ntpath
import os
from pathlib import Path
import stat


def _directory_error(path, missing_error, access_error):
    """使用 stat 区分明确缺失与无法读取状态。"""
    try:
        mode = path.stat().st_mode
    except (FileNotFoundError, NotADirectoryError):
        return missing_error
    except (OSError, ValueError):
        return access_error
    return None if stat.S_ISDIR(mode) else missing_error


def _valid_relative_path(value):
    return (
        isinstance(value, str)
        and bool(value)
        and "\\" not in value
        and "\x00" not in value
        and not value.startswith("/")
        and not ntpath.splitdrive(value)[0]
        and ".." not in value.split("/")
    )


def _shop_path(source_root, shop_name):
    if not _valid_relative_path(shop_name) or "/" in shop_name or shop_name == ".":
        return None
    return Path(os.path.abspath(source_root)) / shop_name


def discover_shops(source_root):
    """返回根目录的直接子目录名；根目录不可可靠枚举时返回错误。"""
    root = Path(source_root)
    error = _directory_error(root, "SOURCE_ROOT_UNAVAILABLE", "SOURCE_ROOT_UNAVAILABLE")
    if error:
        return {"shops": [], "errors": [{"error": error}]}
    try:
        shops = [entry.name for entry in root.iterdir() if stat.S_ISDIR(entry.stat().st_mode)]
    except (OSError, ValueError) as exc:
        return {"shops": [], "errors": [{"error": "SOURCE_ROOT_UNAVAILABLE", "detail": str(exc)}]}
    return {"shops": sorted(shops), "errors": []}


def scan_shop(source_root, shop_name, supported_extensions, *, selected_paths=None):
    """扫描店铺以下最多两级目录，仅对成功读取的普通文件计算 SHA-256。"""
    result = {"shop": shop_name, "directories": [], "files": [], "errors": []}
    shop = _shop_path(source_root, shop_name)
    if shop is None:
        result["errors"].append({"error": "SHOP_NOT_FOUND"})
        return result
    error = _directory_error(shop, "SHOP_NOT_FOUND", "FILE_ACCESS_FAILED")
    if error:
        result["errors"].append({"error": error, "relative_path": ""})
        return result

    extensions = {extension.lower() for extension in supported_extensions}
    directories = set()

    def add_error(code, relative_path, exc=None):
        item = {"error": code, "relative_path": relative_path}
        if exc is not None:
            item["detail"] = str(exc)
        result["errors"].append(item)

    def visit(directory, depth):
        relative_directory = "" if directory == shop else directory.relative_to(shop).as_posix()
        try:
            entries = sorted(directory.iterdir(), key=lambda path: path.name)
        except (OSError, ValueError) as exc:
            add_error("FILE_ACCESS_FAILED", relative_directory, exc)
            return
        for path in entries:
            name = path.name
            extension = path.suffix.lower()
            if name in {"Thumbs.db", "desktop.ini", ".DS_Store"} or (
                name.startswith("~$") and extension == ".xlsx"
            ):
                continue
            relative_path = path.relative_to(shop).as_posix()
            try:
                mode = path.stat().st_mode
            except (OSError, ValueError) as exc:
                add_error("FILE_ACCESS_FAILED", relative_path, exc)
                continue
            if stat.S_ISDIR(mode):
                if depth == 2:
                    add_error("UNSUPPORTED_DIRECTORY_DEPTH", relative_path)
                else:
                    visit(path, depth + 1)
                continue
            if not stat.S_ISREG(mode):
                add_error("FILE_ACCESS_FAILED", relative_path)
                continue
            if extension not in extensions:
                add_error("UNSUPPORTED_FILE_TYPE", relative_path)
                continue
            try:
                digest = hashlib.sha256()
                with path.open("rb") as source:
                    for chunk in iter(lambda: source.read(1024 * 1024), b""):
                        digest.update(chunk)
                file_hash = digest.hexdigest()
            except Exception as exc:
                # 文件读取与 Hash 计算失败均为文件级错误，不影响兄弟文件。
                add_error("FILE_HASH_FAILED", relative_path, exc)
                continue
            result["files"].append({
                "absolute_path": str(path),
                "relative_path": relative_path,
                "extension": extension,
                "file_hash": file_hash,
            })
            parent = path.parent
            while parent != shop:
                directories.add(parent.relative_to(shop).as_posix())
                parent = parent.parent

    if selected_paths is None:
        visit(shop, 0)
    else:
        # Exact paths are opened directly: unrelated files cannot cause Hash errors.
        for relative_path in sorted(set(selected_paths)):
            parts = relative_path.split('/')
            if (not _valid_relative_path(relative_path) or len(parts) > 3
                    or any(p in ('', '.', '..') for p in parts)
                    or any(c in relative_path for c in '*?:')
                    or Path(relative_path).suffix.lower() not in extensions):
                add_error('SCOPE_INVALID', relative_path)
                continue
            path = shop / relative_path
            try:
                if not path.resolve().is_relative_to(shop.resolve()) or not stat.S_ISREG(path.stat().st_mode):
                    add_error('FILE_ACCESS_FAILED', relative_path)
                    continue
            except (OSError, ValueError) as exc:
                add_error('FILE_ACCESS_FAILED', relative_path, exc)
                continue
            try:
                digest = hashlib.sha256()
                with path.open('rb') as source:
                    for chunk in iter(lambda: source.read(1024 * 1024), b''):
                        digest.update(chunk)
            except Exception as exc:
                add_error('FILE_HASH_FAILED', relative_path, exc)
                continue
            result['files'].append(dict(absolute_path=str(path), relative_path=relative_path,
                                        extension=path.suffix.lower(), file_hash=digest.hexdigest()))
            for depth in range(1, len(parts)):
                directories.add('/'.join(parts[:depth]))
    result["files"].sort(key=lambda item: item["relative_path"])
    result["directories"] = sorted(directories)
    result["errors"].sort(key=lambda item: (item.get("relative_path", ""), item["error"]))
    return result


def check_path_presence(source_root, shop_name, relative_path):
    """查询普通文件是否明确存在；无法判断时返回 UNKNOWN，不读取文件内容。"""
    if not _valid_relative_path(relative_path):
        return {"status": "UNKNOWN", "error": "FILE_ACCESS_FAILED"}
    root = Path(source_root)
    error = _directory_error(root, "SOURCE_ROOT_UNAVAILABLE", "SOURCE_ROOT_UNAVAILABLE")
    if error:
        return {"status": "UNKNOWN", "error": error}
    shop = _shop_path(source_root, shop_name)
    if shop is None:
        return {"status": "UNKNOWN", "error": "SHOP_NOT_FOUND"}
    error = _directory_error(shop, "SHOP_NOT_FOUND", "FILE_ACCESS_FAILED")
    if error:
        return {"status": "UNKNOWN", "error": error}
    try:
        mode = (shop / relative_path).stat().st_mode
    except FileNotFoundError:
        return {"status": "ABSENT", "error": None}
    except (OSError, ValueError):
        return {"status": "UNKNOWN", "error": "FILE_ACCESS_FAILED"}
    if stat.S_ISREG(mode):
        return {"status": "PRESENT", "error": None}
    return {"status": "UNKNOWN", "error": "FILE_ACCESS_FAILED"}
