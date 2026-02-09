import { useState, useRef, useEffect } from 'react'
import './App.css'

function App() {
    const [isConnected, setIsConnected] = useState(false);
    const [status, setStatus] = useState("Disconnected");
    const [showDebug, setShowDebug] = useState(false);
    const [debugLogs, setDebugLogs] = useState([]);
    const [isCameraActive, setIsCameraActive] = useState(false);
    const [isMicActive, setIsMicActive] = useState(false);
    const [isGeminiSpeaking, setIsGeminiSpeaking] = useState(false);

    const videoRef = useRef(null);
    const canvasRef = useRef(null);
    const wsRef = useRef(null);
    const audioContextRef = useRef(null);
    const workletNodeRef = useRef(null);
    const streamRef = useRef(null);

    const audioQueueRef = useRef([]);
    const audioInputBufferRef = useRef([]); // To group small chunks
    const isPlayingRef = useRef(false);
    const nextStartTimeRef = useRef(0);

    const addLog = (msg, type = 'info') => {
        const timestamp = new Date().toLocaleTimeString();
        setDebugLogs(prev => [...prev.slice(-49), { timestamp, msg, type }]);
        console.log(`[${type.toUpperCase()}] ${msg}`);
    };

    const connectToBackend = async () => {
        try {
            addLog("Starting connection to backend...");
            setStatus("Connecting...");

            // Ensure audio context is ready (user gesture)
            if (!audioContextRef.current) {
                addLog("Initializing AudioContext...");
                audioContextRef.current = new AudioContext({ sampleRate: 16000 });
            }
            if (audioContextRef.current.state === 'suspended') {
                addLog("Resuming AudioContext...");
                await audioContextRef.current.resume();
            }

            const wsUrl = "ws://localhost:8001/ws/google-proxy";
            addLog(`Connecting to WebSocket: ${wsUrl}`);
            wsRef.current = new WebSocket(wsUrl);

            wsRef.current.onopen = () => {
                addLog("WebSocket Connected!", 'success');
                setIsConnected(true);
                setStatus("Connected to Gemini");

                // Ensure binary data is handled as ArrayBuffer
                wsRef.current.binaryType = 'arraybuffer';

                startMedia();
            };

            wsRef.current.onmessage = (event) => {
                handleServerMessage(event.data);
            };

            wsRef.current.onclose = (event) => {
                addLog(`WebSocket Closed: ${event.code} ${event.reason}`, 'warn');
                if (event.code === 4003 || (isConnected === false && status === "Connecting...")) {
                    addLog("Connection rejected: Check your GOOGLE_API_KEY in the backend .env file.", 'error');
                    setStatus("Check API Key in .env");
                } else {
                    setStatus("Disconnected");
                }
                setIsConnected(false);
                setIsCameraActive(false);
                setIsMicActive(false);
                setIsGeminiSpeaking(false);
                stopMedia();
            };

            wsRef.current.onerror = (error) => {
                addLog("WebSocket Error detected", 'error');
                console.error("WebSocket Error:", error);
                setStatus("Connection Error");
            };

        } catch (e) {
            addLog(`Connection Failed: ${e.message}`, 'error');
            console.error(e);
            setStatus("Error: " + e.message);
        }
    };

    const startMedia = async () => {
        try {
            addLog("Requesting Camera & Microphone access...");
            const stream = await navigator.mediaDevices.getUserMedia({
                audio: {
                    channelCount: 1,
                    sampleRate: 16000,
                },
                video: {
                    width: 640,
                    height: 480,
                    frameRate: 5
                }
            });

            addLog("Media Stream acquired", 'success');
            streamRef.current = stream;
            if (videoRef.current) {
                videoRef.current.srcObject = stream;
            }

            // 1. Audio Capture (PCM)
            if (!audioContextRef.current) {
                addLog("AudioContext cleared before worklet could load, aborting media start", 'warn');
                return;
            }

            if (!audioContextRef.current.audioWorklet) {
                addLog("CRITICAL: Your browser does not support AudioWorklet or is not in a secure context.", 'error');
                setStatus("Audio Error: Unsecure Context?");
                return;
            }

            addLog("Loading Audio Processor Worklet...");
            await audioContextRef.current.audioWorklet.addModule("/audio-processor.js");

            if (!audioContextRef.current) return;

            const source = audioContextRef.current.createMediaStreamSource(stream);
            workletNodeRef.current = new AudioWorkletNode(audioContextRef.current, "audio-processor");

            addLog("Audio Pipeline active");
            workletNodeRef.current.port.onmessage = (event) => {
                const audioBuf = event.data;
                audioInputBufferRef.current.push(new Int16Array(audioBuf));

                let totalSamples = 0;
                audioInputBufferRef.current.forEach(chunk => totalSamples += chunk.length);

                if (totalSamples >= 4000) {
                    if (wsRef.current && wsRef.current.readyState === WebSocket.OPEN) {
                        const mergedPcm = new Int16Array(totalSamples);
                        let offset = 0;
                        audioInputBufferRef.current.forEach(chunk => {
                            mergedPcm.set(chunk, offset);
                            offset += chunk.length;
                        });
                        audioInputBufferRef.current = [];

                        const uint8 = new Uint8Array(mergedPcm.buffer);
                        let binary = '';
                        for (let i = 0; i < uint8.length; i++) {
                            binary += String.fromCharCode(uint8[i]);
                        }
                        const audioData = btoa(binary);

                        const msg = {
                            realtime_input: {
                                media_chunks: [
                                    {
                                        mime_type: "audio/pcm;rate=16000",
                                        data: audioData
                                    }
                                ]
                            }
                        };
                        wsRef.current.send(JSON.stringify(msg));

                        setIsMicActive(true);
                        setTimeout(() => setIsMicActive(false), 200);
                    } else {
                        audioInputBufferRef.current = [];
                    }
                }
            };

            source.connect(workletNodeRef.current);

            // 2. Video Capture
            addLog("Video Loop started @ 5 FPS");
            const captureFrame = () => {
                if (!videoRef.current || !canvasRef.current || !wsRef.current || wsRef.current.readyState !== WebSocket.OPEN) return;

                const ctx = canvasRef.current.getContext('2d');
                ctx.drawImage(videoRef.current, 0, 0, 640, 480);
                const base64Data = canvasRef.current.toDataURL("image/jpeg", 0.5).split(",")[1];

                const msg = {
                    realtime_input: {
                        media_chunks: [
                            {
                                mime_type: "image/jpeg",
                                data: base64Data
                            }
                        ]
                    }
                };
                wsRef.current.send(JSON.stringify(msg));

                // Signal Camera Activity
                setIsCameraActive(true);
                setTimeout(() => setIsCameraActive(false), 200);

                setTimeout(captureFrame, 200); // 5 FPS
            };

            captureFrame();

        } catch (e) {
            addLog(`Media Access Error: ${e.message}`, 'error');
            console.error("Media Error:", e);
            setStatus("Media Error");
        }
    };

    const stopMedia = () => {
        addLog("Stopping media streams and WebSocket...");
        if (streamRef.current) {
            streamRef.current.getTracks().forEach(track => track.stop());
            streamRef.current = null;
        }
        // DO NOT close the audio context here - we need it for playback!
        // Only close it when component unmounts or on explicit disconnect
        if (wsRef.current) {
            wsRef.current.close();
            wsRef.current = null;
        }
        setIsConnected(false);
        setStatus("Disconnected");
        setIsCameraActive(false);
        setIsMicActive(false);
        setIsGeminiSpeaking(false);
        audioInputBufferRef.current = [];
    };

    const playNextChunk = () => {
        addLog(`>>> playNextChunk() called, queue length: ${audioQueueRef.current.length}`);
        if (audioQueueRef.current.length === 0) {
            addLog("Audio queue empty, stopping playback");
            isPlayingRef.current = false;
            stopAudioVisuals();
            return;
        }

        isPlayingRef.current = true;
        const audioContext = audioContextRef.current;
        if (!audioContext) {
            addLog("ERROR: No audio context available!", 'error');
            isPlayingRef.current = false;
            return;
        }

        if (audioContext.state === 'closed') {
            addLog("ERROR: AudioContext is closed!", 'error');
            isPlayingRef.current = false;
            return;
        }

        if (audioContext.state === 'suspended') {
            addLog("Resuming suspended AudioContext...", 'warn');
            audioContext.resume().then(() => {
                addLog("AudioContext resumed");
                playNextChunk(); // Retry
            }).catch(err => {
                addLog(`ERROR resuming AudioContext: ${err.message}`, 'error');
                isPlayingRef.current = false;
            });
            return;
        }

        const chunkData = audioQueueRef.current.shift();
        addLog(`Playing audio chunk: ${chunkData.length} samples, context state: ${audioContext.state}`);

        try {
            // Use the actual sample rate of the AudioContext
            const buffer = audioContext.createBuffer(1, chunkData.length, audioContext.sampleRate);
            const channelData = buffer.getChannelData(0);

            for (let i = 0; i < chunkData.length; i++) {
                const int16 = chunkData[i];
                channelData[i] = int16 >= 0x8000 ? -(0x10000 - int16) / 0x8000 : int16 / 0x7FFF;
            }

            const source = audioContext.createBufferSource();
            source.buffer = buffer;
            source.connect(audioContext.destination);

            const currentTime = audioContext.currentTime;
            const startTime = Math.max(currentTime, nextStartTimeRef.current);
            source.start(startTime);
            nextStartTimeRef.current = startTime + buffer.duration;

            addLog(`Audio scheduled at ${startTime.toFixed(3)}s, duration ${buffer.duration.toFixed(3)}s`);

            if (audioQueueRef.current.length > 0) {
                playNextChunk();
            }
        } catch (err) {
            addLog(`ERROR playing audio: ${err.message}`, 'error');
            console.error("Audio playback error:", err);
        }
    };

    const decodeAndEnqueueAudio = (base64Audio) => {
        addLog("Received Audio Chunk from Gemini");
        try {
            const binaryString = atob(base64Audio);
            const bytes = new Uint8Array(binaryString.length);
            for (let i = 0; i < binaryString.length; i++) {
                bytes[i] = binaryString.charCodeAt(i);
            }
            const int16Data = new Int16Array(bytes.buffer);
            addLog(`Decoded ${int16Data.length} audio samples, queue size: ${audioQueueRef.current.length}`);
            audioQueueRef.current.push(int16Data);

            if (!isPlayingRef.current) {
                addLog("Starting audio playback...");
                setIsGeminiSpeaking(true);
                playNextChunk();
            } else {
                addLog(`Already playing, ${audioQueueRef.current.length} chunks in queue`);
            }
        } catch (err) {
            addLog(`ERROR decoding audio: ${err.message}`, 'error');
            console.error("Audio decode error:", err);
        }
    };

    const stopAudioVisuals = () => {
        setIsGeminiSpeaking(false);
    };

    const handleServerMessage = async (data) => {
        try {
            let messageStr = data;
            if (data instanceof ArrayBuffer) {
                messageStr = new TextDecoder().decode(data);
            }
            const response = JSON.parse(messageStr);
            if (response.setupComplete) {
                addLog("Gemini Setup Response: COMPLETED", 'success');
                setStatus("Listening...");
            }
            if (response.serverContent?.modelTurn?.parts) {
                const parts = response.serverContent.modelTurn.parts;
                for (const part of parts) {
                    if (part.inlineData?.mimeType?.startsWith("audio/pcm")) {
                        decodeAndEnqueueAudio(part.inlineData.data);
                    }
                    if (part.text) {
                        addLog(`Gemini Text: "${part.text}"`);
                    }
                }
            }
            if (response.serverContent?.turnComplete) {
                addLog("Turn Complete. Gemini finished speaking.");
                setStatus("Listening...");
            }
        } catch (e) {
            addLog("Failed to parse server message", 'error');
            console.error("Msg Parse Error", e);
        }
    };

    return (
        <div className="container">
            <h1>New RobAI Vision</h1>
            <div className="status-bar">
                <span>Status: {status}</span>
                <div className={`indicator camera ${isCameraActive ? 'active' : ''}`}>
                    <div className="dot"></div> Video Out
                </div>
                <div className={`indicator mic ${isMicActive ? 'active' : ''}`}>
                    <div className="dot"></div> Mic Out
                </div>
                <div className={`indicator gemini ${isGeminiSpeaking ? 'active' : ''}`}>
                    <div className="dot"></div> Gemini Audio
                </div>
            </div>

            <div className="video-container">
                <video ref={videoRef} autoPlay playsInline muted className="live-video" />
                <canvas ref={canvasRef} width="640" height="480" style={{ display: 'none' }} />
            </div>

            <div className="controls">
                {!isConnected ? (
                    <button onClick={connectToBackend}>Connect to Gemini</button>
                ) : (
                    <button onClick={stopMedia} className="stop-btn">Disconnect</button>
                )}
            </div>

            {/* Debug Mode Toggle */}
            <button className="debug-toggle" onClick={() => setShowDebug(!showDebug)}>
                🔧
            </button>

            {showDebug && (
                <div className="debug-panel">
                    <h3>Debug Log</h3>
                    <div className="debug-scroll">
                        {debugLogs.map((log, i) => (
                            <div key={i} className={`debug-item ${log.type}`}>
                                <span className="time">[{log.timestamp}]</span> {log.msg}
                            </div>
                        ))}
                        {debugLogs.length === 0 && <p>No logs yet...</p>}
                    </div>
                    <button className="close-debug" onClick={() => setShowDebug(false)}>Close</button>
                </div>
            )}
        </div>
    )
}

export default App
