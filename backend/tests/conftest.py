import uuid

import boto3
import pytest
from httpx import ASGITransport, AsyncClient
from moto.server import ThreadedMotoServer

from src.assets import repository
from src.core.auth import CurrentUser, get_current_user
from src.core.config import settings
from src.projects import repository as projects_repository

TEST_USER = CurrentUser(id="test-user-id", email="test@example.com")


@pytest.fixture(scope="session")
def moto_r2_server():
    server = ThreadedMotoServer(port=0)
    server.start()
    port = server._server.socket.getsockname()[1]
    endpoint = f"http://127.0.0.1:{port}"

    client = boto3.client(
        "s3",
        endpoint_url=endpoint,
        aws_access_key_id="test",
        aws_secret_access_key="test",
        region_name="us-east-1",
    )
    client.create_bucket(Bucket="test-bucket")
    client.create_bucket(Bucket="test-renders-bucket")

    yield endpoint
    server.stop()


@pytest.fixture(autouse=True)
def r2_settings(moto_r2_server, monkeypatch):
    monkeypatch.setattr(settings, "r2_endpoint_override", moto_r2_server)
    monkeypatch.setattr(settings, "r2_access_key_id", "test")
    monkeypatch.setattr(settings, "r2_secret_access_key", "test")
    monkeypatch.setattr(settings, "r2_bucket_name", "test-bucket")
    # Deliberately a distinct token from the uploads bucket's above, same as
    # in a real deploy (see DEPLOY.md step 2b) -- both point at the same moto
    # server, just a different bucket, which is all delete_render_object cares
    # about for these tests.
    monkeypatch.setattr(settings, "r2_renders_access_key_id", "test")
    monkeypatch.setattr(settings, "r2_renders_secret_access_key", "test")
    monkeypatch.setattr(settings, "r2_renders_bucket_name", "test-renders-bucket")
    # Doesn't need to be a real public URL in tests -- upload_public_object/
    # thumbnail_key_from_url only need it to round-trip consistently.
    monkeypatch.setattr(settings, "r2_renders_public_url", f"{moto_r2_server}/test-renders-bucket")


class FakeAssetsTable:
    """In-memory stand-in for the Supabase `projects`/`assets` tables used in
    router/service tests -- avoids hitting a real Supabase project."""

    def __init__(self):
        self.projects: dict[str, dict] = {}
        self.assets: dict[str, dict] = {}

    def add_project(
        self,
        owner_id: str,
        *,
        render_id: str | None = None,
        render_status: str | None = None,
        render_url: str | None = None,
        thumbnail_url: str | None = None,
        thumbnail_source: str | None = None,
        thumbnail_time_seconds: float | None = None,
    ) -> str:
        project_id = str(uuid.uuid4())
        self.projects[project_id] = {
            "id": project_id,
            "owner_id": owner_id,
            "render_id": render_id,
            "render_status": render_status,
            "render_url": render_url,
            "thumbnail_url": thumbnail_url,
            "thumbnail_source": thumbnail_source,
            "thumbnail_time_seconds": thumbnail_time_seconds,
        }
        return project_id

    def get_project(self, project_id: str, owner_id: str) -> projects_repository.ProjectRecord | None:
        row = self.projects.get(project_id)
        if row is None or row["owner_id"] != owner_id:
            return None
        return projects_repository.ProjectRecord(
            id=row["id"],
            render_id=row["render_id"],
            render_status=row["render_status"],
            render_url=row["render_url"],
            thumbnail_url=row["thumbnail_url"],
            thumbnail_source=row["thumbnail_source"],
            thumbnail_time_seconds=row["thumbnail_time_seconds"],
        )

    def delete_project(self, project_id: str) -> None:
        self.projects.pop(project_id, None)
        for asset_id in [aid for aid, row in self.assets.items() if row["project_id"] == project_id]:
            del self.assets[asset_id]

    def clear_render_state(self, project_id: str) -> None:
        row = self.projects.get(project_id)
        if row is not None:
            row["render_id"] = None
            row["render_status"] = None
            row["render_url"] = None

    def set_thumbnail(self, project_id: str, *, url: str, source: str, time_seconds: float | None) -> None:
        row = self.projects.get(project_id)
        if row is not None:
            row["thumbnail_url"] = url
            row["thumbnail_source"] = source
            row["thumbnail_time_seconds"] = time_seconds

    def clear_thumbnail(self, project_id: str) -> None:
        row = self.projects.get(project_id)
        if row is not None:
            row["thumbnail_url"] = None
            row["thumbnail_source"] = None
            row["thumbnail_time_seconds"] = None

    def project_owned_by(self, project_id: str, owner_id: str) -> bool:
        project = self.projects.get(project_id)
        return project is not None and project["owner_id"] == owner_id

    def create(self, **payload) -> repository.AssetRecord:
        payload = {"created_at": "2026-01-01T00:00:00Z", **payload}
        self.assets[payload["id"]] = payload
        return repository.AssetRecord(**payload)

    def list_for_project(self, project_id: str, owner_id: str) -> list[repository.AssetRecord]:
        if not self.project_owned_by(project_id, owner_id):
            return []
        return [
            repository.AssetRecord(**row)
            for row in self.assets.values()
            if row["project_id"] == project_id
        ]

    def get(self, asset_id: str, owner_id: str) -> repository.AssetRecord | None:
        row = self.assets.get(asset_id)
        if row is None or not self.project_owned_by(row["project_id"], owner_id):
            return None
        return repository.AssetRecord(**row)

    def delete(self, asset_id: str, owner_id: str) -> repository.AssetRecord | None:
        record = self.get(asset_id, owner_id)
        if record is not None:
            del self.assets[asset_id]
        return record

    def find_by_content_hash(self, uploaded_by: str, content_hash: str) -> repository.AssetRecord | None:
        for row in self.assets.values():
            if row["uploaded_by"] == uploaded_by and row.get("content_hash") == content_hash:
                return repository.AssetRecord(**row)
        return None

    def count_with_storage_key(self, storage_key: str) -> int:
        return sum(1 for row in self.assets.values() if row["storage_key"] == storage_key)


@pytest.fixture
def fake_assets_table(monkeypatch):
    table = FakeAssetsTable()
    monkeypatch.setattr(repository, "project_owned_by", table.project_owned_by)
    monkeypatch.setattr(repository, "create_asset", lambda **kwargs: table.create(id=str(uuid.uuid4()), **kwargs))
    monkeypatch.setattr(repository, "list_assets_for_project", table.list_for_project)
    monkeypatch.setattr(repository, "get_asset", table.get)
    monkeypatch.setattr(repository, "delete_asset", table.delete)
    monkeypatch.setattr(repository, "find_by_content_hash", table.find_by_content_hash)
    monkeypatch.setattr(repository, "count_assets_with_storage_key", table.count_with_storage_key)
    monkeypatch.setattr(projects_repository, "get_project", table.get_project)
    monkeypatch.setattr(projects_repository, "delete_project", table.delete_project)
    monkeypatch.setattr(projects_repository, "clear_render_state", table.clear_render_state)
    monkeypatch.setattr(projects_repository, "set_thumbnail", table.set_thumbnail)
    monkeypatch.setattr(projects_repository, "clear_thumbnail", table.clear_thumbnail)
    return table


@pytest.fixture
async def client(fake_assets_table):
    from src.main import app

    app.dependency_overrides[get_current_user] = lambda: TEST_USER
    transport = ASGITransport(app=app)
    async with AsyncClient(transport=transport, base_url="http://test") as ac:
        yield ac
    app.dependency_overrides.clear()
