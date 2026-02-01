# Voice Endpoints — Moltbot Plugin Spec

Three endpoints for RemoteClaw voice features. Same `Authorization: Bearer {token}` auth as existing endpoints.

---

## `GET /api/voice/capabilities`

Discover what voice features the gateway supports. Called once at startup.

### Response

```json
{
  "stt": {
    "available": true,
    "provider": "openai",
    "model": "whisper-1",
    "maxDurationSeconds": 120,
    "maxFileSizeMB": 25
  },
  "tts": {
    "available": true,
    "provider": "openai",
    "model": "tts-1",
    "voices": ["alloy", "echo", "fable", "onyx", "nova", "shimmer"],
    "defaultVoice": "nova"
  }
}
```

| Field | Type | Required | Description |
|-------|------|----------|-------------|
| `stt.available` | boolean | yes | Whether STT is configured |
| `stt.provider` | string | no | Provider name (e.g. `"openai"`) |
| `stt.model` | string | no | STT model ID |
| `stt.maxDurationSeconds` | number | no | Max recording length |
| `stt.maxFileSizeMB` | number | no | Max upload size |
| `tts.available` | boolean | yes | Whether TTS is configured |
| `tts.provider` | string | no | TTS provider |
| `tts.model` | string | no | TTS model ID |
| `tts.voices` | string[] | no | Available voice options |
| `tts.defaultVoice` | string | no | Default voice |

If no speech provider is configured, return `{ stt: { available: false }, tts: { available: false } }`.

---

## `POST /api/voice/transcribe`

Accept audio from the client, forward to the configured STT provider, return transcribed text.

### Request

`Content-Type: multipart/form-data`

| Field | Type | Required | Description |
|-------|------|----------|-------------|
| `file` | binary | yes | WAV audio file (16kHz, mono, 16-bit) |
| `language` | string | no | Language hint (e.g. `"en"`) |

### Response

```json
{
  "text": "What is the meaning of life?",
  "language": "en",
  "duration": 3.2
}
```

### Errors

| Status | Description |
|--------|-------------|
| 400 | Missing or invalid audio file |
| 413 | Audio file too large |
| 500 | STT provider error |
| 503 | No STT provider configured |

### Implementation

1. Read `file` from multipart form
2. Forward to OpenAI `POST /v1/audio/transcriptions` with `model: "whisper-1"`, `response_format: "json"`
3. Return the text to the client

---

## `POST /api/voice/synthesize`

Accept text, forward to the configured TTS provider, return audio.

### Request

`Content-Type: application/json`

```json
{
  "text": "Quicksort recursively partitions an array...",
  "voice": "nova",
  "speed": 1.0
}
```

| Field | Type | Required | Description |
|-------|------|----------|-------------|
| `text` | string | yes | Text to synthesize (max 4096 chars) |
| `voice` | string | no | Voice ID (defaults to gateway default) |
| `speed` | number | no | Speed 0.25–4.0 (default 1.0) |

### Response

`Content-Type: audio/mpeg`

Binary MP3 audio data. The client writes it to a temp file and plays via `sox play`.

### Errors

| Status | Description |
|--------|-------------|
| 400 | Missing or empty text |
| 413 | Text too long |
| 500 | TTS provider error |
| 503 | No TTS provider configured |

### Implementation

1. Forward to OpenAI `POST /v1/audio/speech` with `model: "tts-1"`, `input: text`, `voice: voice`
2. Stream the binary MP3 response back to the client

---

## Plugin config

Extend the existing `remoteclaw` plugin config in moltbot:

```json
{
  "remoteclaw": {
    "proxyPort": 18793,
    "providers": { ... },
    "voice": {
      "stt": {
        "provider": "openai",
        "model": "whisper-1"
      },
      "tts": {
        "provider": "openai",
        "model": "tts-1",
        "defaultVoice": "nova"
      }
    }
  }
}
```

The plugin reads OpenAI API keys from the existing moltbot provider configuration. No additional keys needed if OpenAI is already configured.

---

## Client behavior

RemoteClaw:
- Calls `GET /api/voice/capabilities` once at startup alongside `/api/providers`
- If `stt.available` or `tts.available` is true, enables voice features (Ctrl+V shortcut, status bar indicator)
- If the endpoint returns 404 or both are unavailable, voice features are hidden
- STT: Records audio locally via `sox rec`, sends WAV to `/api/voice/transcribe`
- TTS: Sends assistant response text to `/api/voice/synthesize`, plays returned MP3 via `sox play`
