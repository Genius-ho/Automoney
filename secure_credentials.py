"""Windows DPAPI-backed local storage for Toss API credentials."""
from __future__ import annotations

import base64
import ctypes
import json
from ctypes import wintypes
from dataclasses import asdict, dataclass
from pathlib import Path


class DataBlob(ctypes.Structure):
    _fields_ = [("cbData", wintypes.DWORD), ("pbData", ctypes.POINTER(ctypes.c_byte))]


@dataclass(frozen=True)
class TossCredentials:
    client_id: str
    client_secret: str
    account_seq: str
    live_trading: bool = True


class SecureCredentialStore:
    def __init__(self, path: str | Path = "secure_credentials.dat") -> None:
        self.path = Path(path)

    @staticmethod
    def _blob(data: bytes) -> tuple[DataBlob, ctypes.Array]:
        buffer = ctypes.create_string_buffer(data)
        blob = DataBlob(len(data), ctypes.cast(buffer, ctypes.POINTER(ctypes.c_byte)))
        return blob, buffer

    @staticmethod
    def _protect(data: bytes) -> bytes:
        source, source_buffer = SecureCredentialStore._blob(data)
        output = DataBlob()
        if not ctypes.windll.crypt32.CryptProtectData(
            ctypes.byref(source), "무한매수 토스 API", None, None, None, 1, ctypes.byref(output)
        ):
            raise ctypes.WinError()
        try:
            return ctypes.string_at(output.pbData, output.cbData)
        finally:
            ctypes.windll.kernel32.LocalFree(output.pbData)
            del source_buffer

    @staticmethod
    def _unprotect(data: bytes) -> bytes:
        source, source_buffer = SecureCredentialStore._blob(data)
        output = DataBlob()
        if not ctypes.windll.crypt32.CryptUnprotectData(
            ctypes.byref(source), None, None, None, None, 1, ctypes.byref(output)
        ):
            raise ctypes.WinError()
        try:
            return ctypes.string_at(output.pbData, output.cbData)
        finally:
            ctypes.windll.kernel32.LocalFree(output.pbData)
            del source_buffer

    def save(self, credentials: TossCredentials) -> None:
        if not credentials.client_id or not credentials.client_secret or not credentials.account_seq:
            raise ValueError("Client ID, Secret Key, 계좌 순번을 모두 입력하세요.")
        raw = json.dumps(asdict(credentials), ensure_ascii=False).encode("utf-8")
        encrypted = base64.b64encode(self._protect(raw))
        self.path.write_bytes(encrypted)

    def load(self) -> TossCredentials | None:
        if not self.path.exists():
            return None
        encrypted = base64.b64decode(self.path.read_bytes(), validate=True)
        payload = json.loads(self._unprotect(encrypted).decode("utf-8"))
        return TossCredentials(**payload)

    def delete(self) -> None:
        if self.path.exists():
            self.path.unlink()