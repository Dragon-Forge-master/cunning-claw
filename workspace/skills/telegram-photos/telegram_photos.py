"""
telegram_photos.py — photo send/receive handling for a Telegram bot.

Dependencies: requests
Usage:
    tg = TelegramPhotos(os.environ["TELEGRAM_BOT_TOKEN"], store_dir="~/.cache/tgphotos")
    tg.poll(on_photo=my_handler, on_album=my_album_handler)

Design notes are at the bottom of the file.
"""

from __future__ import annotations

import os
import time
import uuid
from dataclasses import dataclass, field
from pathlib import Path
from typing import Any, Callable, Iterable, Optional, Sequence, Union

import requests

API_ROOT = "https://api.telegram.org"

# Telegram-imposed limits (cloud Bot API; a self-hosted Bot API server lifts most of these)
PHOTO_UPLOAD_MAX = 10 * 1024 * 1024      # sendPhoto, multipart upload
PHOTO_URL_MAX = 5 * 1024 * 1024          # sendPhoto, by URL
DOCUMENT_UPLOAD_MAX = 50 * 1024 * 1024   # sendDocument
GETFILE_MAX = 20 * 1024 * 1024           # download ceiling
CAPTION_LIMIT = 1024
DIM_SUM_LIMIT = 10000                    # width + height
RATIO_LIMIT = 20                         # long side / short side

PhotoSource = Union[str, bytes, Path]


# --------------------------------------------------------------------------- #
# Inbound
# --------------------------------------------------------------------------- #

@dataclass
class IncomingPhoto:
    """One photo from an update, whether sent compressed or as a file."""
    file_id: str            # use to download or re-send; bot-specific, can change
    file_unique_id: str     # stable across bots; use for dedup, NOT for download
    chat_id: int
    message_id: int
    from_user_id: Optional[int] = None
    caption: Optional[str] = None
    media_group_id: Optional[str] = None
    width: Optional[int] = None
    height: Optional[int] = None
    file_size: Optional[int] = None
    file_name: Optional[str] = None
    as_document: bool = False   # True = sent uncompressed, original bytes intact
    local_path: Optional[Path] = None
    mime: Optional[str] = None

    @property
    def too_big_to_fetch(self) -> bool:
        return bool(self.file_size and self.file_size > GETFILE_MAX)


_MAGIC = [
    (b"\xff\xd8\xff", "image/jpeg"),
    (b"\x89PNG\r\n\x1a\n", "image/png"),
    (b"GIF87a", "image/gif"),
    (b"GIF89a", "image/gif"),
    (b"RIFF", "image/webp"),          # refined below
    (b"II*\x00", "image/tiff"),
    (b"MM\x00*", "image/tiff"),
]


def sniff_mime(blob: bytes) -> str:
    """Trust the bytes, not the filename. Vision APIs reject mismatched media_type."""
    for magic, mime in _MAGIC:
        if blob.startswith(magic):
            if mime == "image/webp" and blob[8:12] != b"WEBP":
                continue
            return mime
    if blob[4:12] in (b"ftypheic", b"ftypheix", b"ftypmif1"):
        return "image/heic"
    return "application/octet-stream"


def extract_photos(message: dict) -> list[IncomingPhoto]:
    """
    Pull photo descriptors out of a message.

    Handles three shapes:
      * message["photo"]     -> compressed, list of sizes ascending; take the last
      * message["document"]  -> uncompressed image sent as a file
      * message["sticker"]   -> ignored here, but easy to add
    """
    chat_id = message["chat"]["id"]
    base = dict(
        chat_id=chat_id,
        message_id=message["message_id"],
        from_user_id=(message.get("from") or {}).get("id"),
        caption=message.get("caption"),
        media_group_id=message.get("media_group_id"),
    )
    out: list[IncomingPhoto] = []

    sizes = message.get("photo")
    if sizes:
        largest = sizes[-1]  # ascending by resolution
        out.append(IncomingPhoto(
            file_id=largest["file_id"],
            file_unique_id=largest["file_unique_id"],
            width=largest.get("width"),
            height=largest.get("height"),
            file_size=largest.get("file_size"),
            **base,
        ))

    doc = message.get("document")
    if doc and (doc.get("mime_type") or "").startswith("image/"):
        out.append(IncomingPhoto(
            file_id=doc["file_id"],
            file_unique_id=doc["file_unique_id"],
            file_size=doc.get("file_size"),
            file_name=doc.get("file_name"),
            mime=doc.get("mime_type"),
            as_document=True,
            **base,
        ))

    return out


class MediaGroupBuffer:
    """
    Albums arrive as N separate updates sharing a media_group_id, and only one of
    them carries the caption. Hold them briefly, then flush as a unit.
    """

    def __init__(self, settle_seconds: float = 1.5):
        self.settle = settle_seconds
        self._groups: dict[str, list[IncomingPhoto]] = {}
        self._last_seen: dict[str, float] = {}

    def add(self, photo: IncomingPhoto) -> None:
        gid = photo.media_group_id or ""
        self._groups.setdefault(gid, []).append(photo)
        self._last_seen[gid] = time.monotonic()

    def flush_ready(self) -> list[list[IncomingPhoto]]:
        now = time.monotonic()
        ready = [g for g, t in self._last_seen.items() if now - t >= self.settle]
        batches = []
        for gid in ready:
            batch = self._groups.pop(gid, [])
            self._last_seen.pop(gid, None)
            if batch:
                batch.sort(key=lambda p: p.message_id)
                caption = next((p.caption for p in batch if p.caption), None)
                for p in batch:
                    p.caption = caption
                batches.append(batch)
        return batches


# --------------------------------------------------------------------------- #
# Client
# --------------------------------------------------------------------------- #

class TelegramError(RuntimeError):
    pass


class TelegramPhotos:
    def __init__(
        self,
        token: str,
        store_dir: Union[str, Path] = "~/.cache/telegram_photos",
        session: Optional[requests.Session] = None,
        timeout: int = 60,
    ):
        self._token = token
        self.store = Path(store_dir).expanduser()
        self.store.mkdir(parents=True, exist_ok=True)
        self.session = session or requests.Session()
        self.timeout = timeout
        self._offset: Optional[int] = None
        self._file_id_cache: dict[str, str] = {}  # local sha/path -> file_id

    # -- transport ---------------------------------------------------------- #

    def _api(self, method: str, data: Optional[dict] = None,
             files: Optional[dict] = None, timeout: Optional[int] = None) -> Any:
        url = f"{API_ROOT}/bot{self._token}/{method}"
        try:
            r = self.session.post(url, data=data, files=files,
                                  timeout=timeout or self.timeout)
        except requests.RequestException as exc:
            # never let the token surface in a traceback or log line
            raise TelegramError(f"{method} transport error: {type(exc).__name__}") from None
        try:
            payload = r.json()
        except ValueError:
            raise TelegramError(f"{method} returned non-JSON, HTTP {r.status_code}") from None
        if not payload.get("ok"):
            raise TelegramError(
                f"{method} failed: {payload.get('error_code')} "
                f"{payload.get('description')}"
            )
        return payload["result"]

    # -- download ----------------------------------------------------------- #

    def download(self, photo: IncomingPhoto) -> IncomingPhoto:
        """Fetch bytes to local disk and fill in local_path + mime."""
        if photo.too_big_to_fetch:
            raise TelegramError(
                f"file_size {photo.file_size} exceeds the {GETFILE_MAX} byte getFile limit"
            )
        meta = self._api("getFile", {"file_id": photo.file_id})
        file_path = meta["file_path"]  # valid ~1h, refetch rather than caching the URL
        url = f"{API_ROOT}/file/bot{self._token}/{file_path}"
        try:
            r = self.session.get(url, timeout=self.timeout)
            r.raise_for_status()
        except requests.RequestException as exc:
            raise TelegramError(f"download failed: {type(exc).__name__}") from None

        blob = r.content
        photo.mime = sniff_mime(blob)
        suffix = Path(file_path).suffix or {
            "image/jpeg": ".jpg", "image/png": ".png", "image/webp": ".webp",
            "image/gif": ".gif", "image/heic": ".heic",
        }.get(photo.mime, ".bin")

        dest = self.store / f"{photo.file_unique_id}{suffix}"
        dest.write_bytes(blob)
        photo.local_path = dest
        photo.file_size = len(blob)
        return photo

    def as_vision_payload(self, photo: IncomingPhoto) -> dict:
        """Base64 block ready to hand to whatever vision model you're calling."""
        import base64
        if photo.local_path is None:
            self.download(photo)
        blob = photo.local_path.read_bytes()
        return {
            "type": "base64",
            "media_type": photo.mime or sniff_mime(blob),
            "data": base64.b64encode(blob).decode("ascii"),
        }

    # -- upload ------------------------------------------------------------- #

    @staticmethod
    def _classify(source: PhotoSource) -> str:
        if isinstance(source, bytes):
            return "bytes"
        s = str(source)
        if s.startswith(("http://", "https://")):
            return "url"
        if os.path.exists(os.path.expanduser(s)):
            return "path"
        return "file_id"

    def send_photo(
        self,
        chat_id: Union[int, str],
        source: PhotoSource,
        caption: Optional[str] = None,
        lossless: bool = False,
        reply_to: Optional[int] = None,
        parse_mode: Optional[str] = None,
        spoiler: bool = False,
    ) -> dict:
        """
        Send one image. `source` may be a local path, raw bytes, a public URL,
        or a file_id from a previous send/receive.

        lossless=True (or an oversized/odd-shaped image) routes to sendDocument,
        which skips Telegram's JPEG recompression.
        """
        kind = self._classify(source)
        if caption and len(caption) > CAPTION_LIMIT:
            caption = caption[: CAPTION_LIMIT - 1] + "\u2026"

        data: dict[str, Any] = {"chat_id": chat_id}
        if caption:
            data["caption"] = caption
        if parse_mode:
            data["parse_mode"] = parse_mode
        if reply_to:
            data["reply_parameters"] = f'{{"message_id": {reply_to}}}'
        if spoiler:
            data["has_spoiler"] = True

        blob: Optional[bytes] = None
        filename = "photo.jpg"
        if kind == "bytes":
            blob = source  # type: ignore[assignment]
        elif kind == "path":
            p = Path(os.path.expanduser(str(source)))
            cached = self._file_id_cache.get(str(p.resolve()))
            if cached and not lossless:
                data["photo"] = cached
                return self._api("sendPhoto", data)
            blob = p.read_bytes()
            filename = p.name

        # URL or file_id: no upload needed
        if blob is None:
            data["photo"] = str(source)
            return self._api("sendPhoto", data)

        mime = sniff_mime(blob)
        oversized = len(blob) > PHOTO_UPLOAD_MAX
        if lossless or oversized:
            if len(blob) > DOCUMENT_UPLOAD_MAX:
                raise TelegramError(
                    f"{len(blob)} bytes exceeds the {DOCUMENT_UPLOAD_MAX} byte upload limit"
                )
            result = self._api("sendDocument", data,
                               files={"document": (filename, blob, mime)})
            file_id = result.get("document", {}).get("file_id")
        else:
            result = self._api("sendPhoto", data,
                               files={"photo": (filename, blob, mime)})
            sizes = result.get("photo") or []
            file_id = sizes[-1]["file_id"] if sizes else None

        if kind == "path" and file_id:
            self._file_id_cache[str(Path(os.path.expanduser(str(source))).resolve())] = file_id
        return result

    def send_album(
        self,
        chat_id: Union[int, str],
        sources: Sequence[PhotoSource],
        caption: Optional[str] = None,
    ) -> list[dict]:
        """2-10 images as a single album. Caption goes on the first item only."""
        if not 2 <= len(sources) <= 10:
            raise ValueError("sendMediaGroup takes between 2 and 10 items")

        media: list[dict] = []
        files: dict[str, tuple] = {}
        for i, src in enumerate(sources):
            entry: dict[str, Any] = {"type": "photo"}
            if i == 0 and caption:
                entry["caption"] = caption[:CAPTION_LIMIT]
            kind = self._classify(src)
            if kind in ("url", "file_id"):
                entry["media"] = str(src)
            else:
                blob = src if isinstance(src, bytes) else Path(
                    os.path.expanduser(str(src))).read_bytes()
                tag = f"file{i}"
                files[tag] = (f"{tag}.jpg", blob, sniff_mime(blob))
                entry["media"] = f"attach://{tag}"
            media.append(entry)

        import json
        return self._api("sendMediaGroup",
                         {"chat_id": chat_id, "media": json.dumps(media)},
                         files=files or None)

    # -- polling ------------------------------------------------------------ #

    def poll(
        self,
        on_photo: Callable[[IncomingPhoto], None],
        on_album: Optional[Callable[[list[IncomingPhoto]], None]] = None,
        long_poll: int = 25,
        auto_download: bool = True,
        allowed_updates: Iterable[str] = ("message", "edited_message"),
    ) -> None:
        """Blocking long-poll loop. Ctrl-C to stop."""
        buffer = MediaGroupBuffer()
        while True:
            params: dict[str, Any] = {
                "timeout": long_poll,
                "allowed_updates": '["' + '","'.join(allowed_updates) + '"]',
            }
            if self._offset is not None:
                params["offset"] = self._offset
            try:
                updates = self._api("getUpdates", params, timeout=long_poll + 10)
            except TelegramError as exc:
                print(f"[poll] {exc}; backing off 5s")
                time.sleep(5)
                continue

            for upd in updates:
                self._offset = upd["update_id"] + 1
                msg = upd.get("message") or upd.get("edited_message")
                if not msg:
                    continue
                for photo in extract_photos(msg):
                    if auto_download:
                        try:
                            self.download(photo)
                        except TelegramError as exc:
                            print(f"[poll] download skipped: {exc}")
                            continue
                    if photo.media_group_id and on_album:
                        buffer.add(photo)
                    else:
                        on_photo(photo)

            if on_album:
                for batch in buffer.flush_ready():
                    on_album(batch)


# --------------------------------------------------------------------------- #
# Example wiring
# --------------------------------------------------------------------------- #

if __name__ == "__main__":
    tg = TelegramPhotos(os.environ["TELEGRAM_BOT_TOKEN"])

    def handle_photo(p: IncomingPhoto) -> None:
        print(f"got {p.local_path} ({p.mime}, {p.file_size}B) caption={p.caption!r}")
        # payload = tg.as_vision_payload(p)  -> hand to the model
        tg.send_photo(p.chat_id, p.file_id, caption="Got it — looking now.",
                      reply_to=p.message_id)

    def handle_album(batch: list[IncomingPhoto]) -> None:
        print(f"album of {len(batch)}, shared caption {batch[0].caption!r}")

    tg.poll(on_photo=handle_photo, on_album=handle_album)


# --------------------------------------------------------------------------- #
# Notes / gotchas
#
# 1. message["photo"] is a list of PhotoSize objects ascending by resolution.
#    Take [-1]. Telegram has already recompressed it to JPEG — if the user needs
#    the original (paint defect photos, colour matching), tell them to send it as
#    a file, which lands in message["document"] instead.
# 2. file_id is bot-specific and may change over time; file_unique_id is stable
#    but cannot be used to download. Dedup on file_unique_id, download on file_id.
# 3. getFile responses expire after ~1 hour. Don't cache the file_path URL, and
#    don't log it — the bot token is embedded in it.
# 4. Downloads cap at 20MB via the cloud API. Running a local Bot API server
#    (telegram-bot-api) raises that to 2GB and lets you read files straight off
#    disk with no HTTP hop, which is worth it if you start doing bulk photos.
# 5. Outbound photos: 10MB via multipart, 5MB by URL, width+height <= 10000, and
#    aspect ratio <= 20:1. Anything outside that gets rejected; send as a
#    document instead. Captions cap at 1024 characters, not 4096.
# 6. Re-sending an image you already sent or received? Pass its file_id — no
#    upload, near-instant. The cache in this module does that for local paths.
# 7. Albums are N separate updates sharing media_group_id and only one caption.
#    MediaGroupBuffer waits for a 1.5s gap before flushing them as a unit.
# 8. Sniff the mime from magic bytes before handing anything to a vision model.
#    Telegram will happily deliver a .png that is really a JPEG, and vision APIs
#    reject a mismatched media_type.
# 9. Only one process can call getUpdates per token. If a webhook was ever set,
#    deleteWebhook first or polling silently returns nothing.
# --------------------------------------------------------------------------- #
