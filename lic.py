import importlib.metadata as m
for d in ['fastapi','starlette','pydantic','uvicorn','httpx','ytmusicapi','yt-dlp','onnxruntime','numpy','soundfile','soxr','pytest']:
    md=m.metadata(d); lic=md.get('License-Expression') or (md.get('License') or '').split(chr(10))[0][:40]; cl=[c.split('::')[-1].strip() for c in (md.get_all('Classifier') or []) if c.startswith('License')]
    print(d, m.version(d), '|', lic, '|', cl)
