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


async def test_upload_recording_rejects_unsupported_type(client, fake_recordings_table):
    files = {"file": ("clip.txt", b"not a video", "text/plain")}
    response = await client.post("/api/recordings", data={"name": "Clip"}, files=files)
    assert response.status_code == 400


async def test_upload_and_list_recording(client, fake_recordings_table):
    files = {"file": ("clip.mp4", b"fake video bytes", "video/mp4")}
    upload = await client.post(
        "/api/recordings", data={"name": "My clip", "duration_seconds": "12.5"}, files=files
    )
    assert upload.status_code == 201
    recording = upload.json()
    assert recording["kind"] == "video"
    assert recording["name"] == "My clip"
    assert recording["duration_seconds"] == 12.5

    listing = await client.get("/api/recordings")
    assert listing.status_code == 200
    assert len(listing.json()["recordings"]) == 1


async def test_rename_recording(client, fake_recordings_table):
    files = {"file": ("photo.jpg", b"fake photo bytes", "image/jpeg")}
    upload = (await client.post("/api/recordings", data={"name": "Photo"}, files=files)).json()

    renamed = await client.patch(
        f"/api/recordings/{upload['id']}", json={"name": "Renamed", "description": "A description"}
    )
    assert renamed.status_code == 200
    body = renamed.json()
    assert body["name"] == "Renamed"
    assert body["description"] == "A description"


async def test_rename_recording_rejects_unowned_id(client, fake_recordings_table):
    response = await client.patch("/api/recordings/not-mine", json={"name": "X"})
    assert response.status_code == 404


async def test_replace_content_swaps_storage_and_cleans_up_old_object(client, fake_recordings_table):
    files = {"file": ("clip.mp4", b"original bytes", "video/mp4")}
    upload = (await client.post("/api/recordings", data={"name": "Clip"}, files=files)).json()
    original_key = fake_recordings_table.recordings[upload["id"]]["storage_key"]
    assert _object_exists(original_key)

    new_files = {"file": ("clip-trimmed.mp4", b"trimmed bytes", "video/mp4")}
    replaced = await client.put(
        f"/api/recordings/{upload['id']}/content", data={"duration_seconds": "5"}, files=new_files
    )
    assert replaced.status_code == 200
    body = replaced.json()
    assert body["id"] == upload["id"]  # same recording, overwritten in place
    assert body["duration_seconds"] == 5.0

    new_key = fake_recordings_table.recordings[upload["id"]]["storage_key"]
    assert new_key != original_key
    assert _object_exists(new_key)
    assert not _object_exists(original_key)  # old object cleaned up


async def test_delete_recording_removes_r2_object(client, fake_recordings_table):
    files = {"file": ("clip.mp4", b"fake video bytes", "video/mp4")}
    upload = (await client.post("/api/recordings", data={"name": "Clip"}, files=files)).json()
    storage_key = fake_recordings_table.recordings[upload["id"]]["storage_key"]
    assert _object_exists(storage_key)

    delete = await client.delete(f"/api/recordings/{upload['id']}")
    assert delete.status_code == 204
    assert not _object_exists(storage_key)


async def test_add_recording_to_project_copies_bytes_into_a_new_asset(
    client, fake_recordings_table, fake_assets_table
):
    project_id = fake_assets_table.add_project(TEST_USER.id)
    files = {"file": ("clip.mp4", b"fake video bytes", "video/mp4")}
    recording = (await client.post("/api/recordings", data={"name": "Clip"}, files=files)).json()

    added = await client.post(f"/api/recordings/{recording['id']}/add-to-project", json={"project_id": project_id})
    assert added.status_code == 201
    asset = added.json()
    assert asset["project_id"] == project_id
    assert asset["kind"] == "video"

    recording_key = fake_recordings_table.recordings[recording["id"]]["storage_key"]
    asset_key = fake_assets_table.assets[asset["id"]]["storage_key"]
    assert asset_key != recording_key  # copied into its own object, not shared

    # Deleting the original recording afterward must not affect the asset
    # that was already copied into the project.
    await client.delete(f"/api/recordings/{recording['id']}")
    assert _object_exists(asset_key)


async def test_add_recording_to_project_rejects_unowned_project(client, fake_recordings_table):
    files = {"file": ("clip.mp4", b"fake video bytes", "video/mp4")}
    recording = (await client.post("/api/recordings", data={"name": "Clip"}, files=files)).json()

    response = await client.post(
        f"/api/recordings/{recording['id']}/add-to-project", json={"project_id": "not-mine"}
    )
    assert response.status_code == 404
