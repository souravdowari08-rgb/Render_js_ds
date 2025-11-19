FROM node:20-bullseye

# Skip Puppeteer's chromium download (Render blocks it)
ENV PUPPETEER_SKIP_DOWNLOAD=true

# Install system Chromium + dependencies
RUN apt-get update && apt-get install -y \
    chromium \
    chromium-common \
    chromium-driver \
    libnss3 \
    libatk-bridge2.0-0 \
    libatk1.0-0 \
    libcups2 \
    libxcomposite1 \
    libxrandr2 \
    libxdamage1 \
    libxkbcommon0 \
    libpango-1.0-0 \
    libcairo2 \
    libasound2 \
    libxss1 \
    libxtst6 \
    libglib2.0-0 \
    libgtk-3-0 \
    && rm -rf /var/lib/apt/lists/*

# Puppeteer should use system Chromium
ENV PUPPETEER_EXECUTABLE_PATH="/usr/bin/chromium"

WORKDIR /app

COPY package.json package-lock.json* ./

# Install Node deps
RUN npm install --production

# Copy code
COPY . /app

EXPOSE 10000
ENV PORT=10000

CMD ["node", "server.js"]
