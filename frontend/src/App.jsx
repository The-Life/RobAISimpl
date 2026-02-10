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

    const [isMicOn, setIsMicOn] = useState(true);
    const [isVideoOn, setIsVideoOn] = useState(true);
    const [isGeminiReady, setIsGeminiReady] = useState(false);
    const [hasMedia, setHasMedia] = useState(false);
    const [interactionMode, setInteractionMode] = useState("general"); // exercise | general
    const [lowResMode, setLowResMode] = useState(false);
    const [allowBargeIn, setAllowBargeIn] = useState(false);

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

    const frameCountRef = useRef(0); // For video debug logs
    const imageCountRef = useRef(0);
    const silenceCounterRef = useRef(0); // For silence warning

    const lastUserSpeechTimeRef = useRef(Date.now());
    const lastGeminiSpeechTimeRef = useRef(Date.now());
    const autoPokeTimerRef = useRef(null);

    const isAiSpeakingRef = useRef(false);
    const isGeminiReadyRef = useRef(false);
    const isMicOnRef = useRef(true);
    const isVideoOnRef = useRef(true);
    const lowResModeRef = useRef(false);
    const allowBargeInRef = useRef(false);
    const isUserSpeakingRef = useRef(false);
    const lastVoiceTimeRef = useRef(0);
    const suspendAudioUntilRef = useRef(0);
    const suspendVideoUntilRef = useRef(0);
    const testFrameInFlightRef = useRef(false);

    const VIDEO_CONFIG = {
        low: { width: 320, height: 240, fps: 2, jpegQuality: 0.7 },
        normal: { width: 640, height: 480, fps: 5, jpegQuality: 0.8 },
    };

    const VAD = {
        startThreshold: 500,
        stopThreshold: 300,
        silenceMs: 700,
    };

    // Toggle Functions
    const toggleMic = () => {
        if (streamRef.current) {
            const audioTracks = streamRef.current.getAudioTracks();
            if (audioTracks.length > 0) {
                const newState = !isMicOn;
                audioTracks[0].enabled = newState;
                setIsMicOn(newState);
                isMicOnRef.current = newState;
                addLog(`Microphone ${newState ? "Unmuted" : "Muted"}`);
            }
        }
    };

    const toggleVideo = () => {
        if (streamRef.current) {
            const videoTracks = streamRef.current.getVideoTracks();
            if (videoTracks.length > 0) {
                const newState = !isVideoOn;
                videoTracks[0].enabled = newState;
                setIsVideoOn(newState);
                isVideoOnRef.current = newState;
                addLog(`Video ${newState ? "Started" : "Stopped"}`);
            }
        }
    };

    const toggleLowRes = () => {
        const newState = !lowResMode;
        setLowResMode(newState);
        lowResModeRef.current = newState;
        const cfg = newState ? VIDEO_CONFIG.low : VIDEO_CONFIG.normal;
        addLog(`Low-res mode ${newState ? "enabled" : "disabled"} (${cfg.width}x${cfg.height} @ ${cfg.fps} FPS)`);
    };

    const toggleBargeIn = () => {
        const newState = !allowBargeIn;
        setAllowBargeIn(newState);
        allowBargeInRef.current = newState;
        addLog(`Barge-in ${newState ? "enabled" : "disabled"}`);
    };

    const addLog = (msg, type = 'info') => {
        const timestamp = new Date().toLocaleTimeString();
        setDebugLogs(prev => [...prev.slice(-49), { timestamp, msg, type }]);
        console.log(`[${type.toUpperCase()}] ${msg}`);
    };

    const connectToBackend = async () => {
        try {
            addLog("Starting connection to backend...");
            setIsGeminiReady(false);
            isGeminiReadyRef.current = false;
            nextStartTimeRef.current = 0;
            setStatus("Connecting...");

            // Ensure audio context is ready (user gesture)
            if (!audioContextRef.current) {
                addLog("Initializing AudioContext at 24kHz for natural speed...");
                // NOTE: Gemini 2.0/2.5 outputs at 24kHz. Setting this context to 24kHz 
                // matches the model's output rate, fixing the "slow/robotic" voice.
                audioContextRef.current = new AudioContext({ sampleRate: 24000 });
            }
            if (audioContextRef.current.state === 'suspended') {
                addLog("Resuming AudioContext...");
                await audioContextRef.current.resume();
            }

            const wsUrl = `ws://localhost:8001/ws/google-proxy?mode=${interactionMode}`;
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
                setIsGeminiReady(false);
                isGeminiReadyRef.current = false;
                nextStartTimeRef.current = 0;
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

    // Auto-poke Logic: Runs every 2 seconds to check for sustained silence
    useEffect(() => {
        if (isConnected && isGeminiReady) {
            autoPokeTimerRef.current = setInterval(() => {
                const now = Date.now();
                const silenceDuration = now - Math.max(lastUserSpeechTimeRef.current, lastGeminiSpeechTimeRef.current);

                // If silence > 8s and AI is not currently speaking/queued
                if (
                    silenceDuration > 8000 &&
                    !isPlayingRef.current &&
                    audioQueueRef.current.length === 0 &&
                    !isUserSpeakingRef.current &&
                    !testFrameInFlightRef.current
                ) {
                    addLog("Sustained silence detected. Sending auto-poke trigger...", 'info');
                    if (wsRef.current && wsRef.current.readyState === WebSocket.OPEN) {
                        const msg = {
                            client_content: {
                                turns: [{ role: "user", parts: [{ text: "Please continue observing and tell me what you see." }] }],
                                turn_complete: true
                            }
                        };
                        wsRef.current.send(JSON.stringify(msg));
                        lastGeminiSpeechTimeRef.current = now; // Reset to avoid rapid firing
                    }
                }
            }, 2000);
        }
        return () => {
            if (autoPokeTimerRef.current) clearInterval(autoPokeTimerRef.current);
        };
    }, [isConnected, isGeminiReady]);

    const startMedia = async () => {
        try {
            const cfg = lowResModeRef.current ? VIDEO_CONFIG.low : VIDEO_CONFIG.normal;
            addLog("Requesting Camera & Microphone access...");
            const stream = await navigator.mediaDevices.getUserMedia({
                audio: {
                    channelCount: 1,
                    sampleRate: 16000,
                },
                video: {
                    width: cfg.width,
                    height: cfg.height,
                    frameRate: cfg.fps
                }
            });

            addLog("Media Stream acquired", 'success');
            streamRef.current = stream;
            setHasMedia(true);
            // Apply initial state
            stream.getAudioTracks()[0].enabled = isMicOn;
            stream.getVideoTracks()[0].enabled = isVideoOn;

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

            // MIC BOOST: Add a GainNode to increase volume
            const gainNode = audioContextRef.current.createGain();
            gainNode.gain.value = 2.0; // 2x boost
            source.connect(gainNode);

            workletNodeRef.current = new AudioWorkletNode(audioContextRef.current, "audio-processor");
            gainNode.connect(workletNodeRef.current);

            addLog("Audio Pipeline active");
            workletNodeRef.current.port.onmessage = (event) => {
                // 1. Check if Gemini is handshaked and ready
                if (!isGeminiReadyRef.current) return;

                // 2. Check if Mic is UNMUTED
                if (!isMicOnRef.current) {
                    audioInputBufferRef.current = []; // Clear buffer while muted
                    return;
                }

                const now = Date.now();
                if (now < suspendAudioUntilRef.current) {
                    audioInputBufferRef.current = [];
                    return;
                }

                // 3. MIC GATING (ECHO CANCELLATION)
                if (isAiSpeakingRef.current && !allowBargeInRef.current) {
                    audioInputBufferRef.current = [];
                    return;
                }

                const audioBuf = event.data;
                audioInputBufferRef.current.push(new Int16Array(audioBuf));

                let totalSamples = 0;
                audioInputBufferRef.current.forEach(chunk => totalSamples += chunk.length);

                if (totalSamples >= 4000) {
                    // VAD: detect speech and only send when speaking
                    let maxAmplitude = 0;
                    audioInputBufferRef.current.forEach(chunk => {
                        for (let i = 0; i < chunk.length; i++) {
                            const abs = Math.abs(chunk[i]);
                            if (abs > maxAmplitude) maxAmplitude = abs;
                        }
                    });

                    if (maxAmplitude > VAD.startThreshold) {
                        isUserSpeakingRef.current = true;
                        lastVoiceTimeRef.current = now;
                        lastUserSpeechTimeRef.current = now;
                    } else if (isUserSpeakingRef.current && maxAmplitude > VAD.stopThreshold) {
                        lastVoiceTimeRef.current = now;
                        lastUserSpeechTimeRef.current = now;
                    }

                    if (isUserSpeakingRef.current && (now - lastVoiceTimeRef.current) > VAD.silenceMs) {
                        isUserSpeakingRef.current = false;
                        addLog("VAD: speech ended (silence detected)", "info");
                        audioInputBufferRef.current = [];
                        return;
                    }

                    if (wsRef.current && wsRef.current.readyState === WebSocket.OPEN && isUserSpeakingRef.current) {
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

                        // BARGE-IN: If volume is high enough, consider it user speaking
                        if (maxAmplitude > 800) {
                            lastUserSpeechTimeRef.current = Date.now();

                            // If AI is playing, clear the local queue immediately (Client-side Barge-in)
                            if (allowBargeInRef.current && (isPlayingRef.current || audioQueueRef.current.length > 0)) {
                                addLog("Barge-in: Interrupting AI playback...", 'info');
                                audioQueueRef.current = [];
                                isPlayingRef.current = false;
                                nextStartTimeRef.current = 0;
                            }
                        }

                        // Log with volume to verify mic is working
                        if (maxAmplitude < 100) {
                            silenceCounterRef.current += 1;
                            if (silenceCounterRef.current > 10 && isGeminiReadyRef.current) {
                                addLog("Silence detected: Mic is sending very low volume (Vol < 100)", "warn");
                                silenceCounterRef.current = 0;
                            }
                        } else {
                            silenceCounterRef.current = 0;
                        }

                        if (Math.random() < 0.1 && isUserSpeakingRef.current) {
                            addLog(`Sending audio chunk (Vol: ${maxAmplitude})`);
                        }
                        setTimeout(() => setIsMicActive(false), 200);
                    } else {
                        audioInputBufferRef.current = [];
                    }
                }
            };

            source.connect(workletNodeRef.current);

            // 2. Video Capture
            addLog(`Video Loop started @ ${cfg.fps} FPS (Waiting for Gemini Ready...)`);
            const captureFrame = () => {
                if (!videoRef.current || !canvasRef.current || !wsRef.current || wsRef.current.readyState !== WebSocket.OPEN) return;

                // 1. Wait for Gemini handshake
                if (!isGeminiReadyRef.current) {
                    if (frameCountRef.current % 30 === 0) {
                        addLog("Video paused: waiting for Gemini setup...", "warn");
                    }
                    setTimeout(captureFrame, 200);
                    return;
                }

                const now = Date.now();
                if (now < suspendVideoUntilRef.current) {
                    setIsCameraActive(false);
                    setTimeout(captureFrame, 200);
                    return;
                }

                // 2. Check if video is enabled
                if (!isVideoOnRef.current) {
                    setIsCameraActive(false);
                    setTimeout(captureFrame, 200);
                    return;
                }

                // Quality Enhancement: Ensure clean context state before capture
                if (videoRef.current.readyState < 2) {
                    setTimeout(captureFrame, 100);
                    return;
                }

                setIsCameraActive(true);
                const ctx = canvasRef.current.getContext('2d', { alpha: false });
                const activeCfg = lowResModeRef.current ? VIDEO_CONFIG.low : VIDEO_CONFIG.normal;
                if (canvasRef.current.width !== activeCfg.width) canvasRef.current.width = activeCfg.width;
                if (canvasRef.current.height !== activeCfg.height) canvasRef.current.height = activeCfg.height;
                ctx.drawImage(videoRef.current, 0, 0, activeCfg.width, activeCfg.height);

                // Quality Enhancement: Bump to 0.8 and verify data
                const base64 = canvasRef.current.toDataURL("image/jpeg", activeCfg.jpegQuality).split(',')[1];

                if (wsRef.current && wsRef.current.readyState === WebSocket.OPEN) {
                    const msg = {
                        realtime_input: {
                            media_chunks: [
                                {
                                    mime_type: "image/jpeg",
                                    data: base64
                                }
                            ]
                        }
                    };
                    wsRef.current.send(JSON.stringify(msg));

                    // Debug Log for Video Stream
                    frameCountRef.current += 1;
                    if (frameCountRef.current % 25 === 0) {
                        addLog(`Video Feed: Sent frame ${frameCountRef.current} (Size: ${(base64.length / 1024).toFixed(1)} KB, Start: ${base64.substring(0, 10)}...)`);
                    }
                    if (base64.length < 2000 && frameCountRef.current % 10 === 0) {
                        addLog("Warning: very small image payload; camera may be blank or blocked", "warn");
                    }
                }

                // Signal Camera Activity
                setIsCameraActive(true);
                setTimeout(() => setIsCameraActive(false), 200);

                // Reliability: Dynamic delay based on connection state
                const delay = Math.max(1000 / (lowResModeRef.current ? VIDEO_CONFIG.low.fps : VIDEO_CONFIG.normal.fps), 200);
                setTimeout(captureFrame, delay);
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
        isUserSpeakingRef.current = false;
        testFrameInFlightRef.current = false;
    };

    const playNextChunk = () => {
        if (audioQueueRef.current.length === 0) {
            addLog("Audio queue empty -> Stopping player loop");
            isPlayingRef.current = false;

            // MIC GATING: Set AI speaking to false with a small cooldown 
            // to allow for browser audio buffer to fully clear (echo protection)
            setTimeout(() => {
                if (!isPlayingRef.current) {
                    isAiSpeakingRef.current = false;
                }
            }, 300);

            // Stop visuals after a short delay (smoothness), but only if still idle
            setTimeout(() => {
                if (audioQueueRef.current.length === 0 && !isPlayingRef.current) {
                    stopAudioVisuals();
                }
            }, 100);
            return;
        }

        isPlayingRef.current = true;
        const audioContext = audioContextRef.current;
        if (!audioContext || audioContext.state === 'closed') {
            addLog("AudioContext unusable", 'error');
            isPlayingRef.current = false;
            return;
        }

        if (audioContext.state === 'suspended') {
            audioContext.resume().then(playNextChunk).catch(e => {
                addLog("Resume failed", 'error');
                isPlayingRef.current = false;
            });
            return;
        }

        const chunkData = audioQueueRef.current.shift();

        try {
            isAiSpeakingRef.current = true; // MIC GATING: Lock mic input
            const buffer = audioContext.createBuffer(1, chunkData.length, audioContext.sampleRate);
            const channelData = buffer.getChannelData(0);
            for (let i = 0; i < chunkData.length; i++) {
                // Standard Int16 to Float32 conversion
                const val = chunkData[i];
                channelData[i] = val < 0 ? val / 32768 : val / 32767;
            }

            const source = audioContext.createBufferSource();
            source.buffer = buffer;
            source.connect(audioContext.destination);

            const currentTime = audioContext.currentTime;
            const startTime = Math.max(currentTime, nextStartTimeRef.current);
            source.start(startTime);
            nextStartTimeRef.current = startTime + buffer.duration;
            lastGeminiSpeechTimeRef.current = Date.now();

            // Schedule the next check after this chunk finishes playing
            // This is better than immediate recursion because it keeps isAiSpeakingRef.current = true
            // for the duration of the actual play time.
            const delay = (startTime - currentTime + buffer.duration) * 1000;
            setTimeout(playNextChunk, delay - 20); // 20ms buffer to keep it smooth

        } catch (err) {
            addLog(`Audio Play Error: ${err.message}`, 'error');
            isPlayingRef.current = false;
            isAiSpeakingRef.current = false;
        }
    };

    const decodeAndEnqueueAudio = (base64Audio) => {
        try {
            const binaryString = atob(base64Audio);
            const bytes = new Uint8Array(binaryString.length);
            for (let i = 0; i < binaryString.length; i++) {
                bytes[i] = binaryString.charCodeAt(i);
            }
            const int16Data = new Int16Array(bytes.buffer);
            audioQueueRef.current.push(int16Data);

            if (!isPlayingRef.current) {
                addLog(`Restarting Player Loop (Q: ${audioQueueRef.current.length})`);
                setIsGeminiSpeaking(true);
                playNextChunk();
            }
        } catch (err) {
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
            if (response.error) {
                if (response.error === "QUOTA_EXCEEDED") {
                    addLog("CRITICAL: Gemini API Quota Exceeded. Please check your billing/plan.", 'error');
                    setStatus("Quota Exceeded (Check Studio)");
                } else {
                    addLog(`Server Error: ${response.error}`, 'error');
                    setStatus("Connection Error");
                }
            }
            if (response.setupComplete) {
                addLog("Gemini Setup Response: COMPLETED", 'success');
                setIsGeminiReady(true);
                isGeminiReadyRef.current = true;
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
                        lastGeminiSpeechTimeRef.current = Date.now();
                    }
                }
            }
            if (response.serverContent?.interrupted) {
                addLog("Gemini Interrupted by server signal.", 'info');
                audioQueueRef.current = [];
                isPlayingRef.current = false;
                nextStartTimeRef.current = 0;
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

    const sendTestFrame = () => {
        try {
            if (!videoRef.current || !canvasRef.current || !wsRef.current || wsRef.current.readyState !== WebSocket.OPEN) {
                addLog("Cannot send test frame: not connected or video not ready", "warn");
                return;
            }
            if (!isGeminiReadyRef.current) {
                addLog("Cannot send test frame: Gemini not ready yet", "warn");
                return;
            }
            testFrameInFlightRef.current = true;
            suspendAudioUntilRef.current = Date.now() + 2000;
            suspendVideoUntilRef.current = Date.now() + 1200;
            const cfg = lowResModeRef.current ? VIDEO_CONFIG.low : VIDEO_CONFIG.normal;
            const ctx = canvasRef.current.getContext('2d', { alpha: false });
            if (canvasRef.current.width !== cfg.width) canvasRef.current.width = cfg.width;
            if (canvasRef.current.height !== cfg.height) canvasRef.current.height = cfg.height;
            ctx.drawImage(videoRef.current, 0, 0, cfg.width, cfg.height);
            const base64 = canvasRef.current.toDataURL("image/jpeg", cfg.jpegQuality).split(',')[1];
            const testMsg = {
                client_content: {
                    turns: [{
                        role: "user",
                        parts: [
                            {
                                inlineData: {
                                    mimeType: "image/jpeg",
                                    data: base64
                                }
                            },
                            {
                                text: "Describe exactly what you see in the image. If you are unsure, say you are unsure."
                            }
                        ]
                    }],
                    turn_complete: true
                }
            };
            wsRef.current.send(JSON.stringify(testMsg));
            imageCountRef.current += 1;
            addLog(`Test frame sent as turn (#${imageCountRef.current}, ${(base64.length / 1024).toFixed(1)} KB)`, "info");
            setTimeout(() => {
                testFrameInFlightRef.current = false;
            }, 2000);
        } catch (err) {
            addLog(`Test frame error: ${err.message}`, "error");
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
                    <>
                        <div className="mode-selector">
                            <label>Interaction Mode: </label>
                            <select
                                value={interactionMode}
                                onChange={(e) => setInteractionMode(e.target.value)}
                                className="mode-dropdown"
                            >
                                <option value="general">🌍 General Discovery</option>
                                <option value="exercise">🏗️ Ring Stack Exercise</option>
                            </select>
                        </div>
                        <button onClick={connectToBackend} className="connect-btn">Connect to Gemini</button>
                    </>
                ) : (
                    <button onClick={stopMedia} className="stop-btn">Disconnect</button>
                )}
            </div>

            {/* Debug Mode Toggle */}
            <div className="controls-secondary">
                <button
                    onClick={toggleMic}
                    className={!isMicOn ? "warn-btn" : ""}
                    disabled={!hasMedia}
                >
                    {isMicOn ? "🎤 Mute Mic" : "🚫 Unmute"}
                </button>
                <button
                    onClick={toggleVideo}
                    className={!isVideoOn ? "warn-btn" : ""}
                    disabled={!hasMedia}
                >
                    {isVideoOn ? "📷 Stop Video" : "🚫 Start Video"}
                </button>
                <button
                    onClick={toggleLowRes}
                    className={lowResMode ? "warn-btn" : ""}
                    disabled={!hasMedia}
                >
                    {lowResMode ? "📉 Low-Res On" : "📈 Low-Res Off"}
                </button>
                <button
                    onClick={toggleBargeIn}
                    className={allowBargeIn ? "warn-btn" : ""}
                    disabled={!hasMedia}
                >
                    {allowBargeIn ? "🛑 Barge-in On" : "✅ Barge-in Off"}
                </button>
                <button onClick={sendTestFrame} disabled={!isConnected}>
                    🧪 Send Test Frame
                </button>
                <button className="debug-toggle" onClick={() => setShowDebug(!showDebug)}>
                    🔧 Debug
                </button>
            </div>

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
