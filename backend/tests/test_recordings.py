import uuid

import botocore.exceptions

from src.core.auth import CurrentUser, get_current_user
from src.core.config import settings
from src.main import app
from src.storage import r2_client
from tests.conftest import TEST_USER

# No recordings_unlimited feature -- exercises recordings/service.py's
# FREE_RECORDINGS_LIMIT, unlike TEST_USER (full FEATURE_KEYS access via
# tests/conftest.py). Mirrors test_permissions.py's own FREE_USER.
FREE_USER = CurrentUser(
    id="free-recordings-user",
    email="free@example.com",
    role="free_user",
    role_label="Free",
    features=frozenset({"assets_manage"}),
)


def _as(user: CurrentUser) -> None:
    app.dependency_overrides[get_current_user] = lambda: user


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


async def test_free_account_is_blocked_at_the_recordings_cap(client, fake_recordings_table):
    _as(FREE_USER)
    for i in range(15):
        fake_recordings_table.create(
            id=str(uuid.uuid4()),
            user_id=FREE_USER.id,
            name=f"Recording {i}",
            description=None,
            kind="video",
            mime_type="video/mp4",
            size_bytes=10,
            storage_key=f"recordings/{FREE_USER.id}/{i}",
            duration_seconds=1,
        )

    files = {"file": ("clip.mp4", b"fake video bytes", "video/mp4")}
    response = await client.post("/api/recordings", data={"name": "One too many"}, files=files)
    assert response.status_code == 429


async def test_free_account_under_the_cap_can_still_upload(client, fake_recordings_table):
    _as(FREE_USER)
    for i in range(14):
        fake_recordings_table.create(
            id=str(uuid.uuid4()),
            user_id=FREE_USER.id,
            name=f"Recording {i}",
            description=None,
            kind="video",
            mime_type="video/mp4",
            size_bytes=10,
            storage_key=f"recordings/{FREE_USER.id}/{i}",
            duration_seconds=1,
        )

    files = {"file": ("clip.mp4", b"fake video bytes", "video/mp4")}
    response = await client.post("/api/recordings", data={"name": "Just under the limit"}, files=files)
    assert response.status_code == 201


async def test_recordings_unlimited_feature_bypasses_the_cap(client, fake_recordings_table):
    for i in range(20):
        fake_recordings_table.create(
            id=str(uuid.uuid4()),
            user_id=TEST_USER.id,
            name=f"Recording {i}",
            description=None,
            kind="video",
            mime_type="video/mp4",
            size_bytes=10,
            storage_key=f"recordings/{TEST_USER.id}/{i}",
            duration_seconds=1,
        )

    # TEST_USER has every feature (including recordings_unlimited) -- see
    # tests/conftest.py's own comment on why.
    files = {"file": ("clip.mp4", b"fake video bytes", "video/mp4")}
    response = await client.post("/api/recordings", data={"name": "Past 15, but unlimited"}, files=files)
    assert response.status_code == 201


class _StubMp4Info:
    def __init__(self, length: float):
        self.length = length


class _StubMp4:
    def __init__(self, length: float):
        self.info = _StubMp4Info(length)


async def test_upload_recording_rejects_video_over_the_duration_cap(client, fake_recordings_table, monkeypatch):
    from src.recordings import service as recordings_service

    monkeypatch.setattr(recordings_service, "MP4", lambda _stream: _StubMp4(200.0))
    files = {"file": ("clip.mp4", b"irrelevant -- MP4() is mocked", "video/mp4")}
    response = await client.post("/api/recordings", data={"name": "Too long"}, files=files)
    assert response.status_code == 400


async def test_upload_recording_uses_server_probed_duration_over_client_value(
    client, fake_recordings_table, monkeypatch
):
    from src.recordings import service as recordings_service

    monkeypatch.setattr(recordings_service, "MP4", lambda _stream: _StubMp4(42.0))
    files = {"file": ("clip.mp4", b"irrelevant -- MP4() is mocked", "video/mp4")}
    upload = await client.post(
        "/api/recordings", data={"name": "Clip", "duration_seconds": "999"}, files=files
    )
    assert upload.status_code == 201
    assert upload.json()["duration_seconds"] == 42.0


async def test_upload_recording_skips_duration_check_when_unparseable(client, fake_recordings_table):
    # Real CameraCapturePage/Upload-button files are always well-formed mp4s
    # (mediabunny's own Mp4OutputFormat) -- this covers the fail-open path
    # for the rare unparseable case (see _probe_video_duration_seconds's own
    # comment), same convention as avatar/service.py's probe.
    files = {"file": ("clip.mp4", b"not actually a valid mp4 container", "video/mp4")}
    response = await client.post("/api/recordings", data={"name": "Clip", "duration_seconds": "12"}, files=files)
    assert response.status_code == 201
    assert response.json()["duration_seconds"] == 12.0


async def test_add_recording_to_project_rejects_unowned_project(client, fake_recordings_table):
    files = {"file": ("clip.mp4", b"fake video bytes", "video/mp4")}
    recording = (await client.post("/api/recordings", data={"name": "Clip"}, files=files)).json()

    response = await client.post(
        f"/api/recordings/{recording['id']}/add-to-project", json={"project_id": "not-mine"}
    )
    assert response.status_code == 404
