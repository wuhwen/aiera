from fastapi.testclient import TestClient

from app.database import Base, engine
from app.main import app


def test_full_review_flow():
    Base.metadata.drop_all(bind=engine)
    Base.metadata.create_all(bind=engine)
    with TestClient(app) as client:
        project = client.post("/api/projects", json={"title": "测试播客"}).json()
        upload = client.post(
            f"/api/projects/{project['id']}/upload-session",
            json={"filename": "episode.mp3", "size_bytes": 1024, "content_type": "audio/mpeg"},
        )
        assert upload.status_code == 200
        session = upload.json()
        job = client.post(
            f"/api/projects/{project['id']}/process",
            json={"object_key": session["object_key"], "duration_ms": 120000},
        ).json()
        assert client.get(f"/api/jobs/{job['id']}").json()["status"] == "review"

        transcript = client.get(f"/api/projects/{project['id']}/transcript").json()
        plans = client.get(f"/api/projects/{project['id']}/plans").json()["plans"]
        assert len(transcript["segments"]) == 9
        assert {item["mode"] for item in plans} == {"conservative", "restructured"}

        saved = client.put(
            f"/api/projects/{project['id']}/timeline",
            json={"title": "审核完成", "segments": plans[0]["segments"]},
        )
        assert saved.status_code == 200
        assert saved.json()["version"] == 1


def test_register_login_and_authenticated_project_owner():
    Base.metadata.drop_all(bind=engine)
    Base.metadata.create_all(bind=engine)
    with TestClient(app) as client:
        registered = client.post(
            "/api/auth/register",
            json={"email": "editor@example.com", "password": "secret123", "display_name": "剪辑师"},
        )
        assert registered.status_code == 201
        token = registered.json()["token"]
        me = client.get("/api/auth/me", headers={"Authorization": f"Bearer {token}"})
        assert me.status_code == 200
        assert me.json()["display_name"] == "剪辑师"

        project = client.post(
            "/api/projects",
            json={"title": "账号项目"},
            headers={"Authorization": f"Bearer {token}"},
        )
        assert project.status_code == 201
        assert client.get("/api/projects").json() == []
        owned = client.get("/api/projects", headers={"Authorization": f"Bearer {token}"}).json()
        assert len(owned) == 1
        assert owned[0]["title"] == "账号项目"

        logged_in = client.post("/api/auth/login", json={"email": "editor@example.com", "password": "secret123"})
        assert logged_in.status_code == 200
        assert logged_in.json()["user"]["email"] == "editor@example.com"


def test_rejects_fabricated_segment():
    Base.metadata.drop_all(bind=engine)
    Base.metadata.create_all(bind=engine)
    with TestClient(app) as client:
        project = client.post("/api/projects", json={"title": "非法时间线"}).json()
        client.post(f"/api/projects/{project['id']}/process", json={"duration_ms": 60000})
        plans = client.get(f"/api/projects/{project['id']}/plans").json()["plans"]
        plans[0]["segments"][0]["segment_id"] = "fabricated"
        response = client.put(
            f"/api/projects/{project['id']}/timeline",
            json={"segments": plans[0]["segments"]},
        )
        assert response.status_code == 422


def test_upload_and_stream_source_audio():
    Base.metadata.drop_all(bind=engine)
    Base.metadata.create_all(bind=engine)
    with TestClient(app) as client:
        project = client.post("/api/projects", json={"title": "可预览播客"}).json()
        audio = b"RIFF$\x00\x00\x00WAVEfmt "
        upload = client.post(
            f"/api/projects/{project['id']}/source",
            files={"file": ("preview.wav", audio, "audio/wav")},
        )
        assert upload.status_code == 200
        payload = upload.json()
        assert payload["media_url"] == f"/api/projects/{project['id']}/source"

        stream = client.get(payload["media_url"])
        assert stream.status_code == 200
        assert stream.content == audio
        assert stream.headers["content-type"].startswith("audio/")


def test_process_accepts_long_source_object_key():
    Base.metadata.drop_all(bind=engine)
    Base.metadata.create_all(bind=engine)
    with TestClient(app) as client:
        project = client.post("/api/projects", json={"title": "长文件名播客"}).json()
        long_name = "播客第四期去口癖版第1稿" * 8 + ".mp3"
        upload = client.post(
            f"/api/projects/{project['id']}/source",
            files={"file": (long_name, b"ID3\x04\x00\x00", "audio/mpeg")},
        ).json()
        response = client.post(
            f"/api/projects/{project['id']}/process",
            json={"object_key": upload["object_key"], "duration_ms": 60000},
        )
        assert response.status_code == 202
