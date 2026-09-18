# D50 Local Music Server

## Start on Windows

1. Install Node.js LTS from https://nodejs.org
2. Extract this folder.
3. Open the extracted `D50-local` folder in File Explorer.
4. Click the address bar, type `cmd`, and press Enter.
5. Run `npm install`
6. Run `npm start`
7. Open http://localhost:5050

Keep the command window open while using D50. Uploaded MP3, WAV, and M4A files are permanently stored in the `music` folder. Song information is stored in `data/songs.json`, and accounts are stored in `data/users.json`.

The app opens directly in Guest mode. Each browser receives five guest song plays, saved locally in that browser. Attempting a sixth play opens the Login/Create Account gate over the blurred dashboard. The first account you create becomes the D50 owner and can delete any uploaded song. Signed-in free accounts retain the five-play Premium limit. The mock card screen is for testing only and never charges real money.

This local version listens only on your PC (`127.0.0.1`) for safety. Do not expose it to the internet yet. Account sessions are stored locally and survive a Node.js server restart. This is a local prototype, not a production payment system.
