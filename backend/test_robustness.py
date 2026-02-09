import asyncio
import websockets
import json
import base64
import time

# Configuration
BACKEND_URL = "ws://localhost:8001/google-proxy"

async def test_robustness():
    print(f"Connecting to {BACKEND_URL}...")
    headers = {"Origin": "http://localhost:3002"}
    try:
        async with websockets.connect(BACKEND_URL, additional_headers=headers) as ws:
            print("Connected. Waiting for setupComplete...")
            
            # 1. Wait for setupComplete
            setup_response = await asyncio.wait_for(ws.recv(), timeout=10.0)
            print(f"Setup Response: {setup_response}")
            
            # 2. Simulate 3 turns of "speech" (silence chunks) and check for responses
            for turn in range(1, 4):
                print(f"\n--- Turn {turn} ---")
                
                # Send 2 seconds of "audio" (silence PCM 16kHz)
                # 32000 samples * 2 bytes = 64000 bytes
                # We send in 4000-sample chunks (8000 bytes) to match frontend behavior
                silence_chunk = base64.b64encode(b'\x00' * 8000).decode('utf-8')
                
                for i in range(8): # 8 * 4000 samples = 32000 samples = 2 seconds
                    audio_msg = {
                        "realtime_input": {
                            "media_chunks": [
                                {"mime_type": "audio/pcm;rate=16000", "data": silence_chunk}
                            ]
                        }
                    }
                    await ws.send(json.dumps(audio_msg))
                    await asyncio.sleep(0.25) # Send every 250ms
                
                print(f"Sent Turn {turn} audio. Waiting for response...")
                
                # Wait for audio chunks from Gemini
                chunks_received = 0
                start_time = time.time()
                while time.time() - start_time < 10.0: # Wait up to 10s for some response
                    try:
                        resp = await asyncio.wait_for(ws.recv(), timeout=1.0)
                        if isinstance(resp, bytes):
                            chunks_received += 1
                        elif "audio" in str(resp):
                            chunks_received += 1
                        
                        if chunks_received >= 5: # If we get at least 5 chunks, consider it a response
                            print(f"Success: Received {chunks_received} audio chunks from Gemini in turn {turn}")
                            break
                    except asyncio.TimeoutError:
                        continue
                
                if chunks_received < 5:
                    print(f"Warning: Only received {chunks_received} chunks in turn {turn}")
            
            print("\nRobustness test completed.")
            
    except Exception as e:
        print(f"Test Error: {e}")

if __name__ == "__main__":
    asyncio.run(test_robustness())
