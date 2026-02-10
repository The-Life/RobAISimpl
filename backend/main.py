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

def trace(msg):
    with open("/tmp/robai_backend.log", "a") as f:
        f.write(f"{msg}\n")
    print(msg)

@app.websocket("/ws/google-proxy")
async def google_proxy(client_ws: WebSocket):
    trace("ENTER google_proxy")
    # Get mode from query params
    mode = client_ws.query_params.get("mode", "general")
    trace(f"Selected Mode: {mode}")
    
    await client_ws.accept()
    
    # 1. Load API Key
    key = os.getenv("GOOGLE_API_KEY")
    
    if not key or "your_api_key" in key:
        trace("ERROR: Missing or placeholder GOOGLE_API_KEY in .env")
        await client_ws.send_text(json.dumps({"error": "Missing GOOGLE_API_KEY"}))
        await client_ws.close(code=4003)
        return

    trace(f"Handshaking with Gemini (Key: {key[:4]}...)")
    gemini_url = f"wss://generativelanguage.googleapis.com/ws/google.ai.generativelanguage.v1beta.GenerativeService.BidiGenerateContent?key={key}"

    try:
        async with websockets.connect(gemini_url) as google_ws:
            trace("CONNECTED to Google")

            PROMPTS = {
                "exercise": """
                    You are RobAI, a specialized assembly assistant.
                    Your goal is to guide the user through the "Ring Stack" exercise.
                    Steps: 1. Large RED, 2. Medium BLUE, 3. Small YELLOW.
                    Be strict but encouraging. Stop them if they pick the wrong color.
                    Keep responses short and focused on the task.
                    IMPORTANT: Wait until you actually SEE the objects before giving instructions.
                """,
                "general": """
                    You are RobAI, a specialized vision-enabled assistant. 
                    STRICT GROUNDING RULE: You MUST ONLY describe what is physically visible in the camera frame. 
                    Do NOT guess background details or hallucinate objects (like trees or office equipment) if they are not clearly in view.
                    If you are not confident the object is in the frame, explicitly say you are unsure.
                    If the user asks about something you don't see, say: "I'm sorry, I'm not seeing that in my current visual feed."
                    Never invent objects to be helpful.
                    Be conversational but stay 100% anchored in the reality of the image stream.
                    If the image is blurry, dark, or stale, mention that specifically.
                """
            }

            setup_msg = {
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
                        "parts": [{"text": PROMPTS.get(mode, PROMPTS["general"])}]
                    }
                }
            }

            trace(f"Sending Setup (Model: {setup_msg['setup']['model']})...")
            await google_ws.send(json.dumps(setup_msg))
            
            init_response = await google_ws.recv()
            trace(f"RECEIVED Setup Response: {init_response[:100]}")
            
            # Check for immediate quota or setup errors in setup response
            try:
                setup_data = json.loads(init_response)
                if "error" in setup_data:
                    err_msg = setup_data["error"].get("message", "")
                    if "quota" in err_msg.lower():
                        trace("QUOTA EXCEEDED detected in Setup Response")
                        await client_ws.send_text(json.dumps({"error": "QUOTA_EXCEEDED"}))
                        return
            except: pass

            await client_ws.send_text(json.dumps({"setupComplete": True}))

            trace("Setup Complete. Waiting for media...")

            async def client_to_google():
                trace("START client_to_google")
                chunk_count = 0
                image_count = 0
                audio_count = 0
                try:
                    while True:
                        msg = await client_ws.receive()
                        chunk_count += 1
                        
                        # Logging for verification
                        if chunk_count % 50 == 0:
                            if "text" in msg:
                                try:
                                    data = json.loads(msg["text"])
                                    if "realtime_input" in data:
                                        media = data["realtime_input"].get("media_chunks", [{}])[0]
                                        mime = media.get("mime_type", "unknown")
                                        size = len(media.get("data", ""))
                                        trace(f"Media Stream: Received chunk {chunk_count} ({mime}, {size/1024:.1f} KB)")
                                except: pass
                        if "text" in msg:
                            try:
                                data = json.loads(msg["text"])
                                if "realtime_input" in data:
                                    for media in data["realtime_input"].get("media_chunks", []):
                                        mime = media.get("mime_type", "unknown")
                                        size = len(media.get("data", ""))
                                        if mime.startswith("image/"):
                                            image_count += 1
                                            if image_count % 25 == 0:
                                                trace(f"Image Stream: Received {image_count} images (last {size/1024:.1f} KB)")
                                        if mime.startswith("audio/"):
                                            audio_count += 1
                                            if audio_count % 50 == 0:
                                                trace(f"Audio Stream: Received {audio_count} audio chunks (last {size/1024:.1f} KB)")
                            except:
                                pass

                        if "text" in msg:
                            await google_ws.send(msg["text"])
                        elif "bytes" in msg:
                            await google_ws.send(msg["bytes"])
                        else:
                            trace("client_ws.receive() returned non-data")
                            break
                except Exception as e:
                    trace(f"ERROR client_to_google: {e}")

            async def google_to_client():
                trace("START google_to_client")
                try:
                    while True:
                        data = await google_ws.recv()
                        if isinstance(data, bytes):
                            await client_ws.send_bytes(data)
                        else:
                            try:
                                resp_json = json.loads(data)
                                if "serverContent" in resp_json:
                                    sc = resp_json["serverContent"]
                                    if "interrupted" in sc:
                                        trace("Gemini Interrupted Signal Received")
                                    if "modelTurn" in sc:
                                        parts = sc["modelTurn"].get("parts", [])
                                        for p in parts:
                                            if "text" in p:
                                                trace(f"Gemini Speech: {p['text']}")
                                    if "turnComplete" in sc:
                                        trace("Gemini Turn Complete")
                            except:
                                pass
                            await client_ws.send_text(data)
                except Exception as e:
                    trace(f"ERROR google_to_client: {e}")

            # Run both tasks
            await asyncio.gather(client_to_google(), google_to_client())
            trace("Gather FINISHED")

    except Exception as e:
        err_str = str(e)
        trace(f"CATCH block: {err_str}")
        import traceback
        trace(traceback.format_exc())
        
        # Specific quota error detection
        if "quota" in err_str.lower():
            try:
                await client_ws.send_text(json.dumps({"error": "QUOTA_EXCEEDED"}))
            except: pass
        else:
            try:
                await client_ws.send_text(json.dumps({"error": err_str}))
            except: pass
    finally:
        trace("EXIT google_proxy")
        try:
            await client_ws.close()
        except:
            pass
        print("Done.")

if __name__ == "__main__":
    import uvicorn
    # Use standard 8001 port
    uvicorn.run(app, host="0.0.0.0", port=8001)
