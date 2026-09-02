import os
import json, wave, subprocess, os, imageio_ffmpeg
import sys; S=os.environ.get("TOUR_OUT", os.getcwd())
m=json.load(open(f"{S}/marks.json")); total=m["total"]+1.0; rate=None; buf=None
for mk in m["marks"]:
    with wave.open(f"{S}/lines/{mk['name']}.wav") as w:
        r=w.getframerate()
        if rate is None: rate=r; buf=bytearray(int(total*rate)*2)
        data=w.readframes(w.getnframes())
    off=int(mk["at"]*rate)*2; end=min(off+len(data),len(buf)); buf[off:end]=data[:end-off]
with wave.open(f"{S}/narration.wav","wb") as w:
    w.setnchannels(1); w.setsampwidth(2); w.setframerate(rate); w.writeframes(bytes(buf))
ff=imageio_ffmpeg.get_ffmpeg_exe()
subprocess.run([ff,"-y","-loglevel","error","-i",f"{S}/tour2.webm","-i",f"{S}/narration.wav","-c:v","libx264","-preset","medium","-crf","20","-pix_fmt","yuv420p","-c:a","aac","-b:a","128k","-shortest","-movflags","+faststart",f"{S}/cunning-claw-hud-tour.mp4"],check=True)
subprocess.run([ff,"-y","-loglevel","error","-i",f"{S}/tour2.webm","-i",f"{S}/narration.wav","-c:v","copy","-c:a","libopus","-b:a","96k","-shortest",f"{S}/cunning-claw-hud-tour.webm"],check=True)
for f in ["cunning-claw-hud-tour.mp4","cunning-claw-hud-tour.webm"]: print(f, round(os.path.getsize(f"{S}/{f}")/1e6,1),"MB")
pr=subprocess.run([ff,"-i",f"{S}/cunning-claw-hud-tour.mp4"],capture_output=True,text=True).stderr
print([l.strip()[:60] for l in pr.splitlines() if "Duration" in l or "Audio" in l])
