import asyncio
import json
import os
import websockets
from dotenv import load_dotenv

async def test_all_versions(model_name):
    load_dotenv(override=True)
    key = os.getenv("GOOGLE_API_KEY")
    versions = ["v1", "v1alpha", "v1beta"]
    
    for version in versions:
        url = f"wss://generativelanguage.googleapis.com/ws/google.ai.generativelanguage.{version}.GenerativeService.BidiGenerateContent?key={key}"
        print(f"Testing {model_name} on {version}...")
        try:
            async with websockets.connect(url) as ws:
                setup_msg = {
                    "setup": {
                        "model": model_name,
                        "generation_config": {"response_modalities": ["AUDIO"]}
                    }
                }
                await ws.send(json.dumps(setup_msg))
                # Add a timeout to recv
                try:
                    response = await asyncio.wait_for(ws.recv(), timeout=5.0)
                    print(f"  {version} Response: {response}")
                    if "setupComplete" in str(response):
                        print(f"  SUCCESS: {model_name} works on {version}!")
                        return
                except asyncio.TimeoutError:
                    print(f"  {version} Timeout")
        except Exception as e:
            print(f"  {version} Error: {e}")

async def main():
    models = ["models/gemini-2.0-flash-exp", "models/gemini-2.0-flash-live-preview-04-09", "models/gemini-2.5-flash-native-audio-latest"]
    for model in models:
        await test_all_versions(model)

if __name__ == "__main__":
    asyncio.run(main())
