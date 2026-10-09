import asyncio
import httpx
import uuid
import websockets
import json

BASE_URL = "http://localhost:8000"

async def test_e2e():
    async with httpx.AsyncClient(base_url=BASE_URL) as client:
        # Wait for API to be healthy
        for _ in range(10):
            try:
                resp = await client.get("/api/health/ready")
                if resp.status_code == 200:
                    break
            except httpx.RequestError:
                pass
            await asyncio.sleep(2)
        else:
            raise Exception("API not ready")

        print("✅ API ready")

        # 1. Register a user
        username = f"e2e_{uuid.uuid4().hex[:8]}"
        user_data = {
            "username": username,
            "password": "pw",
            "avatar": {
                "head": "h1",
                "body": "b1",
                "legs": "l1",
                "feet": "f1",
                "animation": "a1",
                "gender": "male"
            }
        }
        res = await client.post("/api/auth/signup/", json=user_data)
        assert res.status_code == 200
        token = res.json()["access_token"]
        headers = {"Authorization": f"Bearer {token}"}

        # 2. Create a squad
        res = await client.post("/api/squads/", headers=headers, json={"name": "e2e_squad"})
        assert res.status_code == 200
        squad_id = res.json()["id"]

        print("✅ Squad created")

        # 3. Request WS ticket
        res = await client.post(f"/api/squads/{squad_id}/ws-ticket", headers=headers)
        assert res.status_code == 200
        ticket = res.json()["ticket"]

        # 4. Connect to WS
        ws_url = f"ws://localhost:8000/api/squads/{squad_id}/ws"
        async with websockets.connect(ws_url, subprotocols=["beercall", f"ticket.{ticket}"]) as ws:
            print("✅ WS connected securely")

            # 5. Concurrent job creation (idempotency test)
            idem_key = str(uuid.uuid4())
            valid_png = b'\x89PNG\r\n\x1a\n\x00\x00\x00\rIHDR\x00\x00\x00\x01\x00\x00\x00\x01\x08\x06\x00\x00\x00\x1f\x15\xc4\x89\x00\x00\x00\nIDATx\x9cc\x00\x01\x00\x00\x05\x00\x01\r\n-\xb4\x00\x00\x00\x00IEND\xaeB`\x82'

            async def create_job():
                files = {"file": ("test.png", valid_png, "image/png")}
                data = {"latitude": "48.0", "longitude": "2.0", "location_name": "E2E Bar"}
                # Create a fresh client for each request inside the thread
                async with httpx.AsyncClient(base_url=BASE_URL) as c:
                    return await c.post(
                        f"/api/squads/{squad_id}/beer-calls/",
                        headers={**headers, "Idempotency-Key": idem_key},
                        data=data,
                        files=files
                    )

            res1, res2 = await asyncio.gather(create_job(), create_job())
            assert res1.status_code == 202
            assert res2.status_code == 202
            assert res1.json()["job_id"] == res2.json()["job_id"]

            job_id = res1.json()["job_id"]
            print(f"✅ Job {job_id} enqueued safely")

            # 6. Poll for job completion
            success = False
            for _ in range(20): # max 20s
                res = await client.get(f"/api/squads/{squad_id}/beer-calls/jobs/{job_id}", headers=headers)
                if res.json()["status"] == "succeeded":
                    success = True
                    break
                await asyncio.sleep(1)

            assert success, "Job did not succeed"
            print("✅ Job processed successfully by workers")

            # 7. Check outbox / WS message
            ws_msg = await asyncio.wait_for(ws.recv(), timeout=5.0)
            data = json.loads(ws_msg)
            assert data.get("type") == "REFRESH_SQUAD" and data.get("action") == "CREATE"
            print("✅ WS Outbox event received")

if __name__ == "__main__":
    asyncio.run(test_e2e())
