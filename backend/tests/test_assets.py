import botocore.exceptions

from src.core.config import settings
from src.storage import r2_client
from tests.conftest import TEST_USER


def _object_exists(storage_key: str) -> bool:
    try:
        r2_client.get_r2_client().head_object(Bucket=settings.r2_bucket_name, Key=storage_key)
        return True
    except botocore.exceptions.ClientError as exc:
        if exc.response["Error"]["Code"] in ("404", "NoSuchKey"):
            return False
        raise


async def test_upload_asset_rejects_unsupported_type(client, fake_assets_table):
    project_id = fake_assets_table.add_project(TEST_USER.id)
    files = {"file": ("clip.txt", b"not a video", "text/plain")}
    response = await client.post("/api/assets", params={"project_id": project_id}, files=files)
    assert response.status_code == 400


async def test_upload_and_list_asset(client, fake_assets_table):
    project_id = fake_assets_table.add_project(TEST_USER.id)
    files = {"file": ("clip.mp4", b"fake video bytes", "video/mp4")}
    upload = await client.post("/api/assets", params={"project_id": project_id}, files=files)
    assert upload.status_code == 201
    asset = upload.json()
    assert asset["kind"] == "video"

    listing = await client.get("/api/assets", params={"project_id": project_id})
    assert listing.status_code == 200
    assert len(listing.json()) == 1


async def test_upload_asset_rejects_unowned_project(client):
    files = {"file": ("clip.mp4", b"fake video bytes", "video/mp4")}
    response = await client.post("/api/assets", params={"project_id": "not-mine"}, files=files)
    assert response.status_code == 404


async def test_duplicate_upload_reuses_storage_key_instead_of_re_uploading(client, fake_assets_table):
    project_id = fake_assets_table.add_project(TEST_USER.id)
    files = {"file": ("clip.mp4", b"identical bytes", "video/mp4")}

    first = await client.post("/api/assets", params={"project_id": project_id}, files=files)
    second = await client.post("/api/assets", params={"project_id": project_id}, files=files)
    assert first.status_code == 201
    assert second.status_code == 201

    first_asset, second_asset = first.json(), second.json()
    assert first_asset["id"] != second_asset["id"]  # each upload still gets its own asset row

    first_key = fake_assets_table.assets[first_asset["id"]]["storage_key"]
    second_key = fake_assets_table.assets[second_asset["id"]]["storage_key"]
    assert first_key == second_key  # ...but they share one underlying R2 object


async def test_deleting_one_deduped_asset_keeps_the_shared_object(client, fake_assets_table):
    project_id = fake_assets_table.add_project(TEST_USER.id)
    files = {"file": ("clip.mp4", b"identical bytes", "video/mp4")}

    first = (await client.post("/api/assets", params={"project_id": project_id}, files=files)).json()
    second = (await client.post("/api/assets", params={"project_id": project_id}, files=files)).json()
    storage_key = fake_assets_table.assets[first["id"]]["storage_key"]
    assert _object_exists(storage_key)

    delete_first = await client.delete(f"/api/assets/{first['id']}")
    assert delete_first.status_code == 204
    assert _object_exists(storage_key)  # second asset still references it

    delete_second = await client.delete(f"/api/assets/{second['id']}")
    assert delete_second.status_code == 204
    assert not _object_exists(storage_key)  # last reference gone -> object cleaned up
