import os
import asyncio
import json
import websockets
from fastapi import FastAPI, WebSocket
from fastapi.middleware.cors import CORSMiddleware
from dotenv import load_dotenv

# Load environment variables
load_dotenv(override=True)

app = FastAPI()

app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)

@app.websocket("/ws/google-proxy")
async def google_proxy(client_ws: WebSocket):
    """
    Bi-directional proxy between Client (React) and Google Gemini Live API.
    """
    await client_ws.accept()
    
    # Refresh env
    load_dotenv(override=True)
    key = os.getenv("GOOGLE_API_KEY")
    
    if not key or key == "your_api_key_here":
        print(f"Error: GOOGLE_API_KEY placeholder or missing. Found: {key[:4] if key else 'None'}...")
        await client_ws.close(code=4003)
        return

    print(f"Client connected. Using API Key starting with: {key[:4]}...")
    gemini_url = f"wss://generativelanguage.googleapis.com/ws/google.ai.generativelanguage.v1alpha.GenerativeService.BidiGenerateContent?key={key}"

    try:
        # Connect to Google
        async with websockets.connect(gemini_url) as google_ws:
            print("Connected to Gemini Live API")

            # Setup initial config
            sys_prompt = """
            You are RobAI, an active AI robot repair assistant.
            You have eyes (video) and ears (audio).
            Your goal is to guide the user through assembling a "Ring Stack".
            
            THE ASSEMBLY STEPS:
            1. Place the large RED ring on the base.
            2. Place the medium BLUE ring on top of the red ring.
            3. Place the small YELLOW ring on top of the blue ring.
            
            INSTRUCTIONS:
            - Watch the video stream continuously.
            - If the user picks up the wrong ring, STOP THEM immediately: "No, that's the blue one. Find the RED one first."
            - If they succeed, confirm it warmly: "Perfect. Now grab the blue ring."
            - Be concise. Speak like a helpful workshop partner. Don't lecture.
            - If you see nothing, ask "Show me the parts."
            """

            await google_ws.send(json.dumps({
                "setup": {
                    "model": "models/gemini-2.5-flash-native-audio-latest", 
                    "generation_config": {
                        "response_modalities": ["AUDIO"],
                        "speech_config": {
                            "voice_config": {
                                "prebuilt_voice_config": {
                                    "voice_name": "Puck" 
                                }
                            }
                        }
                    },
                    "system_instruction": {
                        "parts": [
                            {"text": sys_prompt}
                        ]
                    }
                }
            }))
            
            # Wait for setup completion
            init_response = await google_ws.recv()
            print(f"Gemini Setup Response: {init_response}")
            
            # Forward setup response to client so they know we are ready
            if isinstance(init_response, bytes):
                await client_ws.send_bytes(init_response)
            else:
                await client_ws.send_text(init_response)

            # --- TRIGGER MESSAGE ---
            # Send an initial hidden prompt to Gemini to force it to start speaking
            # This helps if the model is waiting for a first turn.
            trigger_msg = {
                "client_content": {
                    "turns": [
                        {"role": "user", "parts": [{"text": "Hello RobAI, please start the session."}]}
                    ],
                    "turn_complete": True
                }
            }
            await google_ws.send(json.dumps(trigger_msg))
            # -----------------------

            async def client_to_google():
                try:
                    while True:
                        data = await client_ws.receive_text()
                        print(f"Client -> Google (size {len(data)})") # Log first 100 chars
                        await google_ws.send(data)
                except Exception as e:
                    print(f"Client->Google Error: {e}")

            async def google_to_client():
                try:
                    while True:
                        data = await google_ws.recv()
                        # Log response type and size
                        print(f"Google -> Client: {type(data)} {len(data) if data else 0} bytes/chars")
                        
                        if isinstance(data, bytes):
                            await client_ws.send_bytes(data)
                        else:
                            await client_ws.send_text(data)
                except Exception as e:
                    print(f"Google->Client Error: {e}")

            # Run both tasks purely concurrently
            await asyncio.gather(client_to_google(), google_to_client())

    except Exception as e:
        print(f"Proxy Connection Error: {e}")
    finally:
        try:
            await client_ws.close()
        except:
            pass
        print("Client disconnected")

if __name__ == "__main__":
    import uvicorn
    uvicorn.run(app, host="0.0.0.0", port=8001)
