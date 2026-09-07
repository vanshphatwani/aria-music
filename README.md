# Aria 🎵

**A modern, multi-user, self-hosted music ecosystem.**

Aria is a comprehensive, self-hosted music server and Progressive Web App (PWA). It evolved from a personal desire to have a Spotify-like experience on a private Tailscale network, complete with multi-user profiles, synced listening sessions, and algorithmic radio stations.

> **🙏 Acknowledgements**
> Aria is a heavily expanded fork and spiritual successor to **[Spotty](https://github.com/dennisvanhove/Spotty)** by [Dennis van Hove](https://github.com/dennisvanhove). Dennis's original folder-scanning architecture laid the foundation for this project. If you are looking for a lightweight, simple folder-reader, check out the original Spotty!

---

## ✨ Core Features

### 🏠 Managed Media Server
* **Smart Library:** Automatically scans, deduplicates, and organizes audio files into a managed `.store` database.
* **Pathmapping:** Never lose your playlists. Aria remembers where files used to be and automatically updates links.
* **Multi-Format Support:** Handles MP3, M4A, FLAC, OGG, WAV, and WebM.

### 👥 Multi-User Ecosystem
* **Profile Partitioning:** Separate libraries, playlists, play histories, and favorites for different users (plus a "Shared" family library).
* **Listen Together (Synced Sessions):** Real-time synced playback across different devices using Server-Sent Events (SSE). Invite family members to listen to the exact same song at the exact same time.

### 📻 Family Radio & Discovery
* **Algorithmic Radio:** Infinite, auto-generated radio stations powered by the Last.fm API, complete with genre-gating and FFmpeg live-streaming.
* **Mixcloud Integration:** Search and download full DJ sets and mixes.
* **Auto-Mixes:** Dynamically generated "Favorites", "Top", "Fresh", and "Rediscover" mixes based on your listening habits.

### 🎨 Next-Generation UI/UX
* **Ambient UI:** Extracts dominant colors from album art to dynamically theme the "Now Playing" screen.
* **Synced Lyrics:** Fetches and displays time-synced `.lrc` karaoke lyrics with dual-language translation support.
* **True PWA:** Installable on iOS and Android home screens, featuring offline caching via Service Workers and native gesture controls.

---

## 🛠️ Prerequisites

Whether you use Docker or run it locally, Aria relies on three external tools to download music and read metadata. 
1. **[Node.js](https://nodejs.org/)** (v18 or higher recommended)
2. **[yt-dlp](https://github.com/yt-dlp/yt-dlp)** (For downloading audio from YouTube/SoundCloud)
3. **[FFmpeg](https://ffmpeg.org/)** (For reading audio tags and streaming the Radio feature)

---

## 🐳 Option 1: Docker (Recommended)

Aria is designed to be run easily via Docker and Docker Compose.

> ⚠️ **IMPORTANT DOCKER GOTCHA:** 
> Before running the `docker-compose` command, you **must** create an empty `playlists.json` file and a `cache` folder in the root directory. If you don't, Docker will accidentally create them as *folders*, which will crash the app when it tries to save a playlist!

1. Clone this repository and navigate into it.
2. Create the required files:
    ```bash
    touch playlists.json
    mkdir cache
    mkdir music
    ```
3. Start the container:
    ```bash
    docker-compose up -d --build
    ```
4. Access the web interface at `http://localhost:3000`.

---

## 💻 Option 2: Bare Metal / Local Node.js

If you prefer not to use Docker, you can run Aria directly on your machine, NAS, or Raspberry Pi.

1. **Install Prerequisites:** Ensure `node`, `yt-dlp`, and `ffmpeg` (which includes `ffprobe`) are installed and available in your system's `PATH`.
2. **Clone the repository:**
    ```bash
    git clone https://github.com/vanshphatwani/aria-music.git
    cd aria-music
    ```
3. **Setup local directories:**
    ```bash
    mkdir music cache
    echo "[]" > playlists.json
    ```
4. **Run the server:**
    ```bash
    node server.js
    ```
5. Access the web interface at `http://localhost:3000`.

*(Optional: You can set environment variables directly in your terminal before running, e.g., `LASTFM_KEY=your_key PORT=8080 node server.js`)*

---

## ⚙️ Environment Variables

| Variable | Default | Description |
| :--- | :--- | :--- |
| `PORT` | `3000` | The port the web server listens on. |
| `MUSIC_DIR` | `./music` | The directory where your audio files are stored. |
| `LASTFM_KEY` | *(none)* | **Optional:** Your personal Last.fm API key for the Family Radio feature. |
| `YTDLP_PATH` | `yt-dlp` | Path to the yt-dlp binary (if not in system PATH). |
| `FFMPEG_PATH` | `ffmpeg` | Path to the ffmpeg binary (if not in system PATH). |
| `FFPROBE_PATH` | `ffprobe` | Path to the ffprobe binary (if not in system PATH). |

---

## 📜 License

This project inherits the open-source license of the original [Spotty](https://github.com/dennisvanhove/Spotty) project. Please see the `LICENSE` file for details.
