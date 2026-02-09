import asyncio
import json
import os
import websockets
import base64
from dotenv import load_dotenv

async def test_audio_trigger():
    load_dotenv(override=True)
    key = os.getenv("GOOGLE_API_KEY")
    url = f"wss://generativelanguage.googleapis.com/ws/google.ai.generativelanguage.v1alpha.GenerativeService.BidiGenerateContent?key={key}"
    
    print(f"Connecting to {url[:60]}...")
    try:
        async with websockets.connect(url) as ws:
            # 1. Setup
            setup_msg = {
                "setup": {
                    "model": "models/gemini-2.5-flash-native-audio-latest",
                    "generation_config": {"response_modalities": ["AUDIO"]},
                    "system_instruction": {"parts": [{"text": "You are a helpful assistant. Please say hello immediately if you hear anything."}]}
                }
            }
            await ws.send(json.dumps(setup_msg))
            response = await ws.recv()
            print(f"Setup response: {response}")
            
            # 2. Send some dummy audio (silence or white noise)
            # 1 second of silence at 16kHz (16000 samples * 2 bytes = 32000 bytes)
            silence = base64.b64encode(b'\x00' * 3200).decode('utf-8')
            audio_msg = {
                "realtime_input": {
                    "media_chunks": [
                        {"mime_type": "audio/pcm;rate=16000", "data": silence}
                    ]
                }
            }
            
            print("Sending audio chunks...")
            for _ in range(10): # Send a few chunks
                await ws.send(json.dumps(audio_msg))
                await asyncio.sleep(0.1)
                
            # 3. Wait for response
            print("Waiting for Gemini response...")
            try:
                while True:
                    resp = await asyncio.wait_for(ws.recv(), timeout=5.0)
                    print(f"Got Response: {str(resp)[:200]}...")
                    if "serverContent" in str(resp):
                        print("SUCCESS: Gemini responded to audio!")
                        break
            except asyncio.TimeoutError:
                print("Gemini remained silent.")
                
    except Exception as e:
        print(f"Error: {e}")

if __name__ == "__main__":
    asyncio.run(test_audio_trigger())
