from __future__ import annotations

from datetime import date
from typing import Literal

from pydantic import BaseModel, Field, field_validator


class DriveItem(BaseModel):
    name: str
    path: str
    fileType: Literal["folder", "file"]
    mimeType: str | None = None
    sizeBytes: int = 0
    modified: str | None = None
    etag: str | None = None
    fileId: str | None = None
    owner: str | None = None
    starred: bool = False
    shared: bool = False
    trashed: bool = False
    originalPath: str | None = None
    deletedAt: str | None = None


class FileListResponse(BaseModel):
    items: list[DriveItem]
    path: str
    page: int
    limit: int
    total: int


class FolderCreateRequest(BaseModel):
    path: str = "/"
    name: str = Field(min_length=1, max_length=255)


class ItemPatchRequest(BaseModel):
    path: str = Field(min_length=1)
    name: str | None = Field(default=None, max_length=255)
    destination: str | None = None

    @field_validator("name")
    @classmethod
    def validate_name(cls, value: str | None) -> str | None:
        if value is not None and not value.strip():
            raise ValueError("name must not be blank")
        return value


class ItemDeleteRequest(BaseModel):
    path: str = Field(min_length=1)


class FavoriteRequest(BaseModel):
    path: str = Field(min_length=1)
    favorite: bool = True


class ShareCreateRequest(BaseModel):
    path: str = Field(min_length=1)
    shareType: Literal["user", "group", "link"]
    shareWith: str | None = Field(default=None, max_length=255)
    permissions: Literal[1, 31] = 1
    expireDate: date | None = None

    @field_validator("shareWith")
    @classmethod
    def validate_share_with(cls, value: str | None) -> str | None:
        if value is not None and not value.strip():
            raise ValueError("shareWith must not be blank")
        return value


class TrashRestoreRequest(BaseModel):
    path: str = Field(min_length=1)


class TrashDeleteRequest(BaseModel):
    path: str | None = None
    empty: bool = False


class StorageResponse(BaseModel):
    usedBytes: int
    freeBytes: int | None
    totalBytes: int | None
    percentageUsed: float | None
    unlimited: bool
