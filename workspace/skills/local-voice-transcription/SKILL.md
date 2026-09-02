---
name: local-voice-transcription
description: Bi-directional audio transcription using local Whisper and speech synthesis via Piper for Linux local agents.
---

# Local Voice Transcription & TTS Architecture

## Overview
A lightweight pipeline for local speech-to-text (Whisper C++ or Python bindings) and text-to-speech (Piper) running entirely on local Linux hardware without cloud audio dependencies.

## Components
1. **Audio Capture & VAD**: SoX or PyAudio recording with simple energy/VAD triggers.
2. **Transcription**: Local Whisper model (`whisper.cpp` or `openai-whisper` tiny/base) for low-latency text output.
3. **Agent Synthesis**: Cunning Claw processes text input and routes responses.
4. **TTS Playback**: Piper TTS streaming audio to ALSA/PulseAudio (`aplay`).
