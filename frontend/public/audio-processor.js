class AudioProcessor extends AudioWorkletProcessor {
    process(inputs, outputs, parameters) {
        const input = inputs[0];
        if (input && input.length > 0) {
            const channelData = input[0];
            // Convert Float32Array to Int16Array (PCM)
            const pcmData = new Int16Array(channelData.length);
            for (let i = 0; i < channelData.length; i++) {
                // Clamp value to [-1, 1]
                const s = Math.max(-1, Math.min(1, channelData[i]));
                // Convert to 16-bit PCM
                pcmData[i] = s < 0 ? s * 0x8000 : s * 0x7FFF;
            }
            this.port.postMessage(pcmData.buffer, [pcmData.buffer]);
        }
        return true;
    }
}

registerProcessor("audio-processor", AudioProcessor);
