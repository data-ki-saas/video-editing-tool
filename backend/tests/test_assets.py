from tests.conftest import TEST_USER


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
