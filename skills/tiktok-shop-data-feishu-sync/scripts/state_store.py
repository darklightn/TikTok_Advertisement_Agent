"""按店铺和卷保存最后成功同步状态，提供本地互斥与原子提交。"""

from contextlib import contextmanager
import errno
import json
import ntpath
import os
from pathlib import Path
import re
import stat
import tempfile
import threading

if os.name == "nt":
    import msvcrt
else:
    import fcntl


class StateStoreError(Exception):
    """带冻结错误码和原始原因的状态操作异常。"""

    def __init__(self, code, detail=""):
        self.code = code
        self.detail = str(detail)
        super().__init__(f"{code}: {self.detail}")


def _relative_path(value):
    return (isinstance(value, str) and bool(value)
            and "\\" not in value and "\x00" not in value
            and not ntpath.splitdrive(value)[0]
            and all(part not in {"", ".", ".."} for part in value.split("/")))


def _volume_number(volume):
    if not isinstance(volume, str) or re.fullmatch(r"V[0-9]+", volume) is None:
        raise StateStoreError("STATE_VOLUME_FILENAME_INVALID", str(volume))
    try:
        number = int(volume[1:])
    except ValueError as exc:
        raise StateStoreError("STATE_VOLUME_FILENAME_INVALID", exc) from exc
    if number <= 0 or volume != f"V{number:03d}":
        raise StateStoreError("STATE_VOLUME_FILENAME_INVALID", volume)
    return number


def _mapping(local_path, table_id, file_hash):
    if not _relative_path(local_path):
        raise StateStoreError("STATE_SCHEMA_INVALID", "Invalid local_path")
    if not isinstance(table_id, str) or not table_id:
        raise StateStoreError("STATE_SCHEMA_INVALID", "Invalid table_id")
    if not isinstance(file_hash, str) or re.fullmatch(r"[0-9a-fA-F]{64}", file_hash) is None:
        raise StateStoreError("STATE_SCHEMA_INVALID", "Invalid file_hash")
    return {"local_path": local_path, "table_id": table_id, "file_hash": file_hash}


class StateStore:
    def __init__(self, state_root, max_formal_tables_per_base=290):
        self._root = Path(state_root)
        if not self._root.is_absolute():
            raise StateStoreError("STATE_PATH_INVALID", "state_root must be absolute")
        if type(max_formal_tables_per_base) is not int or max_formal_tables_per_base <= 0:
            raise StateStoreError("STATE_SCHEMA_INVALID", "Capacity must be a positive integer")
        self._capacity = max_formal_tables_per_base
        self._guard = threading.Lock()
        self._mutations = {}
        self._execution = {}

    def _shop(self, shop_name):
        if not _relative_path(shop_name) or "/" in shop_name:
            raise StateStoreError("STATE_PATH_INVALID", "shop_name must be one directory name")
        return self._root / shop_name

    def _mutex(self, shop_name):
        self._shop(shop_name)
        with self._guard:
            return self._mutations.setdefault(shop_name, threading.Lock())

    def _root_available(self, create=False):
        try:
            if create:
                self._root.mkdir(parents=True, exist_ok=True)
            if not stat.S_ISDIR(self._root.stat().st_mode):
                raise NotADirectoryError(str(self._root))
            return True
        except FileNotFoundError:
            if not create:
                return False
            raise StateStoreError("STATE_ROOT_UNAVAILABLE", str(self._root)) from None
        except OSError as exc:
            raise StateStoreError("STATE_ROOT_UNAVAILABLE", exc) from exc

    @contextmanager
    def acquire_shop_execution_lock(self, shop_name):
        """非阻塞 OS 锁；锁文件保留，句柄仅在本上下文内持有。"""
        shop = self._shop(shop_name)
        mutex = self._mutex(shop_name)
        with self._guard:
            if shop_name in self._execution:
                raise StateStoreError("SHOP_SYNC_ALREADY_RUNNING", shop_name)
            self._execution[shop_name] = None
        handle = None
        locked = False
        try:
            self._root_available(create=True)
            try:
                shop.mkdir(exist_ok=True)
                handle = (shop / ".sync.lock").open("a+b")
                handle.seek(0)
            except OSError as exc:
                raise StateStoreError("STATE_PRECHECK_FAILED", exc) from exc
            try:
                if os.name == "nt":
                    msvcrt.locking(handle.fileno(), msvcrt.LK_NBLCK, 1)
                else:
                    fcntl.flock(handle.fileno(), fcntl.LOCK_EX | fcntl.LOCK_NB)
                locked = True
            except OSError as exc:
                code = "SHOP_SYNC_ALREADY_RUNNING" if exc.errno in {errno.EACCES, errno.EAGAIN, errno.EDEADLK} else "STATE_PRECHECK_FAILED"
                raise StateStoreError(code, exc) from exc
            with self._guard:
                self._execution[shop_name] = handle
            yield
        finally:
            # 先等已进入的 mutation 完成，再撤销写入许可及释放 OS 锁。
            with mutex:
                with self._guard:
                    self._execution.pop(shop_name, None)
                if handle is not None:
                    try:
                        if locked:
                            handle.seek(0)
                            if os.name == "nt":
                                msvcrt.locking(handle.fileno(), msvcrt.LK_UNLCK, 1)
                            else:
                                fcntl.flock(handle.fileno(), fcntl.LOCK_UN)
                    except OSError as exc:
                        raise StateStoreError("STATE_PRECHECK_FAILED", exc) from exc
                    finally:
                        handle.close()

    @contextmanager
    def _mutation(self, shop_name):
        with self._mutex(shop_name):
            with self._guard:
                held = self._execution.get(shop_name) is not None
            if not held:
                raise StateStoreError("STATE_PRECHECK_FAILED", "Shop execution lock is required")
            yield

    def load_shop_state(self, shop_name):
        """只读加载完整店铺状态；先校验，再建立独立 snapshot。"""
        shop = self._shop(shop_name)
        empty = {"volumes": {}, "by_local_path": {}, "by_table_id": {}}
        if not self._root_available():
            return empty
        try:
            entries = list(shop.iterdir())
        except FileNotFoundError:
            return empty
        except OSError as exc:
            raise StateStoreError("STATE_FILE_READ_FAILED", exc) from exc
        candidates = []
        numbers = set()
        for path in sorted(entries):
            match = re.fullmatch(r"V([0-9]+)\.json", path.name)
            if match is None:
                continue
            try:
                number = int(match[1])
            except ValueError as exc:
                raise StateStoreError("STATE_VOLUME_FILENAME_INVALID", exc) from exc
            if number in numbers:
                raise StateStoreError("STATE_VOLUME_NUMBER_DUPLICATE", str(number))
            numbers.add(number)
            candidates.append((number, path))
        for _, path in candidates:
            _volume_number(path.stem)
        volumes = {}
        for _, path in sorted(candidates):
            try:
                raw = json.loads(path.read_text(encoding="utf-8"))
            except (UnicodeError, json.JSONDecodeError) as exc:
                raise StateStoreError("STATE_FILE_INVALID_JSON", exc) from exc
            except OSError as exc:
                raise StateStoreError("STATE_FILE_READ_FAILED", exc) from exc
            if not isinstance(raw, dict) or not isinstance(raw.get("tables"), list):
                raise StateStoreError("STATE_SCHEMA_INVALID", str(path))
            token = raw.get("base_token")
            if token is not None and not isinstance(token, str):
                raise StateStoreError("STATE_SCHEMA_INVALID", "Invalid base_token")
            tables = []
            for item in raw["tables"]:
                if not isinstance(item, dict) or not {"local_path", "table_id", "file_hash"} <= item.keys():
                    raise StateStoreError("STATE_SCHEMA_INVALID", "Invalid mapping structure")
                tables.append(_mapping(item["local_path"], item["table_id"], item["file_hash"]))
            volumes[path.stem] = {"base_token": token, "tables": sorted(tables, key=lambda t: t["local_path"])}
        for key, code in (("local_path", "DUPLICATE_LOCAL_PATH_MAPPING"), ("table_id", "DUPLICATE_TABLE_ID_MAPPING")):
            seen = set()
            for state in volumes.values():
                for item in state["tables"]:
                    if item[key] in seen:
                        raise StateStoreError(code, item[key])
                    seen.add(item[key])
        if any(len(state["tables"]) > self._capacity for state in volumes.values()):
            raise StateStoreError("STATE_VOLUME_OVER_CAPACITY", "Mapped table capacity exceeded")
        by_path, by_id = {}, {}
        for volume, state in volumes.items():
            for item in state["tables"]:
                by_path[item["local_path"]] = {"volume": volume, "table_id": item["table_id"], "file_hash": item["file_hash"]}
                by_id[item["table_id"]] = {"volume": volume, "local_path": item["local_path"]}
        return {"volumes": volumes, "by_local_path": by_path, "by_table_id": by_id}

    def prepare_shop_state(self, shop_name):
        with self._mutation(shop_name):
            snapshot = self.load_shop_state(shop_name)
            probe = None
            try:
                with tempfile.NamedTemporaryFile(mode="wb", dir=self._shop(shop_name), prefix=".probe-", suffix=".tmp", delete=False) as handle:
                    probe = Path(handle.name)
                    handle.write(b"0")
                    handle.flush()
                    os.fsync(handle.fileno())
                probe.unlink()
                probe = None
            except OSError as exc:
                raise StateStoreError("STATE_PRECHECK_FAILED", exc) from exc
            finally:
                if probe is not None:
                    try:
                        probe.unlink(missing_ok=True)
                    except OSError:
                        pass
            return snapshot

    def _write(self, shop_name, volume, state, error_code):
        temporary = None
        try:
            data = {"base_token": state["base_token"], "tables": sorted(state["tables"], key=lambda t: t["local_path"])}
            serialized = json.dumps(data, ensure_ascii=False, indent=2) + "\n"
            shop = self._shop(shop_name)
            with tempfile.NamedTemporaryFile(mode="w", encoding="utf-8", newline="\n", dir=shop,
                                             prefix=f".{volume}.", suffix=".tmp", delete=False) as handle:
                temporary = Path(handle.name)
                handle.write(serialized)
                handle.flush()
                os.fsync(handle.fileno())
            os.replace(temporary, shop / (volume + ".json"))
            temporary = None
        except (OSError, UnicodeError) as exc:
            raise StateStoreError(error_code, exc) from exc
        finally:
            if temporary is not None:
                try:
                    temporary.unlink(missing_ok=True)
                except OSError:
                    pass

    def set_base_token(self, shop_name, volume, base_token):
        with self._mutation(shop_name):
            _volume_number(volume)
            if not isinstance(base_token, str) or not base_token:
                raise StateStoreError("STATE_SCHEMA_INVALID", "Write token must be nonempty")
            snapshot = self.load_shop_state(shop_name)
            state = snapshot["volumes"].get(volume, {"base_token": None, "tables": []})
            state["base_token"] = base_token
            self._write(shop_name, volume, state, "BASE_TOKEN_STATE_WRITE_FAILED")

    def commit_new_mapping(self, shop_name, volume, local_path, new_table_id, new_file_hash):
        with self._mutation(shop_name):
            _volume_number(volume)
            item = _mapping(local_path, new_table_id, new_file_hash)
            snapshot = self.load_shop_state(shop_name)
            state = snapshot["volumes"].get(volume)
            if (state is None or local_path in snapshot["by_local_path"]
                    or new_table_id in snapshot["by_table_id"] or len(state["tables"]) >= self._capacity):
                raise StateStoreError("STATE_COMMIT_CONFLICT", "New mapping conflicts or volume is uninitialized/full")
            state["tables"].append(item)
            self._write(shop_name, volume, state, "STATE_COMMIT_FAILED")

    def commit_existing_mapping(self, shop_name, volume, local_path, expected_old_table_id,
                                expected_old_file_hash, new_table_id, new_file_hash):
        with self._mutation(shop_name):
            _volume_number(volume)
            item = _mapping(local_path, new_table_id, new_file_hash)
            snapshot = self.load_shop_state(shop_name)
            previous = snapshot["by_local_path"].get(local_path)
            expected = {"volume": volume, "table_id": expected_old_table_id, "file_hash": expected_old_file_hash}
            owner = snapshot["by_table_id"].get(new_table_id)
            if previous != expected or (owner is not None and owner["local_path"] != local_path):
                raise StateStoreError("STATE_COMMIT_CONFLICT", "Expected mapping or new table ID conflicts")
            state = snapshot["volumes"][volume]
            state["tables"] = [item if t["local_path"] == local_path else t for t in state["tables"]]
            self._write(shop_name, volume, state, "STATE_COMMIT_FAILED")
