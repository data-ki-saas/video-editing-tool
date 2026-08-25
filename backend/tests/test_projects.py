import botocore.exceptions

from src.core.config import settings
from src.storage import r2_client
from tests.conftest import TEST_USER


def _uploads_object_exists(storage_key: str) -> bool:
    try:
        r2_client.get_r2_client().head_object(Bucket=settings.r2_bucket_name, Key=storage_key)
        return True
    except botocore.exceptions.ClientError as exc:
        if exc.response["Error"]["Code"] in ("404", "NoSuchKey"):
            return False
        raise


def _put_render_object(project_id: str, render_id: str) -> None:
    key = f"renders/{project_id}/{render_id}.mp4"
    r2_client.get_r2_renders_client().put_object(Bucket=settings.r2_renders_bucket_name, Key=key, Body=b"fake mp4")


def _render_object_exists(project_id: str, render_id: str) -> bool:
    key = f"renders/{project_id}/{render_id}.mp4"
    try:
        r2_client.get_r2_renders_client().head_object(Bucket=settings.r2_renders_bucket_name, Key=key)
        return True
    except botocore.exceptions.ClientError as exc:
        if exc.response["Error"]["Code"] in ("404", "NoSuchKey"):
            return False
        raise


async def test_delete_project_rejects_unowned_project(client):
    response = await client.delete("/api/projects/not-mine")
    assert response.status_code == 404


async def test_delete_project_removes_its_assets_from_r2(client, fake_assets_table):
    project_id = fake_assets_table.add_project(TEST_USER.id)
    files = {"file": ("clip.mp4", b"fake video bytes", "video/mp4")}
    asset = (await client.post("/api/assets", params={"project_id": project_id}, files=files)).json()
    storage_key = fake_assets_table.assets[asset["id"]]["storage_key"]
    assert _uploads_object_exists(storage_key)

    response = await client.delete(f"/api/projects/{project_id}")
    assert response.status_code == 204
    assert not _uploads_object_exists(storage_key)
    assert project_id not in fake_assets_table.projects


async def test_delete_project_removes_its_finished_render_from_r2(client, fake_assets_table):
    render_id = "render-1"
    project_id = fake_assets_table.add_project(
        TEST_USER.id, render_id=render_id, render_status="completed", render_url="https://videos.example.com/x.mp4"
    )
    _put_render_object(project_id, render_id)
    assert _render_object_exists(project_id, render_id)

    response = await client.delete(f"/api/projects/{project_id}")
    assert response.status_code == 204
    assert not _render_object_exists(project_id, render_id)


async def test_delete_project_without_a_render_does_not_touch_the_renders_bucket(client, fake_assets_table):
    project_id = fake_assets_table.add_project(TEST_USER.id)

    response = await client.delete(f"/api/projects/{project_id}")
    assert response.status_code == 204


async def test_reset_project_rejects_unowned_project(client):
    response = await client.post("/api/projects/not-mine/reset")
    assert response.status_code == 404


async def test_reset_project_removes_assets_from_r2_but_keeps_the_project(client, fake_assets_table):
    project_id = fake_assets_table.add_project(TEST_USER.id)
    files = {"file": ("clip.mp4", b"fake video bytes", "video/mp4")}
    asset = (await client.post("/api/assets", params={"project_id": project_id}, files=files)).json()
    storage_key = fake_assets_table.assets[asset["id"]]["storage_key"]
    assert _uploads_object_exists(storage_key)

    response = await client.post(f"/api/projects/{project_id}/reset")
    assert response.status_code == 204
    assert not _uploads_object_exists(storage_key)
    assert project_id in fake_assets_table.projects
    assert fake_assets_table.list_for_project(project_id, TEST_USER.id) == []


async def test_reset_project_removes_its_finished_render_from_r2_and_clears_render_state(client, fake_assets_table):
    render_id = "render-1"
    project_id = fake_assets_table.add_project(
        TEST_USER.id, render_id=render_id, render_status="completed", render_url="https://videos.example.com/x.mp4"
    )
    _put_render_object(project_id, render_id)
    assert _render_object_exists(project_id, render_id)

    response = await client.post(f"/api/projects/{project_id}/reset")
    assert response.status_code == 204
    assert not _render_object_exists(project_id, render_id)
    row = fake_assets_table.projects[project_id]
    assert row["render_id"] is None
    assert row["render_status"] is None
    assert row["render_url"] is None


async def test_reset_project_without_a_render_does_not_touch_the_renders_bucket(client, fake_assets_table):
    project_id = fake_assets_table.add_project(TEST_USER.id)

    response = await client.post(f"/api/projects/{project_id}/reset")
    assert response.status_code == 204
