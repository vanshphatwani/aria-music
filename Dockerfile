FROM node:20-slim

# yt-dlp needs Python + ffmpeg; curl is used to install Deno
RUN apt-get update && apt-get install -y --no-install-recommends \
      python3 python3-pip ffmpeg curl unzip \
    && pip3 install --break-system-packages -U "yt-dlp[default]" \
    && curl -fsSL https://deno.land/install.sh | sh \
    && ln -s /root/.deno/bin/deno /usr/local/bin/deno \
    && rm -rf /var/lib/apt/lists/*

WORKDIR /app
COPY . .

EXPOSE 3000
CMD ["node", "server.js"]