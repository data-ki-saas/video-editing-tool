import uuid

import boto3
import pytest
from httpx import ASGITransport, AsyncClient
from moto.server import ThreadedMotoServer

from src.assets import repository
from src.core.auth import CurrentUser, get_current_user
from src.core.config import settings

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

    yield endpoint
    server.stop()


@pytest.fixture(autouse=True)
def r2_settings(moto_r2_server, monkeypatch):
    monkeypatch.setattr(settings, "r2_endpoint_override", moto_r2_server)
    monkeypatch.setattr(settings, "r2_access_key_id", "test")
    monkeypatch.setattr(settings, "r2_secret_access_key", "test")
    monkeypatch.setattr(settings, "r2_bucket_name", "test-bucket")


class FakeAssetsTable:
    """In-memory stand-in for the Supabase `projects`/`assets` tables used in
    router/service tests -- avoids hitting a real Supabase project."""

    def __init__(self):
        self.projects: dict[str, dict] = {}
        self.assets: dict[str, dict] = {}

    def add_project(self, owner_id: str) -> str:
        project_id = str(uuid.uuid4())
        self.projects[project_id] = {"id": project_id, "owner_id": owner_id}
        return project_id

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


@pytest.fixture
def fake_assets_table(monkeypatch):
    table = FakeAssetsTable()
    monkeypatch.setattr(repository, "project_owned_by", table.project_owned_by)
    monkeypatch.setattr(repository, "create_asset", lambda **kwargs: table.create(id=str(uuid.uuid4()), **kwargs))
    monkeypatch.setattr(repository, "list_assets_for_project", table.list_for_project)
    monkeypatch.setattr(repository, "get_asset", table.get)
    monkeypatch.setattr(repository, "delete_asset", table.delete)
    return table


@pytest.fixture
async def client(fake_assets_table):
    from src.main import app

    app.dependency_overrides[get_current_user] = lambda: TEST_USER
    transport = ASGITransport(app=app)
    async with AsyncClient(transport=transport, base_url="http://test") as ac:
        yield ac
    app.dependency_overrides.clear()
