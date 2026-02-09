import asyncio
import json
import os
import websockets
from dotenv import load_dotenv

async def test_model(model_name):
    load_dotenv(override=True)
    key = os.getenv("GOOGLE_API_KEY")
    url = f"wss://generativelanguage.googleapis.com/ws/google.ai.generativelanguage.v1alpha.GenerativeService.BidiGenerateContent?key={key}"
    
    print(f"Testing model: {model_name}")
    try:
        async with websockets.connect(url) as ws:
            setup_msg = {
                "setup": {
                    "model": model_name,
                    "generation_config": {
                        "response_modalities": ["AUDIO"]
                    }
                }
            }
            await ws.send(json.dumps(setup_msg))
            response = await ws.recv()
            print(f"Response for {model_name}: {response}")
            if "setupComplete" in response:
                return True
    except Exception as e:
        print(f"Error testing {model_name}: {e}")
    return False

async def main():
    models = ["models/gemini-2.0-flash", "models/gemini-2.5-flash-native-audio-latest", "models/gemini-2.0-flash-exp"]
    for model in models:
        success = await test_model(model)
        if success:
            print(f"SUCCESS: {model} is valid.")
            break
        else:
            print(f"FAILED: {model} is NOT valid.")

if __name__ == "__main__":
    asyncio.run(main())
