# Local Voice Skill — Architecture Blueprint

Bi-directional voice for a local agent on Linux: Whisper for speech-in, Piper for
speech-out, no network hop, no per-call model load.

---

## 1. The shape of the problem

Three constraints drive every decision below.

**Model load dominates.** A Whisper small/medium model takes 2–8s to load and
several hundred MB to a few GB of RAM. A per-invocation process is unusable. The
skill must be a **long-lived daemon** with models resident, and the agent talks to
it over a Unix socket. Everything else follows from this.

**The microphone hears the speaker.** The moment Piper plays audio, the mic picks
it up and Whisper transcribes the agent talking to itself. This is the single most
common failure in home-built voice loops. Two ways out, and you must pick one
deliberately:

- *Mic gating* (half-duplex): mute capture while speaking. Trivial, reliable, and
  it makes barge-in impossible — the user cannot interrupt.
- *Acoustic echo cancellation*: PipeWire's `module-echo-cancel` (WebRTC AEC) with
  the Piper sink as the reference stream. Enables barge-in, costs a real tuning
  session, degrades badly on cheap laptop mics.

Start with gating. Design the state machine so AEC can be dropped in later without
restructuring — that's what the `EchoStrategy` seam below is for.

**Cancellation is a first-class path, not error handling.** The user interrupts,
changes their mind, or the agent produces a wrong answer mid-sentence. Every stage
needs to abort cleanly and leave no orphaned ALSA handle or half-drained queue.

---

## 2. Layer map

```
┌─────────────────────────────────────────────────────────────┐
│  agent  ──────────► VoiceSkill (public API)                  │
└─────────────────────────────────────────────────────────────┘
                              │  Unix socket / in-proc
┌─────────────────────────────▼───────────────────────────────┐
│  TurnManager        state machine, cancellation, barge-in    │
├──────────────────────────────┬──────────────────────────────┤
│  CapturePipeline             │  PlaybackPipeline            │
│  ┌────────────────────────┐  │  ┌────────────────────────┐  │
│  │ AudioSource            │  │  │ Synthesizer (Piper)    │  │
│  │ VAD / segmenter        │  │  │ sentence chunker       │  │
│  │ Transcriber (Whisper)  │  │  │ AudioSink              │  │
│  │ TextPostProcessor      │  │  └────────────────────────┘  │
│  └────────────────────────┘  │                              │
├──────────────────────────────┴──────────────────────────────┤
│  AudioDevice layer — PipeWire/Pulse/ALSA, EchoStrategy       │
└─────────────────────────────────────────────────────────────┘
```

Each box is an interface with at least two implementations: the real one and a
fake for tests. No layer imports from a layer above it.

---

## 3. Repository layout

```
voice/
├── __init__.py              # exports VoiceSkill only
├── skill.py                 # public API — the agent's entry point
├── daemon.py                # socket server, lifecycle, warm-up
├── config.py                # dataclass config, TOML/env loading
├── turn.py                  # TurnManager state machine
├── audio/
│   ├── device.py            # enumeration, sample-rate negotiation
│   ├── source.py            # AudioSource protocol + sounddevice impl
│   ├── sink.py              # AudioSink protocol + sounddevice impl
│   ├── echo.py              # EchoStrategy: GateStrategy | AecStrategy
│   └── buffer.py            # lock-free-ish ring buffer, pre-roll
├── stt/
│   ├── base.py              # Transcriber protocol, Transcript dataclass
│   ├── faster_whisper.py    # CTranslate2 backend (default)
│   ├── whisper_cpp.py       # whisper.cpp backend (shares Dragon Scribe work)
│   ├── vad.py               # Segmenter protocol + silero/webrtc impls
│   └── postprocess.py       # vocabulary correction, disfluency handling
├── tts/
│   ├── base.py              # Synthesizer protocol
│   ├── piper.py             # Piper subprocess/binding backend
│   ├── chunker.py           # text → speakable units
│   └── voices.py            # voice registry, model resolution
├── models/
│   └── registry.py          # download, checksum, cache paths
├── errors.py
└── testing/
    ├── fakes.py             # FakeSource, FakeTranscriber, SilentSink
    └── fixtures/            # golden WAVs + expected transcripts
```

---

## 4. Core contracts

Keep these narrow. Everything below is the whole surface area between layers.

```python
# audio/source.py
class AudioSource(Protocol):
    sample_rate: int          # 16000 for Whisper
    def start(self) -> None: ...
    def read(self, frames: int) -> np.ndarray:   # int16 mono, never blocks >1 buffer
        ...
    def stop(self) -> None: ...

# stt/vad.py
@dataclass
class Segment:
    audio: np.ndarray
    started_at: float
    ended_at: float
    speech_prob: float

class Segmenter(Protocol):
    def feed(self, frame: np.ndarray) -> Segment | None:
        """Return a completed utterance, or None while still accumulating."""

# stt/base.py
@dataclass
class Transcript:
    text: str
    language: str
    confidence: float          # mean logprob, normalised
    words: list[Word] | None   # timestamps when available
    duration_s: float

class Transcriber(Protocol):
    def load(self) -> None: ...                    # called once at warm-up
    def transcribe(self, audio: np.ndarray, *,
                   hint: str | None = None,
                   cancel: CancelToken) -> Transcript: ...

# tts/base.py
class Synthesizer(Protocol):
    sample_rate: int
    def load(self, voice: str) -> None: ...
    def stream(self, text: str, *,
               cancel: CancelToken) -> Iterator[np.ndarray]:
        """Yield PCM chunks as they are produced — do not buffer the whole clip."""
```

`CancelToken` is a single shared object per turn: a threading.Event plus a reason.
Every long operation polls it between chunks. This is what makes barge-in and
Ctrl-C work rather than hang.

---

## 5. Turn state machine

```
        ┌──────► IDLE ◄──────────────────────┐
        │          │ wake / listen()         │
        │          ▼                         │
        │      LISTENING ──(silence timeout)─┤
        │          │ speech ended            │
        │          ▼                         │
        │     TRANSCRIBING ──(empty/low conf)┤
        │          │ transcript              │
        │          ▼                         │
        │       THINKING  (agent's turn)     │
        │          │ response text           │
        │          ▼                         │
        └───────SPEAKING ────────────────────┘
                   │ barge-in detected
                   └──► cancel playback, back to LISTENING
```

Rules worth writing down because they get violated under time pressure:

- Only the TurnManager mutates state. Pipelines report events; they don't decide.
- Entering SPEAKING calls `echo.on_playback_start()`; leaving it always calls
  `on_playback_stop()`, including on exception. Use a context manager.
- TRANSCRIBING with confidence below threshold does **not** silently proceed. It
  emits a `LowConfidence` event so the agent can ask for a repeat rather than act
  on a misheard instruction. For an agent with tool access, acting on a bad
  transcript is worse than asking again.
- A turn holds one CancelToken. Cancelling it must unwind every stage.

---

## 6. Engine choices and why

**STT: `faster-whisper` (CTranslate2) as the default backend.** On CPU it's
roughly 4x the throughput of reference `openai-whisper` at equal accuracy, and
`compute_type="int8"` makes `small.en` comfortably real-time on modest hardware.
Pin the language rather than letting it auto-detect — detection costs a pass and
occasionally guesses Welsh on short utterances, which in Cardiff is not even
implausible.

Keep `whisper_cpp.py` as a parallel implementation behind the same `Transcriber`
protocol. Dragon Scribe already commits to whisper.cpp, and the adapter boundary
is what lets these two projects share a backend rather than diverge into two
half-maintained audio stacks. This is the main reason the interface is worth the
ceremony.

**VAD: Silero over WebRTC.** WebRTC's VAD is fast but fires on keyboard clatter
and workshop noise. Silero (ONNX, ~2MB, runs in well under real-time) is markedly
better on non-speech rejection. Configure with a **pre-roll buffer** of ~300ms —
without it you clip the first phoneme and Whisper turns "start the build" into
"art the build."

**TTS: Piper via subprocess, streaming raw PCM on stdout.** Piper's Python binding
is convenient but the subprocess route gives you a hard kill for barge-in, which
matters more. Synthesize per sentence, not per response: chunk on sentence
boundaries and start playback on the first chunk. That takes time-to-first-audio
from "length of the whole response" down to a few hundred milliseconds.

---

## 7. Latency budget

Target under 1.5s from end-of-speech to first audio out. Rough allocation on a
mid-range CPU:

| Stage | Budget | Notes |
|---|---|---|
| VAD end-of-speech hangover | 300–500ms | tunable; shorter feels snappy but truncates pauses |
| Whisper `small.en` int8, 5s utterance | 400–800ms | scales with utterance length, not real time |
| Post-processing | <20ms | |
| Agent thinking | *unbounded* | play a subtle earcon past ~800ms |
| Piper first sentence | 150–300ms | first chunk only |

The hangover is the parameter users actually feel. Expose it in config and expect
to tune it per person — someone with disfluent or paced speech needs a longer one,
and a fixed 400ms will cut them off mid-thought.

---

## 8. Transcript post-processing

A thin layer, but it's where domain accuracy comes from.

- **Vocabulary injection.** Pass an `initial_prompt` to Whisper containing terms it
  otherwise mangles — project names, motor-trade vocabulary, Welsh place names.
  This biases decoding at near-zero cost. Keep the list in config, not code.
- **Correction map.** A small ordered list of regex→replacement for the errors that
  recur anyway. Log misses so the list can grow from real usage.
- **Disfluency policy is a mode, not a default.** Cleaning "um", restarts, and
  repetitions is right for dictation and wrong for a command interface where "no,
  wait, stop" is the whole message. Make it an explicit flag on the call.
- Never post-process the confidence value. Downstream needs the raw signal.

---

## 9. Failure modes to design for now

| Failure | Handling |
|---|---|
| No capture device / device disappears mid-turn | Emit `AudioUnavailable`, fall back to text I/O, keep the daemon alive |
| ALSA device busy | Retry with backoff, then surface which process holds it — don't just say "failed" |
| Model file missing or checksum mismatch | Fail at warm-up, not on first user utterance |
| Whisper returns empty or pure hallucination on silence | Discard below a duration and confidence floor; Whisper hallucinates confidently on near-silence |
| Piper subprocess dies mid-stream | Kill, drain the sink, report; never leave the sink holding stale PCM |
| Daemon killed with a turn in flight | Socket close → client sees a clean disconnect, not a hang |
| Disk fills with cached audio | Ring-delete recordings past N turns unless explicitly retained |

---

## 10. Testing

The audio stack is the part people leave untested because "it needs a
microphone." It doesn't, if the seams are right.

- `FakeSource` replays a WAV fixture at wall-clock rate. Whole capture pipeline
  becomes deterministic and testable in CI.
- Golden fixtures: a dozen real utterances with expected transcripts. Assert on
  word error rate against a threshold, not exact string match — Whisper output
  shifts between versions and exact-match tests will just get deleted.
- `SilentSink` records PCM to a buffer for playback assertions.
- Cancellation tests matter most: fire the token at each stage boundary and assert
  no thread survives and no device handle leaks. This is where the real bugs are.

---

## 11. Build order

1. `AudioSource` + `AudioSink` + device enumeration. Prove round-trip audio works
   on the actual machine before anything else — sample-rate and PipeWire surprises
   surface here and derail everything if found late.
2. Segmenter with pre-roll, tested against fixtures.
3. `Transcriber` (faster-whisper), warm-up path, `LowConfidence` handling.
4. Daemon + socket protocol. Now the agent can hear.
5. Piper + chunker + streaming playback. Now it can talk.
6. TurnManager, gating strategy, cancellation.
7. Post-processing and vocabulary tuning against real usage.
8. AEC and barge-in, only once 1–7 are solid.

Steps 1–5 are a working system. 6–8 are what make it pleasant.
