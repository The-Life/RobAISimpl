import asyncio
import json
import os
import websockets
from dotenv import load_dotenv

async def test_v1beta():
    load_dotenv(override=True)
    key = os.getenv("GOOGLE_API_KEY")
    # Using v1beta instead of v1alpha
    url = f"wss://generativelanguage.googleapis.com/ws/google.ai.generativelanguage.v1beta.GenerativeService.BidiGenerateContent?key={key}"
    
    print(f"Connecting to {url[:80]}...")
    try:
        async with websockets.connect(url) as ws:
            setup_msg = {
                "setup": {
                    "model": "models/gemini-2.0-flash-exp",
                    "generation_config": {
                        "response_modalities": ["AUDIO"]
                    }
                }
            }
            await ws.send(json.dumps(setup_msg))
            response = await ws.recv()
            print(f"Response: {response}")
            if "setupComplete" in str(response):
                print("SUCCESS: v1beta works with gemini-2.0-flash-exp!")
    except Exception as e:
        print(f"FAILED: {e}")

if __name__ == "__main__":
    asyncio.run(test_v1beta())
