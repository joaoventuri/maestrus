"""Helper to patch voice/app.py — adds /tts/stream endpoint with PCM streaming."""
import re, sys, pathlib
p = pathlib.Path('/opt/maestrus/voice/app.py')
src = p.read_text()

# 1) Imports
if 'StreamingResponse' not in src:
    src = src.replace(
        'from fastapi.responses import JSONResponse, Response',
        'from fastapi.responses import JSONResponse, Response, StreamingResponse'
    )
if 'import asyncio' not in src:
    src = src.replace('import os', 'import os\nimport asyncio', 1)

# 2) /tts/stream endpoint — append before WebSocket section
stream_endpoint = '''
@app.post("/tts/stream")
async def tts_stream(text: str = Form(...), lang: str = Form("en")):
    """Stream raw PCM (s16le, 22050Hz, mono) as Piper generates it.
    Client plays chunks via Web Audio API — first sample audible in <200ms."""
    text = (text or "").strip()
    if not text:
        return Response(status_code=400)
    voice = VOICES.get(lang, VOICES["en"])
    proc = await asyncio.create_subprocess_exec(
        PIPER, "--model", voice, "--output-raw",
        stdin=asyncio.subprocess.PIPE,
        stdout=asyncio.subprocess.PIPE,
        stderr=asyncio.subprocess.DEVNULL,
        env=_PIPER_ENV,
    )
    assert proc.stdin and proc.stdout
    proc.stdin.write(text[:2000].encode())
    await proc.stdin.drain()
    proc.stdin.close()

    async def gen():
        try:
            while True:
                chunk = await proc.stdout.read(4096)
                if not chunk:
                    break
                yield chunk
        finally:
            try: proc.kill()
            except ProcessLookupError: pass
            await proc.wait()

    return StreamingResponse(gen(), media_type="audio/pcm; rate=22050; channels=1; format=s16le")

'''
if '/tts/stream' not in src:
    src = src.replace(
        '# ─── WebSocket streaming STT',
        stream_endpoint + '# ─── WebSocket streaming STT'
    )

p.write_text(src)
print('patched')
