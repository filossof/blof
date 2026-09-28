# בלוף! – Hebrew Fibbage-style party game

A Hebrew (RTL) bluffing party game that runs entirely on GitHub Pages.

- **Big screen** opens `host.html` – shows a QR code + 4-letter room code.
- **Players** scan the QR (or open `play.html` and type the code) on their phones.
- The host browser *is* the server: phones connect to it directly over WebRTC via [PeerJS](https://peerjs.com) (free public signaling broker). No backend needed.

## Features
- 2–8 players, 3 rounds (x1, x2, and a final x3 "הבלוף האחרון")
- Category picking by the trailing player, "lie for me" suggestions, duplicate-lie merging, rejection of lies that are actually the truth
- Kids-friendly mode: kid-safe question pool, profanity filter, longer timers, brighter theme
- Animated reveal with stamps, confetti, podium, synthesized sound effects, optional Hebrew text-to-speech
- Players can refresh / lose connection and rejoin automatically

## Adding questions
Edit `js/questions.js`. `_____` marks the blank; `alt` lists alternative spellings of the truth; `lies` are house lies; `kids: true` puts it in the kids pool.

## Run locally
```
python3 -m http.server 8000
```
then open http://localhost:8000/host.html
